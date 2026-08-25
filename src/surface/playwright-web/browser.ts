import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * A DETERMINISTIC browsing context.
 *
 * Every one of these is pinned because leaving it to the host machine makes a capability that
 * replays on the developer laptop and fails on the runner:
 *
 *   viewport            fixes layout, which fixes which controls are visible and in what order
 *   locale              fixes number and date rendering in the application own output
 *   timezone            same, for anything the application timestamps
 *   reducedMotion       removes animation, so "the screen settled" is a real observation and not a
 *                       race against a CSS transition
 *   deviceScaleFactor   fixes screenshot pixel geometry, which the PHASE 7 masking boxes depend on
 *
 * HEADLESS defaults to false because the human handoff (PHASE 8) transfers control of THIS SAME
 * live browser to a person, and a person cannot take control of a window that does not exist.
 */
export const DETERMINISTIC_CONTEXT = {
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
  reducedMotion: 'reduce',
  deviceScaleFactor: 1,
} as const;

export interface LaunchedBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function launchDeterministicBrowser(
  options: { headless?: boolean } = {},
): Promise<LaunchedBrowser> {
  const headless = options.headless ?? false;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { ...DETERMINISTIC_CONTEXT.viewport },
    locale: DETERMINISTIC_CONTEXT.locale,
    timezoneId: DETERMINISTIC_CONTEXT.timezoneId,
    reducedMotion: DETERMINISTIC_CONTEXT.reducedMotion,
    deviceScaleFactor: DETERMINISTIC_CONTEXT.deviceScaleFactor,
  });
  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

/** HEADLESS from the environment, defaulting to headed. See the note above. */
export function headlessFromEnv(): boolean {
  return (process.env['HEADLESS'] ?? 'false').toLowerCase() === 'true';
}
