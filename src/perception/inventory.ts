import type { Observation, PerceivedControl } from '../types/perception.js';

/**
 * The compact rendering handed to the model. One line per control:
 *
 *   [12] textbox  "Member ID"  near: "Member Search" | "Member ID"
 *   [13] button   "Search"
 *
 * Controls are grouped by frame, because on a framed legacy application "which frame" is part of
 * knowing where you are, and a flat list silently mixes the navigation menu into the form.
 *
 * NOTE: no screenshot is sent to the model in v1. Screenshots are captured for EVIDENCE only.
 * Marks are numbers in this text, not boxes drawn on an image, so the model never has to read
 * pixels to pick a control.
 */
const ROLE_COLUMN = 9;

/**
 * How a control's value is shown. Returning a replacement hides the real value.
 *
 * This is the hook the MODEL BOUNDARY uses: when the executor typed a declared parameter into a
 * field, the model is shown `[PARAM:memberId]` rather than the value it already asked for. See
 * src/agent/boundary.ts for why this only ever applies where the origin of a value is KNOWN.
 */
export interface InventoryRenderOptions {
  controls?: readonly PerceivedControl[];
  renderValue?: (control: PerceivedControl) => string | undefined;
}

function renderControl(control: PerceivedControl, options: InventoryRenderOptions): string {
  const parts = [`[${control.markId}]`, control.role.padEnd(ROLE_COLUMN), `"${control.name}"`];

  const shown = options.renderValue?.(control) ?? control.value;
  if (shown !== undefined && shown !== '') parts.push(`= "${shown}"`);
  if (!control.enabled) parts.push('(disabled)');
  if (control.nearbyText.length > 0) {
    parts.push(`near: ${control.nearbyText.map((text) => `"${text}"`).join(' | ')}`);
  }

  return parts.join(' ');
}

export function renderInventory(
  observation: Observation,
  options: InventoryRenderOptions = {},
): string {
  const lines: string[] = [];
  const identity = observation.screenIdentity;

  lines.push(`screen:  ${identity.canonicalScreenName}`);
  lines.push(`title:   ${identity.title}`);
  if (identity.versionMarker !== undefined) lines.push(`version: ${identity.versionMarker}`);
  lines.push(`path:    ${observation.perceptionPath}`);

  const byFrame = new Map<string, PerceivedControl[]>();
  for (const control of options.controls ?? observation.controls) {
    const key = control.contextPath.join(' > ') || '(top document)';
    const bucket = byFrame.get(key);
    if (bucket === undefined) byFrame.set(key, [control]);
    else bucket.push(control);
  }

  for (const [frame, controls] of byFrame) {
    lines.push('');
    lines.push(`frame: ${frame}`);
    for (const control of controls) lines.push(renderControl(control, options));
  }

  if (observation.truncation.kept < observation.truncation.perceived) {
    lines.push('');
    lines.push(
      `note: inventory truncated, ${observation.truncation.kept} of ` +
        `${observation.truncation.perceived} controls shown ` +
        `(dropped roles: ${observation.truncation.droppedByPriority.join(', ')})`,
    );
  }

  return lines.join('\n');
}
