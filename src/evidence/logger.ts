import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { SurfaceActionType } from '../types/action.js';
import type { ErrorCode } from '../types/outcomes.js';
import type { Observation } from '../types/perception.js';
import type { ResolutionTrace } from '../types/resolution.js';
import type { LeaseOwner, SessionState } from '../types/session.js';

/**
 * Minimal, typed run evidence: one JSONL file plus captured artefacts, under /runs/<runId>/.
 *
 * TWO THINGS ARE DELIBERATELY NOT HERE YET, and both are PHASE 7:
 *   - persistence pseudonymization of PII (member ids, names, amounts) in these events
 *   - declared-box masking of screenshots
 * The hook is `redactForPersistence` below. It is the identity function today and it is called on
 * every event, so PHASE 7 changes one function rather than auditing every call site.
 *
 * What is NOT deferred: secret VALUES never enter an event in the first place. Bindings are
 * described by name (see src/surface/values.ts), so there is no secret in the pipeline for a
 * redactor to have to catch.
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
  | { type: 'evidence_captured'; at: string; kind: string; ref: string };

/** PHASE 7 hook. Identity today, called on every event so there is exactly one place to change. */
export function redactForPersistence(event: EvidenceEvent): EvidenceEvent {
  return event;
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

  constructor(options: { runId: string; rootDir?: string }) {
    this.runId = options.runId;
    this.runDir = join(options.rootDir ?? 'runs', options.runId);
    this.#eventsPath = join(this.runDir, 'events.jsonl');
    mkdirSync(join(this.runDir, 'screenshots'), { recursive: true });
  }

  append(event: EvidenceEvent): void {
    appendFileSync(this.#eventsPath, JSON.stringify(redactForPersistence(event)) + LF, 'utf8');
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

  writeScreenshot(data: Buffer): string {
    this.#sequence += 1;
    const name = String(this.#sequence).padStart(4, '0') + '.png';
    const path = join(this.runDir, 'screenshots', name);
    writeFileSync(path, data);
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
