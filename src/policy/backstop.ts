import type { BrowserContext, Route } from 'playwright';

/**
 * ================================================================================================
 * THE BROWSER-LEVEL BACKSTOP. DEFENCE IN DEPTH, NOT THE PRIMARY CONTROL.
 * ================================================================================================
 *
 * The policy engine already refuses a navigate action to any origin outside the allowlist, and the
 * bootstrap minimum refused it before the engine existed. Both of those check what the AUTOMATION
 * asks for.
 *
 * They cannot check what the PAGE does. A legacy application can redirect, a meta refresh can fire,
 * a frame can be pointed somewhere else, an image or a script can be requested from another host.
 * None of that goes through `resolveAndPerform`, so none of it is visible to a policy that only
 * inspects actions. This handler sits at the transport and aborts anything whose origin is not
 * allowlisted, whoever asked for it.
 *
 * IT IS NOT A SUBSTITUTE FOR THE ACTION-LEVEL CHECKS, and it is important not to present it as one.
 * A request that is aborted here has already been ATTEMPTED, which for a GET to a third party may
 * mean a DNS lookup has happened. The action-level checks stop the request from being formed at
 * all. This one stops it from completing.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: `about:blank`, `data:` and `blob:` are left alone. They are not
 * network origins, Playwright uses `about:blank` for every fresh page, and aborting them breaks the
 * browser rather than protecting anything.
 */
export interface OriginBackstop {
  /** Origins that were requested and refused, in order. Read by a test, and by evidence. */
  readonly blocked: readonly string[];
  /** Stop intercepting. Used when a context is handed to a human, who is not bound by this. */
  dispose(): Promise<void>;
}

const NON_NETWORK_SCHEMES = ['about:', 'data:', 'blob:', 'chrome-error:'];

export async function installOriginBackstop(
  context: BrowserContext,
  allowedOrigins: readonly string[],
): Promise<OriginBackstop> {
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  const blocked: string[] = [];

  const handler = async (route: Route): Promise<void> => {
    const url = route.request().url();

    if (NON_NETWORK_SCHEMES.some((scheme) => url.startsWith(scheme))) {
      await route.continue();
      return;
    }

    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      // A URL the browser will not parse is not one we can classify, so it does not proceed.
      blocked.push(url);
      await route.abort('blockedbyclient');
      return;
    }

    if (allowed.has(origin)) {
      await route.continue();
      return;
    }

    blocked.push(url);
    // `blockedbyclient` rather than `failed`: it shows up in the network log as a deliberate
    // refusal rather than as a flaky connection, which is what it is.
    await route.abort('blockedbyclient');
  };

  await context.route('**/*', handler);

  return {
    get blocked() {
      return blocked;
    },
    dispose: async () => {
      await context.unroute('**/*', handler);
    },
  };
}
