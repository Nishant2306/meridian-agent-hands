import { decodePng, encodePng, fillRect, type Rect } from './png.js';
import type { Observation, PerceivedControl } from '../types/perception.js';

/**
 * ================================================================================================
 * DECLARED-BOX SCREENSHOT MASKING.
 * ================================================================================================
 *
 * Only the MASKED image is written to /evidence. The unmasked bytes exist in memory for the length
 * of one function call and are never given a filename, because a file that exists is a file that
 * gets copied.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THIS CLAIM IS, EXACTLY
 * ------------------------------------------------------------------------------------------------
 * We mask the regions of controls that are bound to DECLARED-sensitive inputs and outputs, and the
 * control bound to the record identity. That is a claim about DECLARED regions and nothing more.
 *
 * We do NOT claim the sensitive value is absent from the image. There is no OCR here, so a value
 * rendered somewhere nobody declared - a summary line, a tooltip, a page title, a neighbouring row -
 * is still in the pixels. docs/DATA_HANDLING.md and REPORT.md say this in those words. The distinction
 * matters because "the screenshot is redacted" and "these declared regions are covered" are very
 * different promises, and only the second one is true.
 *
 * ------------------------------------------------------------------------------------------------
 * A BOX IN THE WRONG COORDINATE SPACE IS WORSE THAN NO BOX
 * ------------------------------------------------------------------------------------------------
 * `PerceivedControl.box` is captured inside its own frame. On this application everything worth
 * masking lives in `contentFrame`, nested inside layout tables, so an unoffset box lands well away
 * from its control: the screenshot LOOKS redacted, and the value sits legible beside a black
 * rectangle. Extraction therefore offsets boxes into page space and marks them `boxSpace: 'page'`.
 * Anything still marked `'frame'` - a cross-origin frame, where the offset is unknowable - is
 * REFUSED rather than drawn, and the refusal is recorded in the manifest.
 */

export interface MaskRegion {
  /** How the control was identified, for a reviewer reading the manifest without the screenshot. */
  readonly descriptorRef: string;
  readonly reason: 'pii' | 'secret' | 'record-identity';
  readonly rect: Rect;
}

export interface MaskManifest {
  readonly sourceScreenshot: string;
  readonly maskedRegions: readonly MaskRegion[];
  /**
   * Controls that SHOULD have been masked and could not be. Never silently empty: a reviewer needs
   * to know the difference between "nothing was sensitive" and "something was and we could not
   * cover it".
   */
  readonly refused: readonly { descriptorRef: string; why: string }[];
  readonly observationId: string;
}

/** What the capability declared as sensitive, reduced to what masking needs. */
export interface SensitivityDeclaration {
  /** Declared input/output names whose sensitivity is pii or secret. */
  readonly sensitiveNames: ReadonlySet<string>;
  /** The values those names carry on this run, so the controls displaying them can be found. */
  readonly values: ReadonlyMap<string, string>;
  /** The parameter that identifies the record. Always masked. */
  readonly recordIdentityParam?: string;
}

function describe(control: PerceivedControl): string {
  return control.role + ' "' + control.name + '" (mark ' + control.markId + ')';
}

/**
 * Which controls on this screen are showing something declared sensitive.
 *
 * Matched by VALUE, not by descriptor: the control that displays a member id is whichever control
 * currently reads `10001`, and on a review screen that may be a cell nobody wrote a descriptor for.
 * Matching by value finds those; matching by descriptor would only find the ones we already act on.
 */
export function sensitiveControls(
  observation: Observation,
  declaration: SensitivityDeclaration,
): { control: PerceivedControl; reason: MaskRegion['reason']; name: string }[] {
  const found: { control: PerceivedControl; reason: MaskRegion['reason']; name: string }[] = [];

  for (const control of observation.controls) {
    const haystack = (control.name + ' ' + (control.value ?? '')).toLowerCase();

    for (const [name, value] of declaration.values) {
      if (value === '' || !haystack.includes(value.toLowerCase())) continue;
      const isIdentity = name === declaration.recordIdentityParam;
      if (!isIdentity && !declaration.sensitiveNames.has(name)) continue;
      found.push({
        control,
        reason: isIdentity ? 'record-identity' : 'pii',
        name,
      });
      break;
    }
  }

  return found;
}

export interface MaskedScreenshot {
  readonly png: Buffer;
  readonly manifest: MaskManifest;
}

/**
 * Mask a screenshot. Returns the image that may be written, and the manifest describing what was
 * covered and what could not be.
 */
export function maskScreenshot(options: {
  png: Buffer;
  observation: Observation;
  declaration: SensitivityDeclaration;
  sourceName: string;
}): MaskedScreenshot {
  const image = decodePng(options.png);
  const regions: MaskRegion[] = [];
  const refused: { descriptorRef: string; why: string }[] = [];

  for (const hit of sensitiveControls(options.observation, options.declaration)) {
    const ref = describe(hit.control);

    if (hit.control.boxSpace === 'frame') {
      refused.push({
        descriptorRef: ref,
        why:
          'its box is in frame coordinates and could not be offset into page space, so drawing ' +
          'it would put the mask somewhere other than the control',
      });
      continue;
    }

    const box = hit.control.box;
    if (box.width <= 0 || box.height <= 0) {
      refused.push({ descriptorRef: ref, why: 'the control has no measurable box' });
      continue;
    }

    // A couple of pixels of bleed, because a glyph's ink can sit a fraction outside the box its
    // element reports and a mask that clips the last pixel column of a digit is not a mask.
    const rect: Rect = {
      x: box.x - 2,
      y: box.y - 2,
      width: box.width + 4,
      height: box.height + 4,
    };
    fillRect(image, rect);
    regions.push({ descriptorRef: ref, reason: hit.reason, rect });
  }

  return {
    png: encodePng(image),
    manifest: {
      sourceScreenshot: options.sourceName,
      maskedRegions: regions,
      refused,
      observationId: options.observation.observationId,
    },
  };
}
