import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import type { SurfaceAction } from '../../types/action.js';
import type { Observation, ScreenIdentity } from '../../types/perception.js';
import type { ResolutionTrace } from '../../types/resolution.js';
import type { LeaseToken } from '../../types/session.js';
import type {
  ActionResult,
  EvidenceKind,
  HumanSessionHandle,
  Surface,
  SurfaceKind,
  TargetResolver,
  WaitCondition,
} from '../../types/surface.js';
import type { TextMatcher } from '../../types/values.js';
import type { AdapterAddressing } from '../../perception/addressing.js';
import { bindDescriptor } from '../../perception/bind.js';
import { buildObservation } from '../../perception/observe.js';
import { buildScreenIdentity } from '../../perception/screen-identity.js';
import { DefaultTargetResolver } from '../../perception/resolver.js';
import type { EvidenceWriter } from '../../evidence/logger.js';
import type { LeaseManager } from '../../session/lease.js';
import type { SessionStateMachine } from '../../session/state.js';
import {
  bootstrapResolvedCheck,
  bootstrapStaticCheck,
  navigationTarget,
  resolvedPolicyHook,
  staticPolicyHook,
} from '../bootstrap-policy.js';
import { describeBinding, ValueResolver, type ValueSources } from '../values.js';
import { captureRaw, frameContextPath } from './extract.js';
import { findFrame, locate, revalidate } from './locate.js';

export interface PlaywrightWebSurfaceOptions {
  readonly id?: string;
  readonly page: Page;
  readonly context: BrowserContext;
  /** The ONE origin the bootstrap safety minimum permits. Everything else is an allowlist violation. */
  readonly allowedOrigin: string;
  readonly lease: LeaseManager;
  readonly session: SessionStateMachine;
  readonly resolver?: TargetResolver;
  readonly evidence?: EvidenceWriter;
  readonly values?: ValueSources;
  readonly actionTimeoutMs?: number;
}

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

function emptyTrace(observationId: string): ResolutionTrace {
  return {
    observationId,
    tiersAttempted: [],
    tierUsed: null,
    conflicts: [],
    downgraded: false,
  };
}

function describeAction(action: SurfaceAction): string {
  if (action.type === 'navigate') return 'navigate';
  const semantic = action.target.semantic;
  return semantic.role + ' "' + (semantic.name ?? '(unnamed)') + '"';
}

/**
 * ==============================================================================================
 * [MUST] THE ONLY INPUT PATH.
 * ==============================================================================================
 *
 * `resolveAndPerform` runs eight steps, in this order, every time, with no external policy hook
 * that a caller could forget to call:
 *
 *   1  validate the lease token: current lease, correct owner, unexpired, and a session state that
 *      admits actions from that owner
 *   2  BOOTSTRAP SAFETY POLICY (clarification 5): hardcoded minimum, active from PHASE 2 onward
 *   3  STATIC policy precheck: origin, route, action type (PHASE 7 engine plugs in here)
 *   4  resolve the target through the ONE TargetResolver
 *   5  RESOLVED-CONTROL policy: control name, effective risk, screen context. This cannot happen
 *      earlier: no policy can classify "click Delete Member" before it knows what resolved.
 *   6  REVALIDATE that the selected candidate is still unique and still actionable
 *   7  perform
 *   8  return the result together with the ResolutionTrace
 *
 * [MUST] WHAT THIS DOES AND DOES NOT BUY. Keeping resolution, revalidation and the input event
 * inside ONE adapter operation MINIMIZES the resolve/act race and keeps ownership of the chosen
 * candidate in one place. It does NOT eliminate the race. Any UI may mutate between step 6 and
 * step 7, and no browser API closes that gap. Do not overclaim this in REPORT.md: the honest
 * statement is that a control which has already drifted fails the action instead of being clicked.
 */
export class PlaywrightWebSurface implements Surface {
  readonly id: string;
  readonly kind: SurfaceKind = 'legacy_web';

  readonly #page: Page;
  readonly #context: BrowserContext;
  readonly #allowedOrigin: string;
  readonly #lease: LeaseManager;
  readonly #session: SessionStateMachine;
  readonly #resolver: TargetResolver;
  readonly #evidence: EvidenceWriter | undefined;
  readonly #values: ValueResolver;
  readonly #params: Readonly<Record<string, string>>;
  readonly #timeout: number;

  #addressing: Map<number, AdapterAddressing> = new Map();
  #lastObservation: Observation | null = null;

  constructor(options: PlaywrightWebSurfaceOptions) {
    this.id = options.id ?? 'playwright-web';
    this.#page = options.page;
    this.#context = options.context;
    this.#allowedOrigin = options.allowedOrigin;
    this.#lease = options.lease;
    this.#session = options.session;
    this.#resolver = options.resolver ?? new DefaultTargetResolver();
    this.#evidence = options.evidence;
    this.#values = new ValueResolver(options.values);
    this.#params = options.values?.params ?? {};
    this.#timeout = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  get lastObservation(): Observation | null {
    return this.#lastObservation;
  }

  async observe(): Promise<Observation> {
    const capture = await captureRaw(this.#page, this.#context, this.id);
    const { observation, addressing } = buildObservation(capture);

    this.#addressing = addressing;
    this.#lastObservation = observation;
    this.#evidence?.observed(observation);

    return observation;
  }

  async screenIdentity(): Promise<ScreenIdentity> {
    const frames = [];
    for (const frame of this.#page.frames()) {
      if (frame.url() === 'about:blank' && frame.parentFrame() !== null) continue;
      const summary = (await frame.evaluate(
        '(() => ({ headings: Array.prototype.slice.call(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((n) => (n.textContent || "").trim()).filter((t) => t !== ""), bodyText: document.body ? (document.body.innerText || "").slice(0, 4000) : "" }))()',
      )) as { headings: string[]; bodyText: string };

      frames.push({
        contextPath: await frameContextPath(frame),
        title: await frame.title(),
        url: frame.url(),
        headings: summary.headings,
        bodyText: summary.bodyText,
        controls: [],
      });
    }
    return buildScreenIdentity(frames);
  }

  /** Resolve parameterized path segments before the origin check sees them. */
  #materialize(action: SurfaceAction): SurfaceAction {
    if (action.type !== 'navigate') return action;
    const pathSegments: TextMatcher[] = action.pathSegments.map((segment) => ({
      kind: 'literal',
      value: this.#values.resolve(segment),
    }));
    return { type: 'navigate', pathSegments };
  }

  async resolveAndPerform(
    action: SurfaceAction,
    token: LeaseToken,
  ): Promise<{ result: ActionResult; trace: ResolutionTrace }> {
    // ---- 1. lease -----------------------------------------------------------------------------
    // Throws. A caller acting without the right to act is a protocol violation, not a screen event.
    try {
      this.#lease.assertMayAct(token, this.#session);
    } catch (error) {
      this.#evidence?.append({
        type: 'lease_violation',
        at: new Date().toISOString(),
        reason: error instanceof Error ? error.message : 'lease rejected',
      });
      throw error;
    }

    const materialized = this.#materialize(action);

    this.#evidence?.append({
      type: 'action_attempt',
      at: new Date().toISOString(),
      actionType: action.type,
      target: describeAction(action),
      // The BINDING is logged, never the value. A secret that is never written down cannot leak
      // through a log file.
      ...(action.type === 'type' || action.type === 'select'
        ? { valueBinding: describeBinding(action.value) }
        : {}),
    });

    const blocked = (
      error: ActionResult & { status: 'blocked' },
    ): {
      result: ActionResult;
      trace: ResolutionTrace;
    } => {
      this.#evidence?.append({
        type: 'action_blocked',
        at: new Date().toISOString(),
        actionType: action.type,
        error: error.error,
        reason: error.reason,
      });
      return { result: error, trace: emptyTrace(this.#lastObservation?.observationId ?? 'none') };
    };

    const failed = (
      error: ActionResult & { status: 'failed' },
      trace: ResolutionTrace,
    ): { result: ActionResult; trace: ResolutionTrace } => {
      this.#evidence?.append({
        type: 'action_failed',
        at: new Date().toISOString(),
        actionType: action.type,
        error: error.error,
        reason: error.reason,
      });
      return { result: error, trace };
    };

    // ---- 2. bootstrap safety minimum, static half ----------------------------------------------
    const minimum = bootstrapStaticCheck(materialized, this.#allowedOrigin);
    if (!minimum.allowed) {
      return blocked({ status: 'blocked', error: minimum.error, reason: minimum.reason });
    }

    // ---- 3. static policy precheck (PHASE 7 engine plugs in here, alongside the minimum) --------
    const staticPolicy = staticPolicyHook(materialized, this.#allowedOrigin);
    if (!staticPolicy.allowed) {
      return blocked({
        status: 'blocked',
        error: staticPolicy.error,
        reason: staticPolicy.reason,
      });
    }

    if (materialized.type === 'navigate') {
      const target = navigationTarget(materialized.pathSegments, this.#allowedOrigin);
      if (target === null) {
        return blocked({
          status: 'blocked',
          error: 'ALLOWLIST_VIOLATION',
          reason: 'navigation target could not be resolved',
        });
      }
      await this.#page.goto(target.href, { waitUntil: 'domcontentloaded' });
      const trace = emptyTrace(this.#lastObservation?.observationId ?? 'none');
      this.#evidence?.performed('navigate', trace);
      return { result: { status: 'performed', actionType: 'navigate' }, trace };
    }

    // ---- 4. resolve, through the ONE resolver ---------------------------------------------------
    const observation = await this.observe();
    const descriptor = bindDescriptor(materialized.target, this.#params);
    const resolution = this.#resolver.resolve(observation, descriptor);

    if (!resolution.ok) {
      return failed(
        { status: 'failed', error: resolution.error, reason: resolution.detail },
        resolution.trace,
      );
    }

    const control = resolution.control;
    const trace = resolution.trace;

    // ---- 5. resolved-control policy -------------------------------------------------------------
    // Only now is it possible to say what this action would actually do.
    const resolvedMinimum = bootstrapResolvedCheck(materialized, control);
    if (!resolvedMinimum.allowed) {
      this.#evidence?.append({
        type: 'action_blocked',
        at: new Date().toISOString(),
        actionType: action.type,
        error: resolvedMinimum.error,
        reason: resolvedMinimum.reason,
      });
      return {
        result: { status: 'blocked', error: resolvedMinimum.error, reason: resolvedMinimum.reason },
        trace,
      };
    }

    const resolvedPolicy = resolvedPolicyHook(materialized, control);
    if (!resolvedPolicy.allowed) {
      this.#evidence?.append({
        type: 'action_blocked',
        at: new Date().toISOString(),
        actionType: action.type,
        error: resolvedPolicy.error,
        reason: resolvedPolicy.reason,
      });
      return {
        result: { status: 'blocked', error: resolvedPolicy.error, reason: resolvedPolicy.reason },
        trace,
      };
    }

    // ---- 6. revalidate ---------------------------------------------------------------------------
    const addressing = this.#addressing.get(control.markId);
    if (addressing === undefined) {
      return failed(
        {
          status: 'failed',
          error: 'CONTROL_NOT_FOUND',
          reason: 'the resolved control has no transport addressing on this surface',
        },
        trace,
      );
    }

    const frame = await findFrame(this.#page, addressing.contextPath);
    if (frame === undefined) {
      return failed(
        {
          status: 'failed',
          error: 'CONTROL_NOT_FOUND',
          reason: 'the frame ' + addressing.contextPath.join(' > ') + ' is no longer present',
        },
        trace,
      );
    }

    const located = await locate(frame, addressing);
    if (located === null) {
      return failed(
        {
          status: 'failed',
          error: 'CONTROL_NOT_FOUND',
          reason: 'the control was perceived but is not addressable on this surface',
        },
        trace,
      );
    }

    const valid = await revalidate(located, addressing);
    if (!valid.ok) {
      return failed({ status: 'failed', error: 'CONTROL_NOT_FOUND', reason: valid.reason }, trace);
    }

    // ---- 7. perform -------------------------------------------------------------------------------
    try {
      switch (materialized.type) {
        case 'click':
          await located.target.click({ timeout: this.#timeout });
          break;
        case 'type':
          await located.target.fill(this.#values.resolve(materialized.value), {
            timeout: this.#timeout,
          });
          break;
        case 'select': {
          const value = this.#values.resolve(materialized.value);
          try {
            await located.target.selectOption({ label: value }, { timeout: this.#timeout });
          } catch {
            await located.target.selectOption(value, { timeout: this.#timeout });
          }
          break;
        }
        case 'read': {
          // `inputValue` throws on anything that is not a form control, which is a cheaper and
          // more honest test than asking the page for its tag name: it fails exactly when the
          // element has no value to read, and then we fall back to its visible text.
          let readValue: string;
          try {
            readValue = await located.target.inputValue({ timeout: this.#timeout });
          } catch {
            readValue = (await located.target.innerText({ timeout: this.#timeout })).trim();
          }
          this.#evidence?.performed('read', trace);
          // ---- 8. return -------------------------------------------------------------------------
          return { result: { status: 'performed', actionType: 'read', readValue }, trace };
        }
      }
    } catch (error) {
      return failed(
        {
          status: 'failed',
          error: 'EFFECT_NOT_OBSERVED',
          reason: error instanceof Error ? error.message : 'the action did not complete',
        },
        trace,
      );
    }

    // ---- 8. return ---------------------------------------------------------------------------------
    this.#evidence?.performed(materialized.type, trace);
    return { result: { status: 'performed', actionType: materialized.type }, trace };
  }

  /**
   * Predicate polling. There is no fixed sleep anywhere in this adapter.
   *
   * A fixed wait is a guess about someone else machine, and it fails in exactly two ways: too short
   * and the run is flaky, too long and every run pays for it. When a bounded backoff is genuinely
   * needed it is RECORDED as a `bounded_backoff` evidence event, so a reader can see every moment
   * this system chose to wait rather than to check.
   */
  async waitFor(condition: WaitCondition, timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    const describe =
      condition.kind === 'text_present'
        ? 'text_present:' + condition.text
        : condition.kind === 'control_present'
          ? 'control_present:' +
            (condition.descriptor.semantic.name ?? condition.descriptor.semantic.role)
          : 'screen_identity_changed';

    let satisfied = false;
    while (Date.now() - started < timeoutMs) {
      satisfied = await this.#check(condition);
      if (satisfied) break;
      await this.#backoff(POLL_INTERVAL_MS, 'polling for ' + describe);
    }

    this.#evidence?.append({
      type: 'wait',
      at: new Date().toISOString(),
      condition: describe,
      satisfied,
      ms: Date.now() - started,
    });
    return satisfied;
  }

  async #check(condition: WaitCondition): Promise<boolean> {
    switch (condition.kind) {
      case 'text_present': {
        for (const frame of this.#page.frames()) {
          const text = await frame
            .evaluate('document.body ? document.body.innerText : ""')
            .catch(() => '');
          if (typeof text === 'string' && text.includes(condition.text)) return true;
        }
        return false;
      }
      case 'control_present': {
        const observation = await this.observe();
        return this.#resolver.resolve(
          observation,
          bindDescriptor(condition.descriptor, this.#params),
        ).ok;
      }
      case 'screen_identity_changed': {
        const now = await this.screenIdentity();
        return (
          now.canonicalScreenName !== condition.from.canonicalScreenName ||
          now.title !== condition.from.title
        );
      }
    }
  }

  /** The single place this system is allowed to wait on a clock, and it is always recorded. */
  async #backoff(ms: number, reason: string): Promise<void> {
    this.#evidence?.append({ type: 'bounded_backoff', at: new Date().toISOString(), ms, reason });
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async captureEvidence(kind: EvidenceKind): Promise<string> {
    if (this.#evidence === undefined) return 'evidence-disabled';

    if (kind === 'screenshot') {
      // PHASE 7 masks declared sensitive boxes here, using PerceivedControl.box. Until then the
      // screenshot is unmasked, and README and REPORT say so rather than implying otherwise.
      return this.#evidence.writeScreenshot(await this.#page.screenshot({ fullPage: true }));
    }

    const observation = this.#lastObservation ?? (await this.observe());
    return this.#evidence.writeJson(
      'observation-' + observation.observationId + '.json',
      observation,
    );
  }

  /**
   * PHASE 8 owns the pause / cede / resume protocol. What this returns is the honest PHASE 2
   * answer: the browser is HEADED, so the same live session the automation has been driving is
   * already on the operator screen. Nothing is copied, nothing is mirrored, and the automation
   * lease is what stops the two actors from acting at once.
   */
  async exposeForHuman(): Promise<HumanSessionHandle> {
    return {
      sessionId: this.id + ':' + randomUUID(),
      kind: 'headed_browser',
      location: this.#page.url(),
      note:
        'The same live browser window the automation is driving. The lease governs SOFTWARE ' +
        'actions; direct OS input by the operator is out of band.',
    };
  }

  async close(): Promise<void> {
    await this.#page.close();
  }
}
