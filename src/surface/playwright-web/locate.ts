import type { Frame, Locator, Page } from 'playwright';
import type { AriaRole } from './aria.js';
import type { AdapterAddressing } from '../../perception/addressing.js';
import { frameContextPath } from './extract.js';

/**
 * Turn an addressing recipe into a live Playwright locator.
 *
 * This is TRANSPORT. Nothing here decides which control the descriptor meant; that already
 * happened, in the one resolver, using role, accessible name and nearby text. This function only
 * points the browser at the element that resolution already chose, and the result is checked
 * against what was perceived before anything is clicked.
 */
export async function findFrame(
  page: Page,
  contextPath: readonly string[],
): Promise<Frame | undefined> {
  for (const frame of page.frames()) {
    const path = await frameContextPath(frame);
    if (path.length === contextPath.length && path.every((part, i) => part === contextPath[i])) {
      return frame;
    }
  }
  return undefined;
}

export interface LocatedControl {
  base: Locator;
  target: Locator;
  /** How many elements the recipe matched. Anything but 1 for an attribute recipe is a red flag. */
  matchCount: number;
}

export async function locate(
  frame: Frame,
  addressing: AdapterAddressing,
): Promise<LocatedControl | null> {
  const recipe = addressing.recipe;

  if (recipe.kind === 'none') return null;

  if (recipe.kind === 'attribute') {
    // JSON.stringify quotes and escapes the value, so an attribute containing quotes or the
    // dollar signs that ASP name attributes are full of cannot break out of the selector.
    const base = frame.locator('[' + recipe.attribute + '=' + JSON.stringify(recipe.value) + ']');
    const matchCount = await base.count();
    return { base, target: base.first(), matchCount };
  }

  if (recipe.kind === 'role') {
    const base =
      recipe.name === undefined
        ? frame.getByRole(recipe.ariaRole as AriaRole)
        : frame.getByRole(recipe.ariaRole as AriaRole, { name: recipe.name, exact: true });
    const matchCount = await base.count();
    return { base, target: base.nth(recipe.index), matchCount };
  }

  const base = frame.getByText(recipe.text, { exact: true });
  const matchCount = await base.count();
  return { base, target: base.nth(recipe.index), matchCount };
}

/**
 * Step 6 of the input path: REVALIDATE immediately before acting.
 *
 * The recipe was built from an observation taken moments ago. Between then and now the page may
 * have re-rendered, a row may have moved, or a positional index may now point somewhere else. So
 * before the input event fires we check that what the recipe currently points at is still the
 * control we perceived: still present, still unique enough, still visible, and still carrying the
 * same legacy name attribute.
 *
 * HONESTY: this MINIMIZES the resolve/act race. It does not eliminate it. The page can still
 * change between this check and the event on the next line, and no browser API closes that gap.
 * What the check does buy is that a control which has ALREADY drifted fails the action instead of
 * being clicked.
 */
export async function revalidate(
  located: LocatedControl,
  addressing: AdapterAddressing,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const recipe = addressing.recipe;

  if (located.matchCount === 0) {
    return { ok: false, reason: 'the control is no longer present on the screen' };
  }
  if (recipe.kind === 'attribute' && located.matchCount > 1) {
    return {
      ok: false,
      reason:
        'the stable attribute now matches ' +
        located.matchCount +
        ' controls, so it no longer ' +
        'identifies one',
    };
  }
  if ((recipe.kind === 'role' || recipe.kind === 'text') && located.matchCount <= recipe.index) {
    return {
      ok: false,
      reason:
        'the screen now has ' +
        located.matchCount +
        ' matching controls, fewer than the ' +
        'position (' +
        recipe.index +
        ') the control was perceived at',
    };
  }
  if (!(await located.target.isVisible())) {
    return { ok: false, reason: 'the control is no longer visible' };
  }

  if (addressing.expectedNameAttribute !== undefined) {
    const actual = await located.target.getAttribute('name');
    if (actual !== addressing.expectedNameAttribute) {
      return {
        ok: false,
        reason:
          'the control at this position now carries name="' +
          String(actual) +
          '" but was ' +
          'perceived as name="' +
          addressing.expectedNameAttribute +
          '"',
      };
    }
  }

  return { ok: true };
}
