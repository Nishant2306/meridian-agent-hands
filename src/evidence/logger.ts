import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SurfaceActionType } from '../types/action.js';
import type { ErrorCode } from '../types/outcomes.js';
import type { Observation } from '../types/perception.js';
import type { ResolutionTrace } from '../types/resolution.js';
import type { LeaseOwner, SessionState } from '../types/session.js';
import type { Pseudonymizer } from '../redaction/pseudonymize.js';
import { maskScreenshot, type SensitivityDeclaration } from '../redaction/masking.js';

/**
 * Minimal, typed run evidence: one JSONL file plus captured artefacts, under /runs/<runId>/.
 *
 * PHASE 7 FILLED IN BOTH DEFERRED PIECES, at the single seam that was left for them:
 *   - persistence pseudonymization runs on EVERY event, through `redactForPersistence`
 *   - screenshots are masked before they are written, in `screenshot()` below
 *
 * The seam is why this was one change rather than an audit of every call site.
 *
 * What was never deferred: secret VALUES do not enter an event in the first place. Bindings are
 * described by name (see src/surface/values.ts), so there is no secret in the pipeline for a
 * redactor to have to catch. Pseudonymization is a net under that, not the mechanism.
 */
/**
 * JSONL is delimited with LF on every host, so an evidence file produced on Windows and one
 * produced on Linux are byte-identical and diff cleanly. Built from a char code rather than an
 * escape so that no tool in the chain can quietly rewrite it.
 */
const LF = String.fromCharCode(10);

export type EvidenceEvent =
  | { type: 'run_started'; at: string; runId: string; surfaceId: string; allowedOrigin: string }
  /**
   * Which capability this run executed, and the content hash it had when it was loaded.
   *
   * PHASE 10 needs the evidence bundle to stand on its own: "the artifact replay loaded is the one
   * distillation produced" is checkable only if the run says which artifact it loaded. Without this
   * the claim rests on the orchestrator's word, and an orchestrator is the last thing that should
   * be the sole witness to its own output.
   */
  | {
      type: 'capability_loaded';
      at: string;
      capabilityId: string;
      capabilityVersion: string;
      status: string;
      contentHash: string;
    }
  | { type: 'lease_issued'; at: string; leaseId: string; owner: LeaseOwner; expiresAt: number }
  | { type: 'lease_violation'; at: string; reason: string }
  | { type: 'session_transition'; at: string; from: SessionState; to: SessionState; reason: string }
  | {
      type: 'observation';
      at: string;
      observationId: string;
      screen: string;
      perceptionPath: string;
      controls: number;
      perceived: number;
    }
  | {
      type: 'action_attempt';
      at: string;
      actionType: SurfaceActionType;
      target?: string;
      valueBinding?: string;
    }
  | { type: 'action_blocked'; at: string; actionType: SurfaceActionType; error: ErrorCode; reason: string }
  | { type: 'action_failed'; at: string; actionType: SurfaceActionType; error: ErrorCode; reason: string }
  | {
      type: 'action_performed';
      at: string;
      actionType: SurfaceActionType;
      tierUsed: string | null;
      downgraded: boolean;
      conflicts: number;
    }
  | { type: 'wait'; at: string; condition: string; satisfied: boolean; ms: number }
  | { type: 'bounded_backoff'; at: string; ms: number; reason: string }
  | { type: 'evidence_captured'; at: string; kind: string; ref: string }
  /**
   * A recovery from the pinned condition profile was applied. PHASE 10 quotes recoveriesUsed as
   * evidence, and a count with no record of WHICH recovery and what was supposed to happen next is
   * a number nobody can check.
   */
  | { type: 'recovery_applied'; at: string; recoveryId: string; continuation: string }
  /**
   * The identity of the live session, recorded before control is ceded to a person and again when
   * it comes back. PHASE 10 asserts the pair matches: it is the ONLY hard evidence that the human
   * operated the SAME session rather than a fresh one, and every other part of the handoff story is
   * a claim.
   */
  | {
      type: 'handoff_session_identity';
      at: string;
      phase: 'before' | 'after';
      interventionId: string;
      browserContextId: string;
      targetId: string;
      url: string;
    }
  /** The comparison itself, so the claim is one line rather than a correlation of two. */
  | {
      type: 'handoff_same_session';
      at: string;
      interventionId: string;
      same: boolean;
      beforeTargetId: string;
      afterTargetId: string;
    }
  /**
   * Something a PERSON did while holding the lease. Never a raw typed value: `valueChanged` says a
   * value changed and `redactedValueToken` is a correlation token, not a record of what was typed.
   */
  | {
      type: 'human_action';
      at: string;
      kind: string;
      role: string;
      name: string;
      valueChanged?: boolean;
      redactedValueToken?: string;
    };

/**
 * The ONE place persistence pseudonymization happens. Called on every event.
 *
 * A writer with no pseudonymizer passes events through unchanged, which is what the browser-free
 * unit tests want: they assert the SHAPE of an event, and a test that had to know the current
 * labelling scheme would break every time the scheme was tuned.
 */
export function redactForPersistence(
  event: EvidenceEvent,
  pseudonymizer?: Pseudonymizer,
  declared?: ReadonlyMap<string, string>,
): EvidenceEvent {
  if (pseudonymizer === undefined) return event;
  return pseudonymizer.value(event, declared ?? new Map()) as EvidenceEvent;
}

/** Evidence refs are recorded with forward slashes so a run reads the same on any host. */
function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export class EvidenceWriter {
  readonly runId: string;
  readonly runDir: string;
  readonly #eventsPath: string;
  #sequence = 0;

  readonly #pseudonymizer: Pseudonymizer | undefined;
  #declared: ReadonlyMap<string, string> = new Map();
  #declaration: SensitivityDeclaration | undefined;

  constructor(options: {
    runId: string;
    rootDir?: string;
    /** Absent means events are written verbatim. The CLIs always supply one. */
    pseudonymizer?: Pseudonymizer;
  }) {
    this.runId = options.runId;
    this.runDir = join(options.rootDir ?? 'runs', options.runId);
    this.#eventsPath = join(this.runDir, 'events.jsonl');
    this.#pseudonymizer = options.pseudonymizer;
    mkdirSync(join(this.runDir, 'screenshots'), { recursive: true });
  }

  /**
   * What this run treats as sensitive: the values it was invoked with, which of their names are
   * declared pii or secret, and which one identifies the record.
   *
   * ONE call sets both mechanisms - the pseudonym labels used in text, and the boxes masked in
   * screenshots - so the two can never disagree about what is sensitive. Set once by the CLI
   * before the run starts.
   */
  declareSensitive(declaration: SensitivityDeclaration): void {
    this.#declared = declaration.values;
    this.#declaration = declaration;
  }

  get pseudonymizer(): Pseudonymizer | undefined {
    return this.#pseudonymizer;
  }

  /**
   * ============================================================================================
   * A DECLARED-SENSITIVE VALUE THE RUN HAS JUST SEEN, BEFORE ANYTHING IS WRITTEN DOWN.
   * ============================================================================================
   *
   * `declareSensitive` is called once, before the run, from the invocation parameters. That names
   * every sensitive OUTPUT but cannot carry a value for one, because an output has no value until
   * the run reads it.
   *
   * For a run that finishes, completing the declaration at the end is enough. For one that STOPS -
   * a handoff - it is not: the escalation persists an observation of the screen the run stopped on,
   * and that screen can display a declared-sensitive output the run had not reached yet. A real
   * bundle carried a member's NAME into `observation-*.json` that way. It was not a walker gap and
   * it was not the transcript's "the system never knew this value" case: the system knew the field
   * was `sensitivity: pii`, knew from the artifact exactly which control displays it, and simply had
   * not looked yet.
   *
   * So the caller resolves those descriptors against the observation it is about to persist and
   * tells the writer what it found, FIRST. Only names already declared sensitive are accepted; this
   * cannot be used to invent a new secret at runtime.
   */
  learnSensitiveValue(name: string, value: string): void {
    const declaration = this.#declaration;
    if (declaration === undefined || value === '') return;
    if (!declaration.sensitiveNames.has(name)) return;
    if (this.#declared.get(name) === value) return;

    const values = new Map(declaration.values);
    values.set(name, value);
    this.declareSensitive({ ...declaration, values });
  }

  /**
   * ============================================================================================
   * THE SAME SEAM, FOR THE TWO CHANNELS THAT WERE WRITING AROUND IT.
   * ============================================================================================
   *
   * `append`, `transcriptRedacted` and `writeScreenshot` all went through the pseudonymizer. Two
   * things did not, and both were claimed to:
   *
   *   - the human-readable CLI output on stderr, which `formatResultForHuman` fills with the
   *     outputs the run read
   *   - `result.json` / `steps.json` / `metrics.json`, which the CLIs wrote with a bare
   *     `writeFileSync`
   *
   * The header of `src/redaction/pseudonymize.ts`, `docs/DATA_HANDLING.md` and the comment on the
   * test that was supposed to cover it all said the human channel was pseudonymized. It was not.
   * These two methods exist so that fixing it did not mean a SECOND redaction path: everything
   * still goes through one pseudonymizer holding one declared map.
   */
  redactText(line: string): string {
    return this.#pseudonymizer === undefined ? line : this.#pseudonymizer.text(line, this.#declared);
  }

  /**
   * ============================================================================================
   * [MUST] THE ONLY PLACE ANYTHING IN THIS CLASS WRITES A FILE INTO A RUN DIRECTORY.
   * ============================================================================================
   *
   * Everything public funnels through here and everything here is pseudonymized. That shape is the
   * fix for a defect that happened THREE TIMES in two phases, each time the same way: somebody adds
   * a writer, picks the shortest available method, and the shortest available method was the unsafe
   * one.
   *
   *   the CLIs wrote result.json with a bare writeFileSync                    (D73)
   *   the mask manifest was written with a bare writeFileSync                 (D86)
   *   captureEvidence('ax') used writeJson, which did not redact              (D88)
   *
   * There used to be two of each writer - `writeJson` beside `writeRedactedJson`, `transcript`
   * beside `transcriptRedacted` - so redaction was a variant you had to remember to choose, with
   * the unsafe one holding the more obvious name. Choosing correctly every time is not a property
   * anybody can hold; there is now nothing to choose. See DECISIONS.md D88.
   */
  #write(name: string, value: unknown): string {
    const written =
      this.#pseudonymizer === undefined ? value : this.#pseudonymizer.value(value, this.#declared);
    const path = join(this.runDir, name);
    writeFileSync(path, JSON.stringify(written, null, 2), 'utf8');
    return toPosix(relative(process.cwd(), path));
  }

  /** A run-output file. Pseudonymized, because every file this class writes is. */
  writeJson(name: string, value: unknown): string {
    return this.#write(name, value);
  }

  append(event: EvidenceEvent): void {
    const written = redactForPersistence(event, this.#pseudonymizer, this.#declared);
    appendFileSync(this.#eventsPath, JSON.stringify(written) + LF, 'utf8');
  }

  observed(observation: Observation): void {
    this.append({
      type: 'observation',
      at: observation.capturedAt,
      observationId: observation.observationId,
      screen: observation.screenIdentity.canonicalScreenName,
      perceptionPath: observation.perceptionPath,
      controls: observation.controls.length,
      perceived: observation.truncation.perceived,
    });
  }

  performed(actionType: SurfaceActionType, trace: ResolutionTrace): void {
    this.append({
      type: 'action_performed',
      at: new Date().toISOString(),
      actionType,
      tierUsed: trace.tierUsed,
      downgraded: trace.downgraded,
      conflicts: trace.conflicts.length,
    });
  }

  /**
   * The conversation, kept separately from the typed event stream.
   *
   * Two files because they answer different questions. `events.jsonl` is what the SYSTEM did:
   * every action, every block, every wait. `transcript.jsonl` is what was SAID: what the model was
   * shown and what it asked for. A reviewer auditing a decision needs the second; a reviewer
   * auditing a guardrail needs the first, and mixing them buries each in the other.
   */
  /**
   * The conversation. Pseudonymized, like everything else written here.
   *
   * It is the file most likely to contain a member's name in prose, because it is the one place a
   * model writes sentences about what it is looking at. There was an unredacted `transcript()`
   * beside this one until D88; nothing called it, and it was one autocomplete away from being used.
   */
  transcript(entry: Record<string, unknown>): void {
    const written =
      this.#pseudonymizer === undefined
        ? entry
        : (this.#pseudonymizer.value(entry, this.#declared) as Record<string, unknown>);
    appendFileSync(join(this.runDir, 'transcript.jsonl'), JSON.stringify(written) + LF, 'utf8');
  }

  /**
   * ============================================================================================
   * [MUST] ONLY THE MASKED IMAGE IS EVER WRITTEN.
   * ============================================================================================
   *
   * The unmasked bytes are passed in, masked in memory, and dropped. They never get a filename,
   * because a file that exists is a file that gets copied - into a bug report, a chat, a ticket.
   *
   * A caller with no observation and no declaration gets the raw image, which is the honest
   * behaviour for the browser-free tests that exercise the writer's SHAPE. Every path that runs
   * against a live screen supplies both.
   */
  writeScreenshot(data: Buffer, observation: Observation): string {
    // ============================================================================================
    // THERE IS NO BRANCH THAT WRITES THE RAW BYTES. THAT IS THE POINT OF D56.
    // ============================================================================================
    //
    // There used to be one, for a caller with no observation or no declaration - "the honest
    // behaviour for the browser-free tests". No production caller ever took it, and it was the
    // fourth instance of the shape this class has now been restructured to make impossible: a
    // convenient path that skips the protection. Found by `contract/evidence.seam.lint`, which
    // counts the file-writing call sites in this file, on the run it was written.
    //
    // `observation` is REQUIRED, so the coordinates always describe the image. An absent DECLARATION
    // masks nothing rather than bypassing the masker, and the manifest beside the image says so -
    // "nothing was declared sensitive" and "the masker never ran" must not look the same.
    const declaration = this.#declaration ?? {
      sensitiveNames: new Set<string>(),
      values: new Map<string, string>(),
      recordIdentityParam: '',
    };
    this.#sequence += 1;
    const name = String(this.#sequence).padStart(4, '0') + '.png';
    const path = join(this.runDir, 'screenshots', name);

    {
      const masked = maskScreenshot({
        png: data,
        observation,
        declaration,
        sourceName: name,
      });
      writeFileSync(path, masked.png);
      // The manifest is what the verifier reads to check that every declared-sensitive visible
      // target has a mask region. It also records what could NOT be masked, so "nothing was
      // sensitive" and "something was and we could not cover it" never look the same.
      //
      // [MUST] IT GOES THROUGH THE PSEUDONYMIZER. `descriptorRef` describes the control that was
      // covered, and the most natural way to describe a control showing a member id is to quote the
      // member id - so the file that records the masking was leaking the value the mask exists to
      // hide. Caught by `evidence:verify` on the first successful evidence bundle. Same class of
      // defect as D73: a persisted file written around the one seam.
      this.#write(join('screenshots', name.replace(/\.png$/, '.mask.json')), masked.manifest);
    }

    const ref = toPosix(relative(process.cwd(), path));
    this.append({
      type: 'evidence_captured',
      at: new Date().toISOString(),
      kind: 'screenshot',
      ref,
    });
    return ref;
  }

  /**
   * A captured accessibility dump.
   *
   * It USED to be written verbatim, on the reasoning that a reviewer wants it byte-exact. That cost
   * a real leak: the handoff path captures observations that the unattended path never does, so two
   * `observation-*.json` files carrying a member id reached a published bundle and nothing had ever
   * looked at them. Byte-exactness of a debugging aid does not outrank a value in a published file.
   */
  writeObservation(name: string, value: unknown): string {
    const ref = this.#write(name, value);
    this.append({ type: 'evidence_captured', at: new Date().toISOString(), kind: 'ax', ref });
    return ref;
  }
}
