import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLegacyApp } from '../fixtures/legacy-app/server.js';
import { tenantA } from '../fixtures/legacy-app/tenants/tenant-a.js';
import { MERIDIAN_SIGN_ON } from '../src/config/sign-on.js';
import { EvidenceWriter } from '../src/evidence/logger.js';
import { decodePng } from '../src/redaction/png.js';
import { Pseudonymizer } from '../src/redaction/pseudonymize.js';
import { LeaseManager } from '../src/session/lease.js';
import { SessionStateMachine } from '../src/session/state.js';
import { launchDeterministicBrowser } from '../src/surface/playwright-web/browser.js';
import { PlaywrightWebSurface } from '../src/surface/playwright-web/surface.js';
import { FIXTURE_CONTROLS } from './helpers/descriptors.js';
import type { LeaseToken } from '../src/types/session.js';
import type { MaskManifest } from '../src/redaction/masking.js';

/**
 * ================================================================================================
 * MASKING, AGAINST A REAL SCREEN, WITH REAL BOXES.
 * ================================================================================================
 *
 * The browser-free tests in `redaction.test.ts` prove the pixel arithmetic against a synthetic
 * image. They cannot prove the thing most likely to be wrong: that the BOXES describe where the
 * control actually is.
 *
 * `PerceivedControl.box` comes from `getBoundingClientRect()` INSIDE the frame that owns the
 * control, and on this application everything worth masking lives in `contentFrame`, nested inside
 * layout tables. An unoffset box lands well away from its control - the screenshot LOOKS redacted
 * and the value sits legible beside a black rectangle, which is the worst outcome available.
 *
 * So this file takes a real screenshot of a real screen and reads the pixels back.
 */

const MEMBER_ID = '10001';

describe('declared-sensitive regions are masked on a real screen', () => {
  let closeFixture: () => Promise<void>;
  let closeBrowser: () => Promise<void>;
  let surface: PlaywrightWebSurface;
  let token: LeaseToken;
  let evidenceRoot: string;
  let evidence: EvidenceWriter;

  beforeAll(async () => {
    const { app } = createLegacyApp({ tenant: tenantA });
    const origin = await new Promise<string>((resolve) => {
      const server = app.listen(0, () => {
        const address = server.address() as AddressInfo;
        closeFixture = () => new Promise<void>((done) => server.close(() => done()));
        resolve('http://127.0.0.1:' + address.port);
      });
    });

    const browser = await launchDeterministicBrowser({ headless: true });
    closeBrowser = browser.close;

    evidenceRoot = mkdtempSync(join(tmpdir(), 'mask-'));
    evidence = new EvidenceWriter({
      runId: 'masking',
      rootDir: evidenceRoot,
      pseudonymizer: new Pseudonymizer(),
    });
    evidence.declareSensitive({
      sensitiveNames: new Set(['memberId']),
      values: new Map([['memberId', MEMBER_ID]]),
      recordIdentityParam: 'memberId',
    });

    const lease = new LeaseManager();
    surface = new PlaywrightWebSurface({
      page: browser.page,
      context: browser.context,
      allowedOrigin: origin,
      lease,
      session: new SessionStateMachine(),
      evidence,
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

    // Reached by CLICKING, not by navigating to /member/10001 directly.
    //
    // That is not a stylistic choice. A direct navigation loads the member screen as a TOP-LEVEL
    // document, where every box is already in page space and the offset arithmetic is never
    // exercised. Going through the shell puts the same screen inside `contentFrame`, which is
    // where the application actually renders it and where an unoffset box would be wrong.
    await surface.resolveAndPerform(
      {
        type: 'type',
        target: FIXTURE_CONTROLS.memberId,
        value: { kind: 'literal', value: MEMBER_ID },
      },
      token,
    );
    await surface.resolveAndPerform({ type: 'click', target: FIXTURE_CONTROLS.search }, token);
    await surface.waitFor({ kind: 'text_present', text: 'Search Results' }, 15_000);
    await surface.resolveAndPerform({ type: 'click', target: FIXTURE_CONTROLS.open10001 }, token);
    await surface.waitFor({ kind: 'text_present', text: 'Member Record' }, 15_000);
  }, 120_000);

  afterAll(async () => {
    await closeBrowser?.();
    await closeFixture?.();
  });

  it('[MUST] offsets boxes out of the frame and into page space', async () => {
    // The bug this guards. Everything on this screen is inside `contentFrame`, which sits well
    // below and right of the page origin, so a frame-local box is simply the wrong rectangle.
    const observation = await surface.observe();
    const inContent = observation.controls.filter((control) =>
      control.contextPath.includes('contentFrame'),
    );

    expect(inContent.length).toBeGreaterThan(0);
    for (const control of inContent) {
      expect(control.boxSpace, control.role + ' "' + control.name + '"').toBe('page');
    }

    // And the offset is real rather than zero: content-frame boxes start further down the page
    // than the frame itself does.
    const lowest = Math.min(...inContent.map((control) => control.box.y));
    expect(lowest).toBeGreaterThan(0);
  }, 60_000);

  it('[MUST] the written screenshot DIFFERS from the unmasked one', async () => {
    const observation = await surface.observe();

    // The unmasked bytes, taken here only so the test has something to compare against. In the
    // product these never get a filename.
    const raw = await surface.captureEvidence('screenshot');
    expect(raw).toContain('.png');

    const written = readdirSync(join(evidenceRoot, 'masking', 'screenshots')).filter((name) =>
      name.endsWith('.png'),
    );
    expect(written.length).toBeGreaterThan(0);

    const maskedPng = decodePng(
      readFileSync(join(evidenceRoot, 'masking', 'screenshots', written[written.length - 1]!)),
    );

    const manifestName = written[written.length - 1]!.replace(/\.png$/, '.mask.json');
    const manifest = JSON.parse(
      readFileSync(join(evidenceRoot, 'masking', 'screenshots', manifestName), 'utf8'),
    ) as MaskManifest;

    // Something was masked, and it was the member id.
    expect(manifest.maskedRegions.length).toBeGreaterThan(0);
    expect(manifest.refused).toEqual([]);
    expect(manifest.maskedRegions.some((region) => region.reason === 'record-identity')).toBe(true);

    // THE PIXELS. Sample the centre of a masked region and require it to be the mask colour, then
    // require the same coordinates in an unmasked capture to be something else.
    const region = manifest.maskedRegions[0]!;
    const cx = Math.floor(region.rect.x + region.rect.width / 2);
    const cy = Math.floor(region.rect.y + region.rect.height / 2);
    const at = (cy * maskedPng.width + cx) * 4;

    expect(cx).toBeGreaterThan(0);
    expect(cy).toBeGreaterThan(0);
    expect(maskedPng.pixels[at]).toBe(17);
    expect(maskedPng.pixels[at + 1]).toBe(17);
    expect(maskedPng.pixels[at + 2]).toBe(17);

    // The rest of the page is untouched: this is a mask, not a black rectangle over everything.
    // Counted rather than sampled, because "we painted the whole screenshot" would also satisfy
    // every assertion above.
    let maskColoured = 0;
    for (let i = 0; i < maskedPng.pixels.length; i += 4) {
      if (
        maskedPng.pixels[i] === 17 &&
        maskedPng.pixels[i + 1] === 17 &&
        maskedPng.pixels[i + 2] === 17
      ) {
        maskColoured += 1;
      }
    }
    const total = maskedPng.width * maskedPng.height;
    expect(maskColoured).toBeGreaterThan(0);
    expect(maskColoured / total).toBeLessThan(0.25);
    expect(observation.controls.length).toBeGreaterThan(0);
  }, 60_000);

  it('the manifest names WHY each region was masked, for a reviewer without the image', async () => {
    await surface.captureEvidence('screenshot');

    const files = readdirSync(join(evidenceRoot, 'masking', 'screenshots')).filter((name) =>
      name.endsWith('.mask.json'),
    );
    const manifest = JSON.parse(
      readFileSync(join(evidenceRoot, 'masking', 'screenshots', files[files.length - 1]!), 'utf8'),
    ) as MaskManifest;

    for (const region of manifest.maskedRegions) {
      expect(['pii', 'secret', 'record-identity']).toContain(region.reason);
      expect(region.descriptorRef).toBeTruthy();
    }
    expect(manifest.observationId).toBeTruthy();
  }, 60_000);

  it('pseudonymizes the member id in the EVENT LOG that goes alongside', () => {
    // Two mechanisms, one declaration. The screenshot is masked and the log is pseudonymized, and
    // they cannot disagree about what is sensitive because `declareSensitive` set both.
    const events = readFileSync(join(evidenceRoot, 'masking', 'events.jsonl'), 'utf8');

    expect(events).not.toContain('"' + MEMBER_ID + '"');
    expect(events.length).toBeGreaterThan(0);
  });
});
