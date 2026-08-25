import type { SurfaceAction } from './action.js';
import type { ControlRole, TargetDescriptor } from './control.js';
import type { AssertionKind } from './assertion.js';
import type { Observation } from './perception.js';
import type { ResolutionTrace } from './resolution.js';
import type { RunMetrics } from './run.js';
import type { DiscoverySpec } from './spec.js';
import type { TextMatcher } from './values.js';

/**
 * ==============================================================================================
 * WHAT A DISCOVERY RUN LEAVES BEHIND.
 * ==============================================================================================
 *
 * This type lives in /types, not in /agent, on purpose. The DISTILLER consumes it and the AGENT
 * produces it, so putting it in either package would make the other depend on it - and the one
 * dependency this project must not have is anything in the artifact or replay path reaching the
 * LLM SDK. A shared vocabulary in /types keeps that edge from ever being drawn.
 *
 * Note what is NOT here: no prompts, no model responses, no tool-call payloads. Those are the
 * transcript, which is evidence. This is the RECORD: what was observed, what was done, and what
 * the model proposed about it. The distiller works from facts, not from conversation.
 */

/** An effect the model proposed after a state-changing action. Proposed, never trusted. */
export interface ProposedEffect {
  kind: AssertionKind;
  description: string;
  /** Present when the effect is about a specific control rather than the screen as a whole. */
  target?: TargetDescriptor;
  expected?: TextMatcher;
}

export interface RecordedStep {
  index: number;
  /** The model's stated reason. Becomes the step's `intent`, and its `notes`. */
  intent: string;
  action: SurfaceAction;
  /** The observation the MODEL reasoned over when it chose this. */
  sourceObservationId: string;
  /** The FRESH observation captured inside the input path, immediately before acting. */
  beforeObservationId: string;
  afterObservationId: string;
  trace: ResolutionTrace;
  /**
   * Recorded as a no-op: the action reported success and nothing observable changed.
   *
   * This is the ONLY thing the distiller is allowed to delete from within a retained segment.
   * Anything else it might delete, it cannot prove was redundant.
   */
  noop: boolean;
  changedScreen: boolean;
  changedTargetValue: boolean;
  /**
   * The set of controls on screen is different.
   *
   * Without this a search would be classified a no-op and DELETED. Running a query leaves the
   * screen name unchanged and the button unchanged, and the only thing that moved is the content
   * the query returned. Screen identity and target value between them cannot see that.
   */
  changedInventory: boolean;
  resolvedControlName: string;
  resolvedControlRole: ControlRole;
  /**
   * How the SYSTEM identified the control, as opposed to why the MODEL chose it.
   *
   * `intent` is the model's account and becomes the step's intent. This is the resolver's account -
   * which evidence the descriptor rests on and which tier recorded it - and it becomes the step's
   * `notes`. Two different things, from two different actors, and a reviewer needs both: one says
   * what the step is FOR, the other says whether it will still find the right control next week.
   */
  descriptorRationale: string;
  proposedEffects: ProposedEffect[];
}

/** A LABEL the model proposed for where it thinks it is. Concrete state ids come from the distiller. */
export interface StateProposal {
  observationId: string;
  label: string;
  evidence: string;
}

export interface OutputBinding {
  name: string;
  observationId: string;
  target: TargetDescriptor;
  parseAs: 'text' | 'currency' | 'integer';
  /** What was actually read during the run. Used for the parameterization sweep, never stored. */
  observedValue: string;
}

export interface RecordIdentityBinding {
  param: string;
  observationId: string;
  target: TargetDescriptor;
  observedValue: string;
}

/**
 * A condition the run ENCOUNTERED.
 *
 * [MUST] These go to /runs/<id>/proposed-conditions.json and NOWHERE ELSE. They never enter the
 * executable artifact. An artifact carrying a "proposed but maybe active" condition is an artifact
 * whose behaviour nobody has reviewed, and the whole point of the pinned condition profile is that
 * a human reviewed it.
 */
export interface EncounteredCondition {
  observationId: string;
  screen: string;
  kind: 'known_outcome' | 'recovery' | 'hard_failure' | 'system' | 'needs_human';
  detectorId: string;
  detail: string;
}

export interface DiscoveryRunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  promptVersion: string;
  spec: DiscoverySpec;
  specHash: string;
  /** [MUST] The rendered natural-language goal, recorded explicitly. */
  goal: string;
  target: string;
  runtimeInputs: Readonly<Record<string, string>>;
  observations: Observation[];
  steps: RecordedStep[];
  stateProposals: StateProposal[];
  outputs: OutputBinding[];
  recordIdentity: RecordIdentityBinding | null;
  encounteredConditions: EncounteredCondition[];
  /** Set only after VERIFIED completion. The model proposing success does not set it. */
  successObservationId: string | null;
  metrics: RunMetrics;
}

export function observationById(
  run: Pick<DiscoveryRunRecord, 'observations'>,
  id: string,
): Observation | undefined {
  return run.observations.find((observation) => observation.observationId === id);
}
