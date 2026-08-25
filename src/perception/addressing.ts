/**
 * How the ADAPTER points at a control it has already perceived.
 *
 * This is transport, not resolution. Resolution decides WHICH control the descriptor means, using
 * role, accessible name and nearby text; addressing is how the browser is then told to click that
 * specific element. The two are kept apart on purpose: the resolver stays pure and surface
 * independent, and nothing in an artifact ever contains one of these recipes.
 *
 * Recipes, strongest first:
 *   attribute  the legacy-stable `name=` attribute. Every form control in this application has one
 *              and the server's form handling depends on it, so it does not drift. This is the same
 *              signal as the T4 adapter hint, used here as a handle rather than as evidence.
 *   role       role plus accessible name, positionally disambiguated. Pure accessibility.
 *   text       exact visible text. The fallback for cells in presentational tables, which have no
 *              role and no name but do have the value we need to read.
 *   none       perceived but not addressable. It can still be observed and asserted on; it cannot
 *              be acted on.
 *
 * Every recipe is REVALIDATED against the perceived control immediately before the action fires. A
 * recipe that has drifted onto a different element fails the action instead of clicking the wrong
 * thing.
 */
export type AddressingRecipe =
  | { kind: 'attribute'; attribute: string; value: string }
  | { kind: 'role'; ariaRole: string; name?: string; index: number }
  | { kind: 'text'; text: string; index: number }
  | { kind: 'none' };

export interface AdapterAddressing {
  readonly markId: number;
  readonly contextPath: readonly string[];
  readonly recipe: AddressingRecipe;
  /** What revalidation expects to find. A mismatch aborts the action. */
  readonly expectedName: string;
  readonly expectedNameAttribute?: string;
}
