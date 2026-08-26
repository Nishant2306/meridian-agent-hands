import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLegacyApp } from '../fixtures/legacy-app/server.js';
import { tenantA } from '../fixtures/legacy-app/tenants/tenant-a.js';
import { buildDescriptor } from '../src/agent/descriptors.js';
import { MERIDIAN_SIGN_ON } from '../src/config/sign-on.js';
import { bindDescriptor } from '../src/perception/bind.js';
import { DefaultTargetResolver } from '../src/perception/resolver.js';
import { LeaseManager } from '../src/session/lease.js';
import { SessionStateMachine } from '../src/session/state.js';
import { launchDeterministicBrowser } from '../src/surface/playwright-web/browser.js';
import { PlaywrightWebSurface } from '../src/surface/playwright-web/surface.js';
import type { LeaseToken } from '../src/types/session.js';
import type { TargetDescriptor } from '../src/types/control.js';
import type { SurfaceAction } from '../src/types/action.js';
import { FIXTURE_CONTROLS, pathSegments } from './helpers/descriptors.js';

/**
 * ================================================================================================
 * PERCEIVED -> DESCRIBABLE -> RESOLVABLE -> ADDRESSABLE. THE WHOLE CHAIN, EVERY CONTROL.
 * ================================================================================================
 *
 * This is the test that would have caught the GATE 1 failure, and the reason it needs a browser is
 * the reason the failure happened at all.
 *
 * `tests/agent.descriptors.invariant.test.ts` proves the resolver-level half exhaustively and in
 * milliseconds: a synthesized descriptor resolves back to its own control. That half PASSED for the
 * member-name paragraph. The break was one layer lower - turning a resolved control into a
 * Playwright locator - and a locator is only real against a live page. Chrome's accessibility tree
 * reported a name for a `<p>`; ARIA does not give `paragraph` a name from content; so
 * `getByRole('paragraph', { name })` matched nothing while the control sat plainly on the screen.
 *
 * The check is a `read` on every perceived control. `read` is the only action that touches
 * everything without changing anything, and it travels the REAL input path - resolve, address,
 * revalidate - so nothing here is a parallel implementation of the thing under test.
 */

interface Screen {
  readonly name: string;
  readonly screenName: string;
  /** Text that proves we are looking at the intended VARIANT of that screen. */
  readonly distinguisher?: string;
  /** How to GET to this screen. Deep links do not work for all of them, and that is the app's
   * business: the review screen 303s back to the form unless a draft exists in the session, and
   * search results live behind a query string rather than a path. Walking there the way an
   * operator does is both faithful and the only thing that works. */
  readonly reach: (go: Reach) => Promise<void>;
}

interface Reach {
  navigate(path: string): Promise<void>;
  click(target: TargetDescriptor): Promise<void>;
  type(target: TargetDescriptor, value: string): Promise<void>;
  select(target: TargetDescriptor, value: string): Promise<void>;
  wait(text: string): Promise<void>;
}

const SCREENS: readonly Screen[] = [
  {
    name: 'member search',
    screenName: 'Member Search',
    reach: async (go) => {
      await go.navigate('/search');
    },
  },
  {
    name: 'search results, four rows',
    // The results render UNDER the search form, so the canonical screen name stays "Member
    // Search" - the h1 does not change. `distinguisher` is what separates the two.
    screenName: 'Member Search',
    distinguisher: 'Search Results',
    reach: async (go) => {
      await go.navigate('/search');
      await go.type(FIXTURE_CONTROLS.memberId, '1000');
      await go.click(FIXTURE_CONTROLS.search);
      await go.wait('Search Results');
    },
  },
  {
    name: 'search results, no match',
    screenName: 'Member Search',
    distinguisher: 'No member found',
    reach: async (go) => {
      await go.navigate('/search');
      await go.type(FIXTURE_CONTROLS.memberId, '99999');
      await go.click(FIXTURE_CONTROLS.search);
      await go.wait('No member found');
    },
  },
  {
    name: 'member record',
    screenName: 'Member Record',
    reach: async (go) => {
      await go.navigate('/member/10001');
    },
  },
  {
    name: 'new sub-account form',
    screenName: 'New Sub-Account',
    reach: async (go) => {
      await go.navigate('/member/10001/subaccount/new');
    },
  },
  {
    name: 'review',
    screenName: 'Review Sub-Account Request',
    reach: async (go) => {
      await go.navigate('/member/10001/subaccount/new');
      await go.select(FIXTURE_CONTROLS.accountType, 'Savings');
      await go.type(FIXTURE_CONTROLS.deposit, '250.00');
      await go.click(FIXTURE_CONTROLS.continue);
      await go.wait('Review Sub-Account Request');
    },
  },
];

const RUNTIME_INPUTS = {
  memberId: '10001',
  accountType: 'Savings',
  nickname: 'Vacation',
  initialDeposit: '250.00',
};
const RUNTIME_VALUES = Object.values(RUNTIME_INPUTS);

function descriptorOf(built: ReturnType<typeof buildDescriptor>): TargetDescriptor {
  if ('error' in built) throw new Error('expected a descriptor, got: ' + built.error);
  return built.descriptor;
}

describe('every perceived control can be addressed back to itself', () => {
  let closeFixture: () => Promise<void>;
  let closeBrowser: () => Promise<void>;
  let surface: PlaywrightWebSurface;
  let token: LeaseToken;
  let origin: string;

  beforeAll(async () => {
    const { app } = createLegacyApp({ tenant: tenantA });
    origin = await new Promise<string>((resolve) => {
      const server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        closeFixture = () => new Promise<void>((done) => server.close(() => done()));
        resolve('http://127.0.0.1:' + address.port);
      });
    });

    const browser = await launchDeterministicBrowser({ headless: true });
    closeBrowser = browser.close;

    const lease = new LeaseManager();
    surface = new PlaywrightWebSurface({
      page: browser.page,
      context: browser.context,
      allowedOrigin: origin,
      lease,
      session: new SessionStateMachine(),
      values: {
        secrets: { operatorId: 'fixture-operator', operatorPasscode: 'fixture-passcode' },
      },
    });
    token = lease.issue('AUTOMATION', 600_000);

    await surface.resolveAndPerform({ type: 'navigate', pathSegments: [] }, token);
    await surface.resolveAndPerform(
      {
        type: 'type',
        target: MERIDIAN_SIGN_ON.operator,
        value: { kind: 'secretRef', name: MERIDIAN_SIGN_ON.operatorSecretRef },
      },
      token,
    );
    await surface.resolveAndPerform(
      {
        type: 'type',
        target: MERIDIAN_SIGN_ON.passcode,
        value: { kind: 'secretRef', name: MERIDIAN_SIGN_ON.passcodeSecretRef },
      },
      token,
    );
    await surface.resolveAndPerform({ type: 'click', target: MERIDIAN_SIGN_ON.submit }, token);
    await surface.waitFor(
      { kind: 'text_present', text: MERIDIAN_SIGN_ON.authenticatedText },
      15_000,
    );
  }, 120_000);

  afterAll(async () => {
    await closeBrowser?.();
    await closeFixture?.();
  });

  /** Every step goes through resolveAndPerform, and a step that does not happen fails the test
   * rather than quietly leaving the browser on the previous screen. */
  function reacher(): Reach {
    const must = async (action: SurfaceAction, what: string): Promise<void> => {
      const { result } = await surface.resolveAndPerform(action, token);
      if (result.status !== 'performed') {
        throw new Error('could not ' + what + ': ' + result.error + ' ' + result.reason);
      }
    };
    return {
      navigate: (path) =>
        must({ type: 'navigate', pathSegments: pathSegments(path) }, 'navigate to ' + path),
      click: (target) => must({ type: 'click', target }, 'click'),
      type: (target, value) =>
        must({ type: 'type', target, value: { kind: 'literal', value } }, 'type "' + value + '"'),
      select: (target, value) =>
        must(
          { type: 'select', target, value: { kind: 'literal', value } },
          'select "' + value + '"',
        ),
      wait: async (text) => {
        await surface.waitFor({ kind: 'text_present', text }, 15_000);
      },
    };
  }

  it.each(SCREENS)(
    '$name',
    async ({ reach, screenName, distinguisher }) => {
      await reach(reacher());

      const observation = await surface.observe();
      if (distinguisher !== undefined) {
        const text = observation.controls.map((control) => control.name).join(' | ');
        expect(text, 'did not reach the ' + distinguisher + ' variant').toContain(distinguisher);
      }
      expect(observation.perceptionPath).toBe('cdp_ax');
      expect(observation.controls.length).toBeGreaterThan(0);
      // Without this the suite happily checks whatever screen happened to be loaded. It was written
      // once without it, and every case passed while navigating nowhere.
      expect(observation.screenIdentity.canonicalScreenName).toBe(screenName);

      const resolver = new DefaultTargetResolver();
      const failures: string[] = [];
      const blocked: string[] = [];
      let addressed = 0;

      for (const control of observation.controls) {
        const built = buildDescriptor(control, {
          observation,
          resolver,
          runtimeValues: RUNTIME_VALUES,
          runtimeInputs: RUNTIME_INPUTS,
        });
        // Undescribable is a separate, legitimate outcome, pinned by the browser-free suite.
        if ('error' in built) continue;

        // Bound first, exactly as the discovery loop does. A row-keyed descriptor carries
        // `{ kind: 'param' }`, and the resolver refuses to resolve one rather than guessing.
        const { result } = await surface.resolveAndPerform(
          { type: 'read', target: bindDescriptor(built.descriptor, RUNTIME_INPUTS) },
          token,
        );

        if (result.status === 'blocked') {
          // The bootstrap safety minimum refusing to touch "Submit Request" is the guardrail doing
          // its job, and it is asserted separately below. It is not an addressing failure.
          blocked.push(control.name);
          continue;
        }

        if (result.status !== 'performed') {
          failures.push(
            control.role +
              ' "' +
              control.name +
              '" (mark ' +
              control.markId +
              ') -> ' +
              result.error +
              ': ' +
              result.reason,
          );
          continue;
        }
        addressed += 1;
      }

      // Listing every failure beats failing on the first: a recipe bug usually hits a whole CLASS of
      // controls, and the class is the diagnosis.
      expect(failures, failures.join('; ')).toEqual([]);
      expect(addressed).toBeGreaterThan(0);

      // Exactly one control in this application may be blocked, and only on one screen.
      expect(blocked.every((name) => name === 'Submit Request')).toBe(true);
      if (screenName === 'Review Sub-Account Request') expect(blocked).toContain('Submit Request');
    },
    120_000,
  );

  it('addresses the member-name paragraph, the control GATE 1 failed on', async () => {
    // The specific regression. `<p>Member Name: Avery Lin (10001)</p>` is role `paragraph`, which
    // is addressable by role but NOT named from its content.
    await reacher().navigate('/member/10001/subaccount/new');

    const observation = await surface.observe();
    expect(observation.screenIdentity.canonicalScreenName).toBe('New Sub-Account');
    const paragraph = observation.controls.find(
      (control) => control.role === 'text' && control.name.startsWith('Member Name'),
    );
    expect(paragraph).toBeDefined();

    const built = buildDescriptor(paragraph!, {
      observation,
      resolver: new DefaultTargetResolver(),
      runtimeValues: RUNTIME_VALUES,
      runtimeInputs: RUNTIME_INPUTS,
    });
    expect('error' in built).toBe(false);

    const { result } = await surface.resolveAndPerform(
      { type: 'read', target: bindDescriptor(descriptorOf(built), RUNTIME_INPUTS) },
      token,
    );

    expect(result.status).toBe('performed');
    // And it reads the value the model wanted, which is what makes it usable as record identity.
    expect(result.status === 'performed' && result.readValue).toContain('10001');
  }, 60_000);
});
