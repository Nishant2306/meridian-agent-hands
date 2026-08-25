import type { Observation, ScreenIdentity } from '../types/perception.js';
import { normalizeText } from '../types/normalize.js';
import type { RawFrameCapture } from './raw.js';

/**
 * "MERIDIAN Core v3.2.1" and anything shaped like it.
 *
 * Deliberately generic rather than tenant-specific: the version marker is how compatibility is
 * checked, and a check that only works for the tenant it was written against is not a check.
 */
const VERSION_MARKER = /[A-Za-z][\w .-]*?\bv\d+(?:\.\d+){1,2}\b/;

export function extractVersionMarker(frames: readonly RawFrameCapture[]): string | undefined {
  for (const frame of frames) {
    const match = VERSION_MARKER.exec(frame.bodyText);
    if (match) return normalizeText(match[0]);
  }
  return undefined;
}

/**
 * The screen's human name.
 *
 * Rule: take the first heading of the frame carrying the most controls, and fall back to the top
 * document's first heading, then to the document title. On a framed legacy app the content frame
 * is where the work happens and it is reliably the busiest frame, so this picks "Member Search"
 * rather than "Servicing" from the navigation frame. Picking by frame NAME would work for this
 * application and break on the next one.
 */
export function deriveCanonicalScreenName(frames: readonly RawFrameCapture[]): string {
  const withHeadings = frames.filter((frame) => frame.headings.length > 0);

  let best: RawFrameCapture | undefined;
  for (const frame of withHeadings) {
    if (best === undefined || frame.controls.length > best.controls.length) best = frame;
  }

  const heading = best?.headings[0];
  if (heading !== undefined && heading !== '') return normalizeText(heading);

  const title = frames[0]?.title ?? '';
  return normalizeText(title);
}

export function buildScreenIdentity(frames: readonly RawFrameCapture[]): ScreenIdentity {
  const top = frames[0];
  const versionMarker = extractVersionMarker(frames);

  return {
    title: normalizeText(top?.title ?? ''),
    canonicalScreenName: deriveCanonicalScreenName(frames),
    contextPaths: frames.map((frame) => [...frame.contextPath]),
    headings: frames.flatMap((frame) => frame.headings.map(normalizeText)),
    ...(versionMarker === undefined ? {} : { versionMarker }),
    ...(top === undefined ? {} : { url: top.url }),
  };
}

function samePaths(a: readonly string[][], b: readonly string[][]): boolean {
  const key = (paths: readonly string[][]): string =>
    [...paths.map((path) => path.join('/'))].sort().join('|');
  return key(a) === key(b);
}

/**
 * [MUST] Stale proposal rejection uses SCREEN CONTEXT, not just resolution.
 *
 * Re-resolving a descriptor does not catch a page change on its own. A different screen may also
 * contain a button named "Continue", or "Search", or "Open" - this application has several. The
 * descriptor resolves, the click lands, and the run proceeds confidently on the wrong screen.
 *
 * So before a converted proposal is resolved, the screen it was FORMED against is compared with
 * the screen in front of us now. Incompatible means the proposal is stale: reject it with
 * STALE_OBSERVATION_CONTEXT, re-observe, and continue the loop. That code is a ProposalRejection,
 * not an ErrorCode, because the loop recovers from it.
 *
 * What is compared: document title, canonical screen name, and the set of frame paths.
 * What is NOT compared, and why:
 *   url       /search?q=10001 and /search?q=10002 are the same screen. Comparing URLs would reject
 *             every legitimate proposal on any parameterized page.
 *   headings  data-dependent. A results heading that counts rows changes when the data changes,
 *             while the screen does not.
 */
export function isCompatibleScreenContext(a: Observation, b: Observation): boolean {
  const left = a.screenIdentity;
  const right = b.screenIdentity;

  return (
    left.title === right.title &&
    left.canonicalScreenName === right.canonicalScreenName &&
    samePaths(left.contextPaths, right.contextPaths)
  );
}
