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
  | { type: 'recovery_applied'; at: string; recoveryId: string; continuation: string };

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
  transcript(entry: Record<string, unknown>): void {
    appendFileSync(join(this.runDir, 'transcript.jsonl'), JSON.stringify(entry) + LF, 'utf8');
  }

  /**
   * The transcript is pseudonymized too.
   *
   * It is the file most likely to contain a member's name in prose, because it is the one place a
   * model writes sentences about what it is looking at.
   */
  transcriptRedacted(entry: Record<string, unknown>): void {
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
  writeScreenshot(data: Buffer, observation?: Observation): string {
    const declaration = this.#declaration;
    this.#sequence += 1;
    const name = String(this.#sequence).padStart(4, '0') + '.png';
    const path = join(this.runDir, 'screenshots', name);

    if (observation === undefined || declaration === undefined) {
      writeFileSync(path, data);
    } else {
      const masked = maskScreenshot({
        png: data,
        observation,
        declaration,
        sourceName: name,
      });
      writeFileSync(path, masked.png);
      // The manifest is what the PHASE 10 verifier reads to check that every declared-sensitive
      // visible target has a mask region. It also records what could NOT be masked, so "nothing
      // was sensitive" and "something was and we could not cover it" never look the same.
      writeFileSync(
        join(this.runDir, 'screenshots', name.replace(/\.png$/, '.mask.json')),
        JSON.stringify(masked.manifest, null, 2),
        'utf8',
      );
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

  writeJson(name: string, value: unknown): string {
    const path = join(this.runDir, name);
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
    const ref = toPosix(relative(process.cwd(), path));
    this.append({ type: 'evidence_captured', at: new Date().toISOString(), kind: 'ax', ref });
    return ref;
  }
}
