import { renderInventory } from '../perception/inventory.js';
import type { Observation, PerceivedControl } from '../types/perception.js';
import { foldCase, normalizeText } from '../types/normalize.js';

/**
 * ==============================================================================================
 * [MUST] THE MODEL BOUNDARY. Distinct from persistence redaction (PHASE 7).
 * ==============================================================================================
 *
 * Persistence redaction asks "what may be written down". This asks a different question: "what may
 * leave this process at all". They need separate answers, because a value can be perfectly fine to
 * keep in an internal log and still be something we would rather not hand to a third-party API.
 *
 * Four rules, applied before every model call:
 *
 *   1  SECRETS ARE NEVER SENT. The model proposes { kind: 'secretRef', name }; the executor
 *      resolves it. There is no path by which a secret value reaches a prompt.
 *
 *   2  A VALUE WE TYPED IS SHOWN AS ITS ORIGIN. When the executor types a declared parameter into
 *      a field, that field renders as [PARAM:memberId] rather than the value. The model asked for
 *      the parameter; it does not need the value back.
 *
 *   3  THE INVENTORY IS CAPPED to what is relevant to the current screen.
 *
 *   4  NO SCREENSHOTS in v1. Marks are numbers in text, so the model never has to read pixels.
 *
 * [MUST] AND THE RULE THAT MATTERS MOST, WHICH IS A RULE ABOUT WHAT *NOT* TO DO:
 *
 *   DO NOT BLIND-SUBSTITUTE OVER TEXT THE MODEL READS OFF THE PAGE.
 *
 * It is tempting to scan every observation for any string equal to a parameter value and replace
 * it. That corrupts the observation. Partial and coincidental matches are common - an account
 * number that CONTAINS the member id, a balance that happens to equal the deposit - and a model
 * shown "[PARAM:memberId]-01" where the screen said "10001-01" has been handed a lie about the
 * application. Substitution happens ONLY where the origin of a value is known, which means only
 * where WE typed it.
 *
 * The consequence is honest and worth stating plainly: sensitive values the model READS off the
 * page (a member's name, a balance) are sent as they appear. Pseudonymizing read-only sensitive
 * nodes is the next step for a real deployment, and it is written up in docs/DATA_HANDLING.md alongside
 * the provider data-processing and retention terms that would have to go with it.
 */

/** A control's identity ACROSS observations. Not a mark id, which is valid for exactly one. */
function controlKey(control: PerceivedControl): string {
  const stable = control.stableAttributes['name'];
  const frame = control.contextPath.join('>');
  if (stable !== undefined && stable !== '') return frame + '|attr:' + stable;
  return (
    frame +
    '|' +
    control.role +
    ':' +
    foldCase(normalizeText(control.nearbyText[0] ?? control.name))
  );
}

/**
 * Remembers which fields the EXECUTOR filled from which parameter.
 *
 * Origin, not content. That is what makes rule 2 safe to apply and rule 5 impossible to violate by
 * accident: nothing here can mask a value we did not put there ourselves.
 */
export class ValueOriginTracker {
  readonly #origins = new Map<string, string>();

  record(control: PerceivedControl, paramName: string): void {
    this.#origins.set(controlKey(control), paramName);
  }

  originOf(control: PerceivedControl): string | undefined {
    return this.#origins.get(controlKey(control));
  }

  /** Only masks a control we have a recorded origin for, and only when it holds something. */
  renderValue(control: PerceivedControl): string | undefined {
    const origin = this.originOf(control);
    if (origin === undefined) return control.value;
    if (control.value === undefined || control.value === '') return control.value;
    return '[PARAM:' + origin + ']';
  }
}

const INTERACTIVE = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio']);
const ALWAYS_KEEP = new Set(['alert', 'dialog', 'heading']);

/**
 * Cap the inventory to what matters on the current screen.
 *
 * Every interactive control is kept, wherever it is: the model has to be able to act on all of
 * them, and silently hiding one would make the screen look like it has no way forward. Alerts,
 * dialogs and headings are kept for the same reason in reverse - they are how the model knows
 * WHERE it is and whether something went wrong.
 *
 * What is dropped is passive content from frames that are not the working area: on this
 * application that removes the banner, the product name and the version marker repeated once per
 * frame, which is a third of the inventory and none of the information.
 */
export function relevantControls(observation: Observation): PerceivedControl[] {
  const counts = new Map<string, number>();
  for (const control of observation.controls) {
    const frame = control.contextPath.join('>');
    counts.set(frame, (counts.get(frame) ?? 0) + 1);
  }

  let workingFrame = '';
  let best = -1;
  for (const [frame, count] of counts) {
    if (count > best) {
      best = count;
      workingFrame = frame;
    }
  }

  return observation.controls.filter((control) => {
    if (INTERACTIVE.has(control.role) || ALWAYS_KEEP.has(control.role)) return true;
    return control.contextPath.join('>') === workingFrame;
  });
}

/** The exact text handed to the model for one screen. */
export function renderForModel(observation: Observation, tracker: ValueOriginTracker): string {
  return renderInventory(observation, {
    controls: relevantControls(observation),
    renderValue: (control) => tracker.renderValue(control),
  });
}
