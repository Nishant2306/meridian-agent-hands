import { z } from 'zod';
import type { SurfaceAction, SurfaceActionType } from './action.js';
import type { TargetDescriptor } from './control.js';
import type { ErrorCode } from './outcomes.js';
import type { Observation, ScreenIdentity } from './perception.js';
import type { Resolution, ResolutionTrace } from './resolution.js';
import type { LeaseToken } from './session.js';

/**
 * ==============================================================================================
 * [MUST] TWO INTERFACES, ONE INPUT PATH.
 * ==============================================================================================
 *
 * There is ONE TargetResolver and ONE input path (`Surface.resolveAndPerform`). A second resolver,
 * a second policy path, or a replay-only locator implementation is a defect. If the design appears
 * to want one, stop and say so.
 */

/**
 * PURE and READ-ONLY. This is NOT a second input choke point, because it sends no input.
 *
 * It is used by discovery (to check a descriptor is resolvable before proposing to act on it) and
 * by replay (assertions and condition detectors, which must inspect controls without touching
 * them). Resolution is passive, so it needs no lease, and requiring one would deadlock the human
 * handoff: the operator console could not poll the screen while a person holds control.
 */
export interface TargetResolver {
  resolve(observation: Observation, descriptor: TargetDescriptor): Resolution;
}

export const SurfaceKindSchema = z.enum(['web', 'legacy_web', 'desktop']);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

/**
 * The outcome of one trip through the input path.
 *
 * Operational outcomes are RETURNED so the discovery loop can feed them back to the model and keep
 * going. Protocol violations (a bad lease, an illegal state transition) THROW, because they mean
 * the caller is broken, not the screen.
 */
export type ActionResult =
  | { status: 'performed'; actionType: SurfaceActionType; readValue?: string }
  | { status: 'blocked'; error: ErrorCode; reason: string }
  | { status: 'failed'; error: ErrorCode; reason: string };

export type WaitCondition =
  | { kind: 'control_present'; descriptor: TargetDescriptor }
  | { kind: 'text_present'; text: string }
  | { kind: 'screen_identity_changed'; from: ScreenIdentity };

/**
 * A handle on the live session, handed to a person. PHASE 8 owns the pause/cede/resume protocol;
 * this type exists here because it is part of the Surface contract.
 */
export interface HumanSessionHandle {
  readonly sessionId: string;
  readonly kind: 'headed_browser' | 'remote_desktop';
  /** Where the human should look. For a headed browser, the window is already on their screen. */
  readonly location: string;
  readonly note: string;
}

export type EvidenceKind = 'screenshot' | 'ax';

export interface Surface {
  readonly id: string;
  readonly kind: SurfaceKind;

  /**
   * Capture the whole screen as a numbered control inventory.
   *
   * Passive. Takes no lease (see TargetResolver above for why that matters).
   *
   * DESKTOP EQUIVALENT: walk the UI Automation tree from the application's root element
   * (IUIAutomation::ElementFromHandle, then TreeWalker over ControlType/Name/BoundingRectangle).
   * The shape of the answer is identical; only the extraction call changes.
   */
  observe(): Promise<Observation>;

  /**
   * [MUST] THE ONLY INPUT PATH. Every software-issued action in the system goes through here.
   *
   * See src/surface/playwright-web/surface.ts for the mandated eight-step sequence and for the
   * honest statement of what atomicity this does and does not buy.
   *
   * DESKTOP EQUIVALENT: resolve to an IUIAutomationElement, then invoke through the control
   * pattern (InvokePattern, ValuePattern, SelectionItemPattern) or synthesise input with SendInput
   * at the element's bounding rectangle. The lease check, the policy checks and the revalidation
   * step are surface-independent and do not change.
   */
  resolveAndPerform(
    action: SurfaceAction,
    token: LeaseToken,
  ): Promise<{ result: ActionResult; trace: ResolutionTrace }>;

  /**
   * Predicate polling until the condition holds or the timeout expires. Never a fixed sleep.
   *
   * DESKTOP EQUIVALENT: poll the same predicate over the UIA tree, or subscribe to UIA automation
   * events (StructureChanged, PropertyChanged) and fall back to polling.
   */
  waitFor(condition: WaitCondition, timeoutMs: number): Promise<boolean>;

  /**
   * Cheap screen identity without a full inventory.
   *
   * DESKTOP EQUIVALENT: window title, the top-level element's Name, and the process/module version
   * resource in place of the rendered version marker.
   */
  screenIdentity(): Promise<ScreenIdentity>;

  /**
   * DESKTOP EQUIVALENT: PrintWindow / BitBlt for the screenshot; a serialized UIA subtree for the
   * accessibility dump.
   */
  captureEvidence(kind: EvidenceKind): Promise<string>;

  /**
   * Hand control of THIS SAME live session to a person. Not a new session, not a copy.
   *
   * DESKTOP EQUIVALENT: the application window is already on a real desktop; the handle points at
   * that desktop session (locally, or over RDP for a hosted runner).
   */
  exposeForHuman(): Promise<HumanSessionHandle>;

  /**
   * Is the driven process gone?
   *
   * OPTIONAL, and the AUTHORITY on whether an error is surface death. Matching Playwright's error
   * strings was the first approach and it missed twice in two phases - a browser can die inside
   * CDP attach, inside a page call, or between them, and each produces different wording. Asking
   * the surface is a fact rather than a guess. A surface that cannot answer says nothing and the
   * message match is used instead.
   */
  isClosed?(): boolean;

  close(): Promise<void>;
}
