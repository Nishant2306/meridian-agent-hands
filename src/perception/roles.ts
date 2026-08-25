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
