import { describe, expect, it } from 'vitest';
import {
  decodePng,
  encodePng,
  fillRect,
  pixelsDiffering,
  type RgbaImage,
} from '../../src/redaction/png.js';
import { maskScreenshot, sensitiveControls } from '../../src/redaction/masking.js';
import {
  passesLuhn,
  Pseudonymizer,
  pseudonymizerFromEnv,
} from '../../src/redaction/pseudonymize.js';
import type { Observation, PerceivedControl } from '../../src/types/perception.js';

/**
 * ================================================================================================
 * THE THREE DATA MECHANISMS ARE DIFFERENT AND MUST NOT BE CONFLATED.
 * ================================================================================================
 *
 *   (1) PERSISTENCE  pseudonymize before writing logs, transcripts, evidence, human CLI output
 *   (2) ARTIFACTS    scan and REJECT, never rewrite - tested in artifact.gate1-leak.test.ts
 *   (3) CALLER       not redacted at all: `replay --json` returns real typed outputs
 *
 * This file covers (1) and the screenshot masking that goes with it. (3) is asserted in
 * `tests/replay.outputs.test.ts` because "we did NOT redact this" is as much a behaviour as the
 * other two.
 */

describe('[MUST] pseudonyms are not a dictionary attack waiting to happen', () => {
  it('uses a per-run RANDOM map by default, not a hash of the value', () => {
    // A truncated hash of a five-digit member id is enumerable in under a second. There are 100,000
    // of them. A short digest of a low-entropy value is not pseudonymization, it is an index into
    // the plaintext - and it looks careful, which is what makes it worse than doing nothing.
    const a = new Pseudonymizer();
    const b = new Pseudonymizer();

    const first = a.label('memberId', '10001');
    const second = b.label('memberId', '10001');

    expect(first).toBe('[memberId:subject-01]');
    // Two RUNS give the same member different labels. Correlating across runs is precisely the
    // capability an attacker holding the logs would want.
    expect(second).toBe('[memberId:subject-01]');
    expect(a.label('memberId', '10002')).toBe('[memberId:subject-02]');
    expect(b.label('memberId', '99999')).toBe('[memberId:subject-02]');
    // ...and the same label therefore means different people in different runs, which is the
    // honest consequence of not having a key.
  });

  it('is stable within one run', () => {
    const p = new Pseudonymizer();
    expect(p.label('memberId', '10001')).toBe(p.label('memberId', '10001'));
  });

  it('REFUSES to truncate an HMAC below 8 bytes', () => {
    expect(() => new Pseudonymizer({ secret: 'k', hmacBytes: 4 })).toThrow(/8 bytes/);
  });

  it('produces a 16-hex-char label when a secret is supplied', () => {
    const p = new Pseudonymizer({ secret: 'a-secret-from-outside-the-repo' });
    const label = p.label('memberId', '10001');

    expect(label).toMatch(/^\[memberId:[0-9a-f]{16}\]$/);
    // Stable ACROSS runs, which is the trade the secret buys - and the cost is that anyone holding
    // the secret can correlate.
    const other = new Pseudonymizer({ secret: 'a-secret-from-outside-the-repo' });
    expect(other.label('memberId', '10001')).toBe(label);
  });

  it('reads the secret from the environment, never from a file in the repository', () => {
    expect(pseudonymizerFromEnv({}).label('memberId', '10001')).toBe('[memberId:subject-01]');
    expect(pseudonymizerFromEnv({ PSEUDONYM_SECRET: 'x'.repeat(32) }).label('a', 'b')).toMatch(
      /^\[a:[0-9a-f]{16}\]$/,
    );
  });
});

describe('what gets detected', () => {
  const p = new Pseudonymizer();

  it('replaces declared values wherever they appear in prose', () => {
    const declared = new Map([['memberId', '10001']]);
    const text = p.text('opened the record for member 10001 and read the balance', declared);

    expect(text).not.toContain('10001');
    expect(text).toContain('[memberId:');
  });

  it('[MUST] Luhn-validates before treating a digit run as a card number', () => {
    // Without the check digit, every account number, reference and timestamp of the right length
    // gets replaced, the logs become unreadable, and the next person turns redaction off.
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);

    const kept = p.text('reference 1234567890123 for the batch');
    expect(kept).toContain('1234567890123');

    const masked = p.text('card 4111 1111 1111 1111 on file');
    expect(masked).not.toContain('4111 1111 1111 1111');
    expect(masked).toContain('[card:');
  });

  it('detects emails, SSN-like and phone-like shapes', () => {
    expect(p.text('write to a.person@example.com')).toContain('[email:');
    expect(p.text('ssn 123-45-6789')).toContain('[ssn:');
    expect(p.text('call 555-123-4567')).toContain('[phone:');
  });

  it('redacts a value WHOLESALE when its KEY says it is a credential', () => {
    // A token is not a subject to be labelled consistently. It is a credential, and the only safe
    // thing to record about it is that it was there.
    const out = p.value({ passcode: 'hunter2', note: 'fine' }) as Record<string, unknown>;

    expect(out['passcode']).toBe('[redacted:passcode]');
    expect(out['note']).toBe('fine');
  });

  it('walks nested objects and arrays', () => {
    const declared = new Map([['memberId', '10001']]);
    const out = p.value({ steps: [{ detail: 'member 10001' }] }, declared) as {
      steps: { detail: string }[];
    };

    expect(out.steps[0]?.detail).not.toContain('10001');
  });
});

// =================================================================================================
// PNG and masking. The claim is about PIXELS, so the tests are about pixels.
// =================================================================================================

function solidImage(width: number, height: number, colour: number): RgbaImage {
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = colour;
    pixels[i + 1] = colour;
    pixels[i + 2] = colour;
    pixels[i + 3] = 255;
  }
  return { width, height, pixels };
}

describe('the PNG round trip', () => {
  it('encodes and decodes back to the same pixels', () => {
    const image = solidImage(40, 20, 200);
    fillRect(image, { x: 5, y: 5, width: 10, height: 4 }, [1, 2, 3, 255]);

    const decoded = decodePng(encodePng(image));

    expect(decoded.width).toBe(40);
    expect(decoded.height).toBe(20);
    expect(pixelsDiffering(image, decoded)).toBe(0);
  });

  it('refuses a format it cannot handle rather than decoding it wrongly', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/not a PNG/);
  });
});

describe('masking changes the PIXELS, not just the manifest', () => {
  function control(over: Partial<PerceivedControl>): PerceivedControl {
    return {
      markId: 1,
      role: 'cell',
      name: '',
      enabled: true,
      contextPath: ['contentFrame'],
      nearbyText: [],
      stableAttributes: {},
      box: { x: 0, y: 0, width: 10, height: 10 },
      boxSpace: 'page',
      containers: [],
      ...over,
    };
  }

  function observationOf(controls: PerceivedControl[]): Observation {
    return {
      observationId: 'obs-1',
      surfaceId: 'test',
      capturedAt: new Date().toISOString(),
      perceptionPath: 'cdp_ax',
      screenIdentity: {
        canonicalScreenName: 'Member Record',
        title: 't',
        url: 'http://localhost:4180/member/10001',
        headings: [],
        contextPath: [],
        versionMarker: 'v',
      },
      controls,
      truncation: { perceived: controls.length, included: controls.length, dropped: 0 },
    } as unknown as Observation;
  }

  const declaration = {
    sensitiveNames: new Set(['memberId']),
    values: new Map([['memberId', '10001']]),
    recordIdentityParam: 'memberId',
  };

  it('finds the control showing a declared sensitive value', () => {
    const found = sensitiveControls(
      observationOf([control({ name: '10001' }), control({ markId: 2, name: 'Active' })]),
      declaration,
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.control.markId).toBe(1);
    expect(found[0]?.reason).toBe('record-identity');
  });

  it('[MUST] the masked image DIFFERS from the unmasked one, in the right place', () => {
    // The claim is that the value is not in the image. Asserting a manifest entry exists would
    // prove only that we wrote a manifest.
    const original = solidImage(60, 40, 255);
    const png = encodePng(original);

    const masked = maskScreenshot({
      png,
      observation: observationOf([
        control({ name: '10001', box: { x: 10, y: 10, width: 20, height: 8 } }),
      ]),
      declaration,
      sourceName: '0001.png',
    });

    const after = decodePng(masked.png);
    expect(pixelsDiffering(original, after)).toBeGreaterThan(0);

    // In the RIGHT place: inside the box is painted, and a corner far from it is untouched.
    const at = (x: number, y: number): number => (y * after.width + x) * 4;
    expect(after.pixels[at(15, 12)]).not.toBe(255);
    expect(after.pixels[at(55, 38)]).toBe(255);
  });

  it('records the region in the manifest as well', () => {
    const masked = maskScreenshot({
      png: encodePng(solidImage(60, 40, 255)),
      observation: observationOf([
        control({ name: '10001', box: { x: 10, y: 10, width: 20, height: 8 } }),
      ]),
      declaration,
      sourceName: '0001.png',
    });

    expect(masked.manifest.maskedRegions).toHaveLength(1);
    expect(masked.manifest.maskedRegions[0]?.reason).toBe('record-identity');
    expect(masked.manifest.sourceScreenshot).toBe('0001.png');
  });

  it('[MUST] REFUSES to draw a box it could not offset into page space', () => {
    // An unoffset box lands away from its control: the screenshot LOOKS redacted and the value sits
    // legible beside a black rectangle. That is worse than no mask, so it is refused and recorded.
    const masked = maskScreenshot({
      png: encodePng(solidImage(60, 40, 255)),
      observation: observationOf([
        control({ name: '10001', boxSpace: 'frame', box: { x: 10, y: 10, width: 20, height: 8 } }),
      ]),
      declaration,
      sourceName: '0001.png',
    });

    expect(masked.manifest.maskedRegions).toHaveLength(0);
    expect(masked.manifest.refused).toHaveLength(1);
    expect(masked.manifest.refused[0]?.why).toContain('frame coordinates');
    // And the image is unchanged, so nobody can mistake it for a masked one.
    expect(pixelsDiffering(solidImage(60, 40, 255), decodePng(masked.png))).toBe(0);
  });

  it('masks nothing when nothing on the screen is declared sensitive', () => {
    const masked = maskScreenshot({
      png: encodePng(solidImage(60, 40, 255)),
      observation: observationOf([control({ name: 'Member Search' })]),
      declaration,
      sourceName: '0001.png',
    });

    expect(masked.manifest.maskedRegions).toEqual([]);
    expect(masked.manifest.refused).toEqual([]);
  });
});
