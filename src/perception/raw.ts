import type { Box, PerceptionPath } from '../types/perception.js';

/**
 * The adapter-agnostic input to observation building.
 *
 * Everything surface-specific stops here. A Playwright adapter fills this in from Chrome's
 * accessibility tree plus a DOM enrichment pass; a desktop adapter would fill exactly the same
 * shape from a UI Automation tree walk. `buildObservation` is a pure function over this type, which
 * is what lets resolver tests run against a saved capture with no browser at all.
 */
export interface RawControl {
  /** The role exactly as the platform reported it, before any mapping. */
  axRole: string;
  name: string;
  value?: string;
  disabled: boolean;
  visible: boolean;
  /** The legacy-stable `name` attribute, if the element has one. */
  nameAttribute?: string;
  /** The element's own trimmed text. Used only to build an adapter addressing recipe. */
  ownText: string;
  box: Box;
  nearbyText: string[];
  containers: { axRole: string; name: string }[];
  rowCellTexts?: string[];
}

export interface RawFrameCapture {
  contextPath: string[];
  title: string;
  url: string;
  headings: string[];
  bodyText: string;
  controls: RawControl[];
}

export interface RawCapture {
  surfaceId: string;
  perceptionPath: PerceptionPath;
  frames: RawFrameCapture[];
}
