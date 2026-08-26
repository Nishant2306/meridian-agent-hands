import type { ControlRole } from '../types/control.js';

/**
 * Platform role -> our closed vocabulary. `null` means "do not put this in the inventory".
 *
 * Two exclusions are worth explaining, because both are deliberate and both shrink the inventory a
 * lot on a legacy screen:
 *
 *   StaticText  Every label, every table caption and every word of prose is a StaticText node. On
 *               this fixture that would roughly triple the inventory while adding nothing the model
 *               can act on: the same text already reaches it as a control's accessible name or as
 *               that control's nearbyText. Prose that stands alone still arrives, as `paragraph`.
 *
 *   LayoutTable Chrome reports presentational tables as LayoutTable / LayoutTableRow. A layout
 *   LayoutTableRow  table has no semantics to offer, which is exactly what makes it a layout table.
 *               Its CELLS are kept, because on this app the cell to the left of an input is the
 *               only label that input has.
 */
const ROLE_MAP: Readonly<Record<string, ControlRole | null>> = {
  button: 'button',
  link: 'link',
  textbox: 'textbox',
  searchbox: 'textbox',
  combobox: 'combobox',
  listbox: 'combobox',
  menulistpopup: 'combobox',
  checkbox: 'checkbox',
  radio: 'radio',
  heading: 'heading',
  cell: 'cell',
  gridcell: 'cell',
  columnheader: 'cell',
  rowheader: 'cell',
  layouttablecell: 'cell',
  row: 'row',
  layouttablerow: null,
  table: 'table',
  grid: 'table',
  layouttable: null,
  dialog: 'dialog',
  alertdialog: 'dialog',
  alert: 'alert',
  region: 'region',
  main: 'region',
  navigation: 'region',
  form: 'region',
  list: 'list',
  listitem: 'listitem',
  paragraph: 'text',
  statictext: null,
  labeltext: null,
  generic: null,
  none: null,
  presentation: null,
  ignored: null,
  rootwebarea: null,
  iframe: null,
  image: null,
};

export function mapAxRole(axRole: string): ControlRole | null {
  return ROLE_MAP[axRole.toLowerCase()] ?? null;
}

/**
 * Roles Playwright's `getByRole` can address. Used to build the adapter's transport recipe, never
 * for resolution. Anything outside this set falls back to a text-based recipe.
 */
export const ADDRESSABLE_ARIA_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'row',
  'table',
  'grid',
  'dialog',
  'alertdialog',
  'alert',
  'region',
  'main',
  'navigation',
  'form',
  'list',
  'listitem',
  'paragraph',
]);

/**
 * ================================================================================================
 * ROLES WHOSE ACCESSIBLE NAME COMES FROM THEIR OWN CONTENT (ARIA "name from content").
 * ================================================================================================
 *
 * This set exists because of a real GATE 1 failure, and the failure is worth stating precisely
 * because it is the kind that hides between two layers that are each behaving correctly.
 *
 * A `<p>Member Name: Avery Lin (10001)</p>` maps to `paragraph`, which IS addressable by
 * `getByRole`. Chrome's full accessibility tree reports a NAME for that node - its text - so
 * perception saw `role=paragraph name="Member Name: Avery Lin (10001)"` and the addressing recipe
 * asked for role plus name. But ARIA does not give `paragraph` a name from its content, so
 * Playwright computes its accessible name as EMPTY, and the recipe matched nothing:
 *
 *     getByRole('paragraph')                                  -> 1
 *     getByRole('paragraph', { name: <the text>, exact: true }) -> 0     <- the bug
 *     getByText(<the text>, { exact: true })                  -> 1
 *
 * The control was perceived, the descriptor resolved, and the transport could not point at it. The
 * model was told "the control is no longer present on the screen", which sent it looking for a
 * screen problem that did not exist, and it retried the same thing until the loop stopped it.
 *
 * So a name only goes into a role recipe when the name is one `getByRole` will also compute:
 * either the role takes its name from content, or the name demonstrably came from somewhere else
 * (a label or aria-label), which shows up as a name that is not simply the node's own text.
 */
export const ROLES_NAMED_FROM_CONTENT: ReadonlySet<string> = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'listitem',
  'radio',
  'row',
  'rowheader',
]);

/**
 * Truncation priority. Lower survives.
 *
 * 0 interactive  the things an action can address. Never dropped while anything else remains.
 * 1 signal       headings, alerts, dialogs. What tells you WHICH screen you are on and what went
 *                wrong; dropping these first would blind the model to error banners.
 * 2 structural   tables, rows, cells, lists, prose. Context, not targets.
 */
export function rolePriority(role: ControlRole): 0 | 1 | 2 {
  switch (role) {
    case 'button':
    case 'link':
    case 'textbox':
    case 'combobox':
    case 'checkbox':
    case 'radio':
      return 0;
    case 'heading':
    case 'alert':
    case 'dialog':
      return 1;
    default:
      return 2;
  }
}
