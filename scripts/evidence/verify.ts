import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { contentHash } from '../../src/artifact/hash.js';
import { CapabilityArtifactSchema, type CapabilityArtifact } from '../../src/artifact/schema.js';
import {
  conditionProfilePath,
  loadConditionProfile,
  loadSafetyProfile,
  safetyProfilePath,
} from '../../src/artifact/profiles.js';
import { type SessionState } from '../../src/types/session.js';
import { checkSessionChain, leasesAlternate } from './lib/session-chain.js';
import { scanForValues } from './lib/leak-scan.js';
import { readManifest, type Manifest } from './lib/manifest.js';
import { CONFIG_ROOT, EVIDENCE_ROOT, say } from './lib/runtime.js';

/**
 * ================================================================================================
 * `npm run evidence:verify` - THE GATE.
 * ================================================================================================
 *
 * This reads the published bundle under /evidence and re-derives every claim it can. It does not
 * run anything, it does not open a browser, and it needs no API key: a reviewer who will not pay
 * for a discovery run can still check the evidence of one that happened.
 *
 * THREE THINGS IT IS CAREFUL ABOUT.
 *
 * (1) IT DISTINGUISHES WHAT IT PROVED FROM WHAT IT WAS TOLD. Two facts cannot be re-derived from
 *     the bundle - which member each run used, and the fixture's obfuscation seed - because the
 *     persisted files are pseudonymized with a map that is random PER RUN, and because a seed is a
 *     property of a process that has exited. Those checks are marked [manifest]. Everything else
 *     reads the run's own files, and the marking is there so nobody mistakes the two.
 *
 * (2) THE LOCATOR-TIER CHECK IS THE ONE THAT MAKES THE SEED RESTART MEAN ANYTHING. The fixture
 *     regenerates every class name and element id per boot but deliberately keeps its legacy-stable
 *     ASP `name=` attributes. A replay that resolved EVERY control through those attributes would
 *     survive the restart and prove nothing about accessibility-first perception - it would prove
 *     that the fixture has stable attributes. So the tier each key control resolved at is asserted
 *     individually, by classifying the recorded descriptor rather than by hardcoding step ids.
 *
 * (3) LEAK-CLEAN IS SCOPED AND THE SCOPE IS STATED. It means: no value this run was INVOKED with,
 *     and no declared-sensitive value the system had bound by write time, appears verbatim in a
 *     published text file. It does NOT mean no sensitive value appears anywhere. A person's name
 *     written into model prose while the model was reading a screen is a value the system had no
 *     way to label at the moment it was written, and that is reported as a [NOTE] with a count
 *     rather than quietly folded into a pass. See docs/DATA_HANDLING.md, LIMITS.
 */

const MANIFEST = join(EVIDENCE_ROOT, 'manifest.json');
const NL = String.fromCharCode(10);

type Severity = 'MUST' | 'NOTE';

interface Check {
  readonly id: string;
  readonly severity: Severity;
  /** `manifest` when the fact cannot be re-derived from the bundle. See the header. */
  readonly source: 'bundle' | 'manifest';
  readonly claim: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function check(input: Omit<Check, 'severity'> & { severity?: Severity }): void {
  checks.push({ severity: input.severity ?? 'MUST', ...input });
}

function bundleDir(scenario: string, runId: string): string {
  return join(EVIDENCE_ROOT, scenario, runId);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readEvents(dir: string): Record<string, unknown>[] {
  const path = join(dir, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(NL)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every text file in a bundle directory, recursively. Images and their manifests are separate. */
function textFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(json|jsonl|txt|md)$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

interface StepOutcomeFile {
  stepId: string;
  status: string;
  tierUsed: string | null;
  downgraded: boolean;
  attempts: number;
  recoveriesAttempted?: string[];
}

interface ResultFile {
  status: string;
  outcome?: string;
  error?: string;
  expected?: string | null;
  observed?: string | null;
  outputs?: Record<string, unknown>;
  completionMode?: string;
  metrics: {
    llmCalls: number;
    recoveriesUsed: number;
    locatorTierDowngrades: number;
    humanInterventions: number;
  };
}

// ==================================================================================================
// LOCATOR TIER CLASSIFICATION.
// ==================================================================================================
//
// Which control a step drives is read off the RECORDED DESCRIPTOR, never off the step id. Step ids
// are model-authored labels; the descriptor is the contract. A rename would silently disable a
// hardcoded check and leave the suite green.

type ControlKind = 'search_input' | 'table_labelled_field' | 'result_row_control' | 'other';

function classify(step: CapabilityArtifact['steps'][number]): ControlKind {
  const target = 'target' in step.action ? step.action.target : undefined;
  if (target === undefined) return 'other';
  const semantic = target.semantic;

  // A control found by walking to the row whose key cell matches, then to the control inside it.
  // rowKey is a CONSTRAINT ON EVERY TIER rather than a tier of its own, but a descriptor that
  // carries one can only be satisfied structurally.
  if (semantic.rowKey !== undefined) return 'result_row_control';

  // No accessible name of its own; identified by the label in the cell to its left. This is the
  // shape that a legacy table-laid-out form produces, and the reason perception has a T3 at all.
  if (semantic.name === undefined && (semantic.nearbyText?.length ?? 0) > 0) {
    return 'table_labelled_field';
  }

  // An input with a real accessible name, from the fixture's one deliberate `<label for>`.
  if (semantic.role === 'textbox' && semantic.name !== undefined) return 'search_input';

  return 'other';
}

const EXPECTED_TIERS: Record<Exclude<ControlKind, 'other'>, readonly string[]> = {
  search_input: ['T1_EXACT_ROLE_NAME', 'T2_NORMALIZED_IN_CONTAINER'],
  table_labelled_field: ['T3_EXTERNAL_LABEL_OR_NEARBY'],
  result_row_control: ['T5_STRUCTURAL_ROW'],
};

function verifyTiers(artifact: CapabilityArtifact, steps: StepOutcomeFile[]): void {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const seen = new Set<ControlKind>();
  const t4: string[] = [];
  let wrong = 0;
  const lines: string[] = [];

  for (const step of artifact.steps) {
    const kind = classify(step);
    const outcome = byId.get(step.id);
    if (outcome === undefined || outcome.status !== 'performed' || outcome.tierUsed === null) {
      continue;
    }

    if (outcome.tierUsed === 'T4_STABLE_ATTRIBUTE') t4.push(step.id);
    if (kind === 'other') continue;
    seen.add(kind);

    const allowed = EXPECTED_TIERS[kind];
    const ok = allowed.includes(outcome.tierUsed);
    if (!ok) wrong += 1;
    lines.push(
      '      ' +
        (ok ? 'ok   ' : 'WRONG') +
        '  ' +
        step.id.padEnd(28) +
        kind.padEnd(22) +
        outcome.tierUsed +
        (outcome.downgraded ? '  (DOWNGRADED)' : ''),
    );
  }

  const missing = (Object.keys(EXPECTED_TIERS) as Exclude<ControlKind, 'other'>[]).filter(
    (kind) => !seen.has(kind),
  );

  check({
    id: 'tiers',
    source: 'bundle',
    claim: 'each key control resolved at the tier its evidence supports, not at the fixture fallback',
    ok: wrong === 0 && missing.length === 0,
    detail:
      (missing.length > 0 ? 'no step exercised: ' + missing.join(', ') + NL : '') +
      lines.join(NL),
  });

  check({
    id: 'tiers-t4',
    severity: t4.length === 0 ? 'MUST' : 'NOTE',
    source: 'bundle',
    claim: 'T4_STABLE_ATTRIBUTE was not needed, or is reported as a fallback where it was',
    ok: true,
    detail:
      t4.length === 0
        ? '      no control fell back to the legacy `name=` attribute'
        : '      fell back to T4: ' +
          t4.join(', ') +
          NL +
          '      This is not a failure. It is the adapter hint doing its job, and it is reported' +
          NL +
          '      out loud because a run where EVERY control resolved this way would survive the' +
          NL +
          '      seed restart while proving nothing about accessibility-first perception.',
  });
}

// ==================================================================================================
// LEAK SCANNING.
// ==================================================================================================

function scanDirForValues(
  dir: string,
  values: readonly string[],
): { file: string; value: string }[] {
  const hits: { file: string; value: string }[] = [];
  for (const file of textFiles(dir)) {
    for (const value of scanForValues(file, values)) {
      hits.push({ file: file.slice(EVIDENCE_ROOT.length + 1), value });
    }
  }
  return hits;
}

/**
 * Names in the fixture's seed set.
 *
 * A person's name has no shape a detector can find, which is exactly why `sensitivity: pii` is
 * declared by a human beside the field it comes from. These are listed here so the verifier can
 * REPORT on the one file that can still carry one - the model transcript - rather than leave the
 * limit as prose in a document nobody runs.
 */
const SEED_NAMES = ['Avery Lin', 'Jordan Reyes', 'Casey Morgan', 'Riley Chen', 'Dana Whitfield'];

function verifyRedaction(manifest: Manifest): void {
  const scenarios = manifest.scenarios.filter((entry) => entry.runId !== '');

  // ---- (1) invocation values -------------------------------------------------------------------
  const invocationHits: { file: string; value: string }[] = [];
  for (const scenario of scenarios) {
    const dir = bundleDir(scenario.scenario, scenario.runId);
    if (!existsSync(dir)) continue;
    // The member id is the record identity and is declared pii; the nickname and the deposit are
    // declared pii too. `accountType` is declared public and is a contract enum - it belongs in the
    // artifact and in the evidence, and labelling it would be theatre.
    const declared = Object.entries(scenario.params)
      .filter(([name]) => name !== 'accountType')
      .map(([, value]) => value);
    invocationHits.push(...scanDirForValues(dir, declared));
  }

  const discoveryDir = bundleDir('discovery', manifest.discoveryRunId);
  if (existsSync(discoveryDir)) {
    invocationHits.push(...scanDirForValues(discoveryDir, [manifest.discovery.memberId]));
  }

  check({
    id: 'leak-invocation',
    source: 'bundle',
    claim: 'no value a run was invoked with appears verbatim in a published text file',
    ok: invocationHits.length === 0,
    detail:
      invocationHits.length === 0
        ? '      every declared invocation value is labelled'
        : invocationHits
            .slice(0, 12)
            .map((hit) => '      ' + hit.value + '  in  ' + hit.file)
            .join(NL),
  });

  // ---- (2) values the run READ, in files the system writes --------------------------------------
  // ==============================================================================================
  // EVERYTHING IS A FILE THE SYSTEM WROTE, EXCEPT THE ONE THAT HOLDS MODEL PROSE.
  // ==============================================================================================
  //
  // This was a LIST of system files, and anything not on it fell into the lenient bucket. So when
  // the handoff path started writing `observation-*.json` - composed by the system from its own
  // perception, with no model prose in it anywhere - a real leak of a member's NAME was reported as
  // a NOTE about the transcript's known limit. The default was the wrong way round, which is the
  // same shape as the other defects this bundle surfaced: a new writer taking the permissive path
  // because the permissive path was the default.
  //
  // `transcript.jsonl` is the only file containing sentences a model wrote, and the transcript
  // limit is the only thing the NOTE is about.
  const MODEL_PROSE = 'transcript.jsonl';
  const readHits: { file: string; value: string }[] = [];
  const transcriptHits: { file: string; value: string }[] = [];

  for (const scenario of [
    ...scenarios,
    { scenario: 'discovery', runId: manifest.discoveryRunId, params: {} },
  ]) {
    const dir = bundleDir(scenario.scenario, scenario.runId);
    if (!existsSync(dir)) continue;
    for (const file of textFiles(dir)) {
      // `basename`, not a hand-rolled split: the paths come from `join`, so they are separated by
      // a backslash on Windows, and a regex that only knew about `/` would return the whole path -
      // making every file look like it was not the transcript, and turning a documented limit into
      // a hard failure.
      const base = basename(file);
      // The same string walk the invocation scan uses: keys as well as values, and no raw-text
      // substring matching, so a number can never be mistaken for an id.
      for (const name of scanForValues(file, SEED_NAMES)) {
        const hit = { file: file.slice(EVIDENCE_ROOT.length + 1), value: name };
        if (base === MODEL_PROSE) transcriptHits.push(hit);
        else readHits.push(hit);
      }
    }
  }

  check({
    id: 'leak-outputs',
    source: 'bundle',
    claim: 'a declared-sensitive value the run READ is labelled in every file the system writes',
    ok: readHits.length === 0,
    detail:
      readHits.length === 0
        ? '      result.json, steps.json, metrics.json, completion.json and events.jsonl are clean'
        : readHits.map((hit) => '      ' + hit.value + '  in  ' + hit.file).join(NL),
  });

  check({
    id: 'leak-transcript',
    severity: 'NOTE',
    source: 'bundle',
    claim: 'the model transcript carries screen text the system could not label when it was written',
    ok: true,
    detail:
      transcriptHits.length === 0
        ? '      no seeded name appears in the transcript'
        : '      ' +
          String(transcriptHits.length) +
          ' occurrence(s), in ' +
          String(new Set(transcriptHits.map((hit) => hit.file)).size) +
          ' file(s)' +
          NL +
          '      This is a KNOWN LIMIT, not a regression. Pseudonymization replaces values the' +
          NL +
          '      system knows: the ones it was invoked with, and the declared outputs once they' +
          NL +
          '      have been bound. A name the model wrote into prose while reading a screen was' +
          NL +
          '      not either of those at the moment the line was written, and no shape detector' +
          NL +
          '      will ever catch a name. Scrubbing the file afterwards is refused: evidence is' +
          NL +
          '      not rewritten. docs/DATA_HANDLING.md states this under LIMITS.',
  });

  // ---- (3) screenshots --------------------------------------------------------------------------
  let pngs = 0;
  let masked = 0;
  let regions = 0;
  const refused: string[] = [];

  for (const scenario of [
    ...scenarios,
    { scenario: 'discovery', runId: manifest.discoveryRunId },
  ]) {
    const shots = join(bundleDir(scenario.scenario, scenario.runId), 'screenshots');
    if (!existsSync(shots)) continue;
    for (const entry of readdirSync(shots)) {
      if (!entry.endsWith('.png')) continue;
      pngs += 1;
      const manifestPath = join(shots, entry.replace(/\.png$/, '.mask.json'));
      if (!existsSync(manifestPath)) continue;
      masked += 1;
      const parsed = readJson<{
        maskedRegions: unknown[];
        refused: { descriptorRef: string; why: string }[];
      }>(manifestPath);
      regions += parsed.maskedRegions.length;
      for (const entryRefused of parsed.refused) {
        refused.push(scenario.scenario + '/' + entry + ': ' + entryRefused.why);
      }
    }
  }

  check({
    id: 'screenshots-masked',
    source: 'bundle',
    claim: 'every published screenshot went through the masking path',
    ok: pngs > 0 && masked === pngs,
    detail:
      pngs === 0
        ? '      no screenshots in the bundle at all, so nothing is being checked'
        : '      ' + String(masked) + ' of ' + String(pngs) + ' PNGs have a mask manifest beside them',
  });

  check({
    id: 'screenshots-regions',
    source: 'bundle',
    claim: 'declared-sensitive targets on screen actually produced mask regions',
    ok: regions > 0,
    detail:
      '      ' +
      String(regions) +
      ' region(s) masked across the bundle. Zero would mean the declaration never reached the' +
      NL +
      '      masker, which looks identical to "nothing was sensitive" in the image itself.',
  });

  check({
    id: 'screenshots-refused',
    source: 'bundle',
    claim: 'no target that should have been masked was left unmasked',
    ok: refused.length === 0,
    detail:
      refused.length === 0
        ? '      nothing refused. A box that cannot be offset into page space is REFUSED rather' +
          NL +
          '      than drawn in the wrong place, and the refusal would be listed here.'
        : refused.map((line) => '      ' + line).join(NL),
  });
}

// ==================================================================================================
// SESSION AND LEASE ORDERING.
// ==================================================================================================

function verifyLeaseOrder(scenario: string, dir: string): void {
  const events = readEvents(dir);
  const transitions = events
    .filter((event) => event['type'] === 'session_transition')
    .map((event) => ({ from: event['from'] as SessionState, to: event['to'] as SessionState }));
  const owners = events
    .filter((event) => event['type'] === 'lease_issued')
    .map((event) => String(event['owner']));

  // The chain logic lives in lib/session-chain.ts so both directions can be tested without
  // assembling a bundle. See that file for why this is a chain rather than a count.
  const chain = checkSessionChain(transitions);
  const leaseOk =
    leasesAlternate(owners) &&
    (scenario === 'handoff' ? owners.includes('HUMAN') : !owners.includes('HUMAN'));

  check({
    id: 'lease-order-' + scenario,
    source: 'bundle',
    claim:
      scenario === 'handoff'
        ? 'control alternated AUTOMATION -> HUMAN -> AUTOMATION for each intervention, on a legal chain'
        : 'an AUTOMATION lease was issued, no HUMAN lease was, and every session edge was legal',
    ok: chain.problems.length === 0 && leaseOk,
    detail:
      '      interventions: ' +
      String(chain.interventions) +
      NL +
      '      leases: ' +
      (owners.join(' -> ') || '(none)') +
      NL +
      '      states: AUTOMATION_RUNNING' +
      (chain.states.length === 0
        ? '  (no transition: a run that never hands off never leaves the initial state)'
        : ' -> ' + chain.states.join(' -> ')) +
      (chain.problems.length > 0
        ? NL + chain.problems.map((line) => '      ' + line).join(NL)
        : ''),
  });
}

function verifyHandoff(manifest: Manifest): void {
  const runId = manifest.replayRunIds.handoff;
  if (runId === '') {
    check({
      id: 'handoff',
      source: 'bundle',
      claim: 'the handoff scenario has been driven by a person',
      ok: false,
      detail:
        '      not run. `npm run evidence:handoff` needs a person at the keyboard and cannot be' +
        NL +
        '      faked, so the gate is not passed without it.',
    });
    return;
  }

  const dir = bundleDir('handoff', runId);
  const events = readEvents(dir);
  const identities = events.filter((event) => event['type'] === 'handoff_session_identity');
  const comparisons = events.filter((event) => event['type'] === 'handoff_same_session');

  const before = identities.filter((event) => event['phase'] === 'before');
  const after = identities.filter((event) => event['phase'] === 'after');
  const pairs = Math.min(before.length, after.length);

  let sameContext = pairs > 0;
  let sameTarget = pairs > 0;
  for (let index = 0; index < pairs; index += 1) {
    if (before[index]?.['browserContextId'] !== after[index]?.['browserContextId']) {
      sameContext = false;
    }
    if (before[index]?.['targetId'] !== after[index]?.['targetId']) sameTarget = false;
  }

  check({
    id: 'handoff-same-session',
    source: 'bundle',
    claim: 'the person operated the SAME live session, by browser context id and page target id',
    ok:
      pairs > 0 &&
      before.length === after.length &&
      sameContext &&
      sameTarget &&
      comparisons.length === pairs &&
      comparisons.every((event) => event['same'] === true),
    detail:
      '      ' +
      String(pairs) +
      ' intervention(s); context id and page target id recorded before control was ceded and' +
      NL +
      '      again when it came back. A handoff that opened a fresh browser would look identical' +
      NL +
      '      in a screenshot, a log and a demo, which is why this is the check.',
  });

  const result = readJson<ResultFile>(join(dir, 'result.json'));
  check({
    id: 'handoff-system-declares',
    source: 'bundle',
    claim: 'the SYSTEM declared the outcome, and a success is marked human_assisted',
    ok:
      result.status === 'cancelled' ||
      (result.status === 'success' && result.completionMode === 'human_assisted'),
    detail:
      '      status ' +
      result.status +
      (result.completionMode === undefined ? '' : ', completionMode ' + result.completionMode) +
      NL +
      '      An abort is a legitimate outcome here: cancelled, exit 25, a person chose to stop.' +
      NL +
      '      What is impossible is an operator declaring success - `allowedChoices` is typed' +
      NL +
      '      resume | abort, so there is no value that would mean it.',
  });

  verifyLeaseOrder('handoff', dir);
}

// ==================================================================================================
// THE CHAIN.
// ==================================================================================================

function verifyChain(manifest: Manifest): CapabilityArtifact | undefined {
  const stem = manifest.capability.id + '@' + manifest.capability.version;
  const approvedPath = join(EVIDENCE_ROOT, 'artifact', stem + '.json');
  const draftPath = join(EVIDENCE_ROOT, 'artifact', stem + '.draft.json');

  if (!existsSync(approvedPath) || !existsSync(draftPath)) {
    check({
      id: 'artifact-present',
      source: 'bundle',
      claim: 'the bundle contains both the distilled draft and the approved artifact',
      ok: false,
      detail: '      expected ' + approvedPath + ' and ' + draftPath,
    });
    return undefined;
  }

  const approved = CapabilityArtifactSchema.parse(readJson(approvedPath));
  const draft = CapabilityArtifactSchema.parse(readJson(draftPath));

  const discoveryDir = bundleDir('discovery', manifest.discoveryRunId);
  const completion = existsSync(join(discoveryDir, 'completion.json'))
    ? readJson<{
        model: string;
        promptVersion: string;
        completionVerifiedBySystem: boolean;
        successObservationId: string | null;
        metrics: { llmCalls: number; steps: number };
      }>(join(discoveryDir, 'completion.json'))
    : undefined;

  check({
    id: 'discovery-real-model',
    source: 'bundle',
    claim: 'discovery called a real model, more than zero times',
    ok:
      completion !== undefined &&
      completion.metrics.llmCalls > 0 &&
      completion.model.trim() !== '' &&
      !/hand-authored|scripted|fake|stub|none/i.test(completion.model),
    detail:
      completion === undefined
        ? '      no completion.json in the discovery bundle'
        : '      model ' +
          completion.model +
          ', prompt ' +
          completion.promptVersion +
          ', ' +
          String(completion.metrics.llmCalls) +
          ' calls over ' +
          String(completion.metrics.steps) +
          ' steps',
  });

  check({
    id: 'discovery-verified-completion',
    source: 'bundle',
    claim: 'completion was VERIFIED by the system, not merely proposed by the model',
    ok: completion?.completionVerifiedBySystem === true && completion.successObservationId !== null,
    detail:
      '      successObservationId ' +
      String(completion?.successObservationId) +
      NL +
      '      Set only after a FRESH observation with every declared output extracted, validated' +
      NL +
      '      against its declared type, and the record identity checked. A model saying' +
      NL +
      '      goal_reached sets nothing.',
  });

  check({
    id: 'provenance-matches',
    source: 'bundle',
    claim: 'the artifact names the discovery run that produced it',
    ok: approved.provenance.discoveryRunId === manifest.discoveryRunId && existsSync(discoveryDir),
    detail:
      '      provenance.discoveryRunId = ' +
      approved.provenance.discoveryRunId +
      NL +
      '      bundle directory           evidence/discovery/' +
      manifest.discoveryRunId,
  });

  const draftHash = contentHash(draft);
  const approvedHash = contentHash(approved);

  check({
    id: 'content-hash-stable',
    source: 'bundle',
    claim: 'the content hash is IDENTICAL for the distilled draft and the approved artifact',
    ok: draftHash === approvedHash && draftHash === manifest.artifactContentHash,
    detail:
      '      draft     ' +
      draftHash +
      NL +
      '      approved  ' +
      approvedHash +
      NL +
      '      The two FILES differ - approval wrote status, approvedAt and approvedBy - and the' +
      NL +
      '      content hash excludes exactly those three fields and includes the profile pins.',
  });

  check({
    id: 'file-hash-differs',
    source: 'bundle',
    claim: 'the two artifact FILES differ, so the identity above is a property and not a tautology',
    ok: manifest.artifactFileHash !== manifest.artifactDraftFileHash,
    detail:
      '      draft file     ' +
      manifest.artifactDraftFileHash.slice(0, 24) +
      '...' +
      NL +
      '      approved file  ' +
      manifest.artifactFileHash.slice(0, 24) +
      '...',
  });

  const condition = loadConditionProfile(
    conditionProfilePath(
      CONFIG_ROOT,
      approved.profiles.condition.id,
      approved.profiles.condition.version,
    ),
  );
  const safety = loadSafetyProfile(
    safetyProfilePath(CONFIG_ROOT, approved.profiles.safety.id, approved.profiles.safety.version),
  );

  check({
    id: 'profile-pins',
    source: 'bundle',
    claim: 'the profile hashes pinned in the artifact match the profiles on disk',
    ok:
      condition.sha256 === approved.profiles.condition.sha256 &&
      safety.sha256 === approved.profiles.safety.sha256,
    detail:
      '      condition  ' +
      approved.profiles.condition.id +
      '@' +
      approved.profiles.condition.version +
      '  ' +
      (condition.sha256 === approved.profiles.condition.sha256 ? 'matches' : 'MISMATCH') +
      NL +
      '      safety     ' +
      approved.profiles.safety.id +
      '@' +
      approved.profiles.safety.version +
      '  ' +
      (safety.sha256 === approved.profiles.safety.sha256 ? 'matches' : 'MISMATCH') +
      NL +
      '      A mismatch stops a replay with PROFILE_INTEGRITY_FAILURE before the browser opens.',
  });

  check({
    id: 'spec-hash',
    source: 'bundle',
    claim: 'the artifact records the spec hash the manifest names',
    ok: approved.provenance.specHash === manifest.specHash,
    detail: '      ' + approved.provenance.specHash,
  });

  return approved;
}

function verifyReplays(manifest: Manifest, artifact: CapabilityArtifact | undefined): void {
  const byScenario = new Map(manifest.scenarios.map((entry) => [entry.scenario, entry]));

  // ---- every replay made zero model calls -------------------------------------------------------
  const llm: string[] = [];
  for (const scenario of manifest.scenarios) {
    if (scenario.runId === '') continue;
    const path = join(bundleDir(scenario.scenario, scenario.runId), 'result.json');
    if (!existsSync(path)) continue;
    const result = readJson<ResultFile>(path);
    llm.push(scenario.scenario + '=' + String(result.metrics.llmCalls));
  }

  check({
    id: 'no-llm',
    source: 'bundle',
    claim: 'every replay reported llmCalls === 0',
    ok: llm.length > 0 && llm.every((entry) => entry.endsWith('=0')),
    detail:
      '      ' +
      llm.join('  ') +
      NL +
      '      This is the counted proof. The architectural one is that the module graph reachable' +
      NL +
      '      from src/replay/index.ts contains no provider, with a negative control.',
  });

  // ---- the loaded capability, from the run's own events -----------------------------------------
  const loaded = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (scenario.runId === '') continue;
    for (const event of readEvents(bundleDir(scenario.scenario, scenario.runId))) {
      if (event['type'] === 'capability_loaded') loaded.add(String(event['contentHash']));
    }
  }

  check({
    id: 'replay-loaded-that-artifact',
    source: 'bundle',
    claim: 'every replay recorded loading the artifact whose content hash the bundle publishes',
    ok: loaded.size === 1 && loaded.has(manifest.artifactContentHash),
    detail:
      '      ' +
      (loaded.size === 0 ? '(no capability_loaded events)' : [...loaded].join(NL + '      ')),
  });

  // ---- the business outcome ---------------------------------------------------------------------
  const notFound = byScenario.get('notFound');
  if (notFound !== undefined) {
    const result = readJson<ResultFile>(
      join(bundleDir('notFound', notFound.runId), 'result.json'),
    );
    check({
      id: 'business-outcome',
      source: 'bundle',
      claim: 'a member that does not exist is a BUSINESS OUTCOME, not a failure',
      ok:
        result.status === 'business_outcome' &&
        result.outcome === 'MEMBER_NOT_FOUND' &&
        notFound.exitCode === 10,
      detail:
        '      status ' +
        result.status +
        ', outcome ' +
        String(result.outcome) +
        ', exit ' +
        String(notFound.exitCode) +
        NL +
        '      Exit 10 rather than 30 on purpose: "there is no such member" must not page anybody.',
    });
  }

  // ---- the recovery -----------------------------------------------------------------------------
  const recovery = byScenario.get('recovery');
  if (recovery !== undefined) {
    const dir = bundleDir('recovery', recovery.runId);
    const result = readJson<ResultFile>(join(dir, 'result.json'));
    const steps = readJson<StepOutcomeFile[]>(join(dir, 'steps.json'));
    const recovered = steps.filter((step) => (step.recoveriesAttempted ?? []).length > 0);

    check({
      id: 'recovery-once',
      source: 'bundle',
      claim: 'the recovery ran once, and the interrupted action was NOT repeated',
      ok:
        result.metrics.recoveriesUsed === 1 &&
        recovered.length === 1 &&
        recovered[0]?.attempts === 1,
      detail:
        '      recoveriesUsed ' +
        String(result.metrics.recoveriesUsed) +
        ', attempts on the interrupted step ' +
        String(recovered[0]?.attempts) +
        NL +
        '      The notice appears on the page the click NAVIGATED TO. The click worked. Repeating' +
        NL +
        '      it would navigate again from a page whose link is no longer on it, which is why the' +
        NL +
        '      continuation is recheck_expected_effect and not retry_action.',
    });
  }

  // ---- the hard failure -------------------------------------------------------------------------
  const denied = byScenario.get('permissionDenied');
  if (denied !== undefined) {
    const result = readJson<ResultFile>(
      join(bundleDir('permissionDenied', denied.runId), 'result.json'),
    );
    check({
      id: 'hard-failure-diagnosis',
      source: 'bundle',
      claim: 'a hard failure carries EXPECTED beside OBSERVED',
      ok:
        result.status === 'failed' &&
        result.error === 'PERMISSION_DENIED' &&
        typeof result.expected === 'string' &&
        result.expected.length > 0 &&
        typeof result.observed === 'string' &&
        result.observed.length > 0,
      detail:
        '      error     ' +
        String(result.error) +
        NL +
        '      expected  ' +
        String(result.expected) +
        NL +
        '      observed  ' +
        String(result.observed),
    });
  }

  // ---- the application going down ---------------------------------------------------------------
  const unavailable = byScenario.get('unavailable');
  if (unavailable !== undefined) {
    const dir = bundleDir('unavailable', unavailable.runId);
    const result = readJson<ResultFile>(join(dir, 'result.json'));
    const steps = readJson<StepOutcomeFile[]>(join(dir, 'steps.json'));
    check({
      id: 'unavailable',
      source: 'bundle',
      claim: 'an application that goes down mid-run is detected from the screen and stops the run',
      ok: result.status === 'failed' && steps.some((step) => step.status === 'performed'),
      detail:
        '      error ' +
        String(result.error) +
        ', ' +
        String(steps.filter((step) => step.status === 'performed').length) +
        ' step(s) completed before it' +
        NL +
        '      Detected by reading the page the application rendered, not by the 5xx status: these' +
        NL +
        '      systems answer with a readable error page and a 200 at least as often as not.',
    });
  }

  // ---- the tiers, on the success run ------------------------------------------------------------
  const success = byScenario.get('success');
  if (success !== undefined && artifact !== undefined) {
    const dir = bundleDir('success', success.runId);
    verifyTiers(artifact, readJson<StepOutcomeFile[]>(join(dir, 'steps.json')));
    verifyLeaseOrder('success', dir);

    const result = readJson<ResultFile>(join(dir, 'result.json'));
    check({
      id: 'success-outputs',
      source: 'bundle',
      claim: 'the success run returned every declared output',
      ok: artifact.outputs.every((output) => (result.outputs ?? {})[output.name] !== undefined),
      detail:
        '      declared: ' +
        artifact.outputs.map((output) => output.name).join(', ') +
        NL +
        '      The VALUES here are labelled, because this is a persisted file. The caller got the' +
        NL +
        '      real ones on stdout; that is mechanism 3 and it is deliberately not redacted.',
    });
  }

  // ---- the two facts only the manifest holds ----------------------------------------------------
  check({
    id: 'different-member',
    source: 'manifest',
    claim: 'the replay ran on a member the discovery run never saw',
    ok: success !== undefined && success.params['memberId'] !== manifest.discovery.memberId,
    detail:
      '      discovery ' +
      manifest.discovery.memberId +
      ', replay ' +
      String(success?.params['memberId']) +
      NL +
      '      [manifest] because the persisted files are pseudonymized with a map that is random' +
      NL +
      '      PER RUN, so two runs label the same member differently on purpose. That is the' +
      NL +
      '      pseudonymizer working, and cross-run correlation is exactly what it costs.',
  });

  check({
    id: 'different-seed',
    source: 'manifest',
    claim: 'the fixture was restarted between discovery and replay, with a different seed',
    ok: manifest.fixtureSeeds.discovery !== manifest.fixtureSeeds.replay,
    detail:
      '      discovery seed ' +
      String(manifest.fixtureSeeds.discovery) +
      ', replay seed ' +
      String(manifest.fixtureSeeds.replay) +
      NL +
      '      [manifest] because a seed is a property of a process that has since exited. What the' +
      NL +
      '      restart is worth is decided by the tier check above, not by this line.',
  });
}

// ==================================================================================================

function main(): void {
  if (!existsSync(MANIFEST)) {
    say();
    say('There is no /evidence/manifest.json.');
    say();
    say('  npm run evidence:automated     one real discovery and five replays (needs an API key)');
    say('  npm run evidence:handoff       the scenario that needs a person');
    say('  npm run evidence:verify        this command');
    say();
    process.exit(2);
  }

  const manifest = readManifest(MANIFEST);
  const artifact = verifyChain(manifest);
  verifyReplays(manifest, artifact);
  verifyHandoff(manifest);
  verifyRedaction(manifest);

  say();
  say('EVIDENCE VERIFICATION');
  say('  bundle:     ' + EVIDENCE_ROOT);
  say('  generated:  ' + manifest.generatedAt);
  say('  capability: ' + manifest.capability.id + '@' + manifest.capability.version);
  say();

  let failed = 0;
  for (const entry of checks) {
    const failing = entry.severity === 'MUST' && !entry.ok;
    if (failing) failed += 1;
    const badge = entry.severity === 'NOTE' ? 'NOTE' : entry.ok ? 'PASS' : 'FAIL';
    say(
      '  ' +
        badge +
        '  ' +
        (entry.source === 'manifest' ? '[manifest] ' : '') +
        entry.claim,
    );
    if (entry.detail.trim() !== '') say(entry.detail);
    say();
  }

  const musts = checks.filter((entry) => entry.severity === 'MUST').length;
  say('  ' + String(musts - failed) + ' of ' + String(musts) + ' required checks passed.');
  say();

  if (failed > 0) {
    say('  The bundle does not support what it claims. Nothing here should be quoted until the');
    say('  failures above are either fixed or written down as limits.');
    say();
    process.exit(1);
  }
}

main();
