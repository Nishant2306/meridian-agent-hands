import type { SurfaceAction } from '../types/action.js';
import type { Observation, ScreenIdentity } from '../types/perception.js';
import type { ResolutionTrace } from '../types/resolution.js';
import type { LeaseToken } from '../types/session.js';
import type {
  ActionResult,
  EvidenceKind,
  HumanSessionHandle,
  Surface,
  SurfaceKind,
  WaitCondition,
} from '../types/surface.js';

/**
 * ==============================================================================================
 * A DELIBERATE, DOCUMENTED STUB. It compiles. It throws. It is not pretending to work.
 * ==============================================================================================
 *
 * This file exists to make one claim checkable rather than rhetorical: that the Surface contract
 * is genuinely surface-independent, and that a desktop adapter is an implementation of the same
 * interface rather than a redesign.
 *
 * It also makes the HONESTY COMMITMENT concrete. A capability recorded against the web fixture
 * does NOT replay unchanged against a desktop application. What transfers is the CONTRACT: the
 * declared inputs and outputs, the semantic descriptors (role, accessible name, nearby text), the
 * assertions and the condition profile. What does NOT transfer is `adapterHints`, because a
 * `name=` attribute has no desktop equivalent, and the addressing recipes, which are per-adapter
 * by construction. A capability moved to this adapter would need its locator hints re-bound
 * against a desktop observation, and nothing else.
 *
 * Everything here is disclosed as stubbed in README.md and REPORT.md (PHASE 10).
 */
export class DesktopSurfaceStub implements Surface {
  readonly id: string;
  readonly kind: SurfaceKind = 'desktop';

  constructor(id = 'desktop-stub') {
    this.id = id;
  }

  /**
   * REAL IMPLEMENTATION: attach to the application top-level window
   * (IUIAutomation::ElementFromHandle), walk it with a TreeWalker over the ControlView, and read
   * ControlType, Name, IsEnabled, LegacyIAccessible.Value and BoundingRectangle from each element.
   * Nearby text is computed the same way as on the web, from geometry: the nearest text element to
   * the LEFT and ABOVE within the same container. Frame path becomes window and pane path.
   */
  observe(): Promise<Observation> {
    return Promise.reject(new Error('DesktopSurfaceStub.observe is not implemented'));
  }

  /**
   * REAL IMPLEMENTATION: identical eight-step sequence. Only steps 4, 6 and 7 change transport:
   * resolve to an IUIAutomationElement, revalidate that it is still connected, visible and enabled,
   * then act through the control pattern (InvokePattern.Invoke, ValuePattern.SetValue,
   * SelectionItemPattern.Select) or, for applications with no usable patterns, synthesise input
   * with SendInput at the element bounding rectangle. The lease check, both policy checks and the
   * revalidation step are surface-independent and are not reimplemented here.
   */
  resolveAndPerform(
    _action: SurfaceAction,
    _token: LeaseToken,
  ): Promise<{ result: ActionResult; trace: ResolutionTrace }> {
    return Promise.reject(new Error('DesktopSurfaceStub.resolveAndPerform is not implemented'));
  }

  /**
   * REAL IMPLEMENTATION: subscribe to UIA automation events (StructureChangedEvent,
   * AutomationPropertyChangedEvent) and fall back to polling the same predicate over the tree.
   * Still predicate-driven; still no fixed sleep.
   */
  waitFor(_condition: WaitCondition, _timeoutMs: number): Promise<boolean> {
    return Promise.reject(new Error('DesktopSurfaceStub.waitFor is not implemented'));
  }

  /**
   * REAL IMPLEMENTATION: window title plus the root element Name for the screen identity, and the
   * executable file version resource in place of the rendered version marker. Context paths become
   * the window and pane hierarchy rather than iframe names.
   */
  screenIdentity(): Promise<ScreenIdentity> {
    return Promise.reject(new Error('DesktopSurfaceStub.screenIdentity is not implemented'));
  }

  /**
   * REAL IMPLEMENTATION: PrintWindow (or BitBlt from the window DC) for the screenshot, and a
   * serialized UIA subtree for the accessibility dump. Declared-box masking works unchanged,
   * because BoundingRectangle and a browser bounding box are the same kind of thing.
   */
  captureEvidence(_kind: EvidenceKind): Promise<string> {
    return Promise.reject(new Error('DesktopSurfaceStub.captureEvidence is not implemented'));
  }

  /**
   * REAL IMPLEMENTATION: the application window is already on a real desktop, so the handle points
   * at that desktop session (the local console, or an RDP session for a hosted runner). This is the
   * case where the honesty commitment bites hardest: the lease governs SOFTWARE-issued input, and
   * a person at the keyboard is out of band on a desktop exactly as they are in a headed browser.
   */
  exposeForHuman(): Promise<HumanSessionHandle> {
    return Promise.reject(new Error('DesktopSurfaceStub.exposeForHuman is not implemented'));
  }

  /** REAL IMPLEMENTATION: release the UIA references and detach; never terminate the application. */
  close(): Promise<void> {
    return Promise.reject(new Error('DesktopSurfaceStub.close is not implemented'));
  }
}
