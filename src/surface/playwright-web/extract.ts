import type { BrowserContext, CDPSession, Frame, Page } from 'playwright';
import type { PerceptionPath } from '../../types/perception.js';
import type { RawCapture, RawControl, RawFrameCapture } from '../../perception/raw.js';
import { mapAxRole } from '../../perception/roles.js';

/**
 * ==============================================================================================
 * ACCESSIBILITY-FIRST, NOT ACCESSIBILITY-ONLY.
 * ==============================================================================================
 *
 * The PRIMARY path is Chrome own accessibility tree, read through CDP
 * (Accessibility.getFullAXTree). That is where role, accessible name and value come from, and it
 * is the half of perception that would look identical against a desktop UI Automation tree.
 *
 * The AX tree does not carry three things this application makes essential, so each perceived
 * control is then ENRICHED from the DOM:
 *
 *   nearbyText        the cell to the LEFT is the only label these inputs have
 *   name attribute    the one attribute on this app that survives a restart
 *   bounding box      needed for PHASE 7 screenshot masking, never for locating
 *
 * That enrichment is what "not AX-only" means in practice. If the AX tree is unavailable at all we
 * fall back to Playwright aria snapshot, which is DEGRADED (role and name only) and is recorded as
 * such on the observation, so nobody has to guess which path produced a given capture.
 *
 * NOTE: nothing here mutates the page. No injected attributes, no markers, no test hooks. A
 * perception layer that has to modify the application in order to see it is not a perception layer.
 */

/** Enough of the CDP accessibility payload to read; Playwright protocol types stay internal. */
interface AxValue {
  value?: unknown;
}

interface FrameTreeNode {
  frame: { id: string; url?: string; name?: string };
  childFrames?: FrameTreeNode[];
}

interface AxNode {
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  backendDOMNodeId?: number;
}

interface EnrichResult {
  contextPath: string[];
  /** True when this node contains a nested table, i.e. it is an outer layout wrapper. */
  wrapsTable: boolean;
  /** True when this node wraps a control that is itself in the inventory. */
  containsInteractive: boolean;
  visible: boolean;
  disabled: boolean;
  nameAttribute?: string;
  ownText: string;
  box: { x: number; y: number; width: number; height: number };
  nearbyText: string[];
  containers: { axRole: string; name: string }[];
  rowCellTexts?: string[];
  value?: string;
}

/** Hard ceiling on per-frame enrichment round trips, so a pathological page cannot hang a run. */
const MAX_ENRICHED_NODES = 400;

const ENRICH_FUNCTION = `
function enrich() {
  var el = this;
  var doc = el.ownerDocument;
  var win = doc.defaultView;
  var rect = el.getBoundingClientRect();
  var style = win.getComputedStyle(el);
  var visible =
    style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;

  var clean = function (value) {
    if (value === null || value === undefined) return '';
    return String(value).trim().slice(0, 200);
  };

  var nearby = [];
  var push = function (value) {
    var text = clean(value);
    if (text !== '' && nearby.indexOf(text) === -1) nearby.push(text);
  };

  var cell = el.closest ? el.closest('td,th') : null;

  // LEFT: the nearest non-empty cell to the left in the same row. On this application that IS the
  // form label, because the label is not wired to the input with a for attribute.
  if (cell) {
    var previous = cell.previousElementSibling;
    while (previous && clean(previous.textContent) === '') {
      previous = previous.previousElementSibling;
    }
    if (previous) push(previous.textContent);
  }

  // An explicit label, on the rare screens that provide one.
  if (el.id && doc.querySelector) {
    var escaped = win.CSS && win.CSS.escape ? win.CSS.escape(el.id) : el.id;
    var label = doc.querySelector('label[for="' + escaped + '"]');
    if (label) push(label.textContent);
  }
  var wrapping = el.closest ? el.closest('label') : null;
  if (wrapping) push(wrapping.textContent);

  // ABOVE: the column header for this cell.
  if (cell && cell.parentElement) {
    var row = cell.parentElement;
    var index = Array.prototype.indexOf.call(row.children, cell);
    var table = el.closest('table');
    var headRow = table ? table.querySelector('thead tr') : null;
    if (headRow && headRow.children[index]) push(headRow.children[index].textContent);
  }

  // ABOVE: the nearest heading that precedes this element. 2 is DOCUMENT_POSITION_PRECEDING.
  var headings = Array.prototype.slice.call(doc.querySelectorAll('h1,h2,h3,h4,h5,h6'));
  var preceding = null;
  for (var h = 0; h < headings.length; h++) {
    if ((el.compareDocumentPosition(headings[h]) & 2) !== 0) preceding = headings[h];
  }
  if (preceding) push(preceding.textContent);

  var containers = [];
  var node = el.parentElement;
  while (node && containers.length < 8) {
    var tag = node.tagName ? node.tagName.toLowerCase() : '';
    var explicit = node.getAttribute ? node.getAttribute('role') : null;
    var role = explicit || '';
    if (role === '') {
      if (tag === 'table') role = node.querySelector('th') ? 'table' : 'LayoutTable';
      else if (tag === 'tr') role = 'row';
      else if (tag === 'td' || tag === 'th') role = 'cell';
      else if (tag === 'ul' || tag === 'ol') role = 'list';
      else if (tag === 'li') role = 'listitem';
      else if (tag === 'form' || tag === 'main' || tag === 'nav') role = 'region';
      else if (tag === 'dialog') role = 'dialog';
    }
    if (role !== '') {
      var caption = node.querySelector ? node.querySelector('caption') : null;
      var ariaLabel = node.getAttribute ? node.getAttribute('aria-label') : null;
      containers.push({ axRole: role, name: clean(ariaLabel || (caption ? caption.textContent : '')) });
    }
    node = node.parentElement;
  }

  var rowCellTexts = undefined;
  var tr = el.closest ? el.closest('tr') : null;
  if (tr) {
    rowCellTexts = Array.prototype.slice
      .call(tr.children)
      .map(function (child) { return clean(child.textContent); })
      .filter(function (text) { return text !== ''; });
  }

  var value = undefined;
  var ownTag = el.tagName ? el.tagName.toLowerCase() : '';
  if (ownTag === 'select') {
    var option = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    value = option ? clean(option.textContent) : clean(el.value);
  } else if (ownTag === 'input' || ownTag === 'textarea') {
    // A password field never yields its value to perception. There is no redaction step to trust
    // if the secret was never read in the first place.
    value = el.type === 'password' ? '' : clean(el.value);
  }

  var nameAttribute = el.getAttribute ? el.getAttribute('name') : null;

  // The frame path is computed HERE, from the element own window chain, because one page-level
  // accessibility tree covers every same-process iframe and the nodes have to be grouped back into
  // frames afterwards.
  var framePath = [];
  var w = win;
  while (w && w.parent && w.parent !== w) {
    var frameEl = null;
    try {
      frameEl = w.frameElement;
    } catch (e) {
      frameEl = null;
    }
    if (!frameEl) break;
    framePath.unshift(frameEl.getAttribute('name') || frameEl.getAttribute('title') || 'frame');
    w = w.parent;
  }

  return {
    contextPath: framePath,
    wrapsTable: Boolean(el.querySelector && el.querySelector('table')),
    containsInteractive: Boolean(
      el.querySelector && el.querySelector('a,button,input,select,textarea')
    ),
    visible: visible,
    disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
    nameAttribute: nameAttribute === null ? undefined : nameAttribute,
    ownText: clean(el.textContent),
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    nearbyText: nearby,
    containers: containers,
    rowCellTexts: rowCellTexts,
    value: value
  };
}
`;

const FRAME_SUMMARY = `(() => ({
  headings: Array.prototype.slice
    .call(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .map((node) => (node.textContent || '').trim())
    .filter((text) => text !== ''),
  bodyText: document.body ? (document.body.innerText || '').slice(0, 4000) : ''
}))()`;

export async function frameContextPath(frame: Frame): Promise<string[]> {
  const path: string[] = [];
  let current: Frame | null = frame;

  while (current !== null && current.parentFrame() !== null) {
    const element = await current.frameElement();
    const name =
      (await element.getAttribute('name')) ?? (await element.getAttribute('title')) ?? 'frame';
    await element.dispose();
    path.unshift(name);
    current = current.parentFrame();
  }

  return path;
}

async function frameSummary(frame: Frame): Promise<{ headings: string[]; bodyText: string }> {
  return (await frame.evaluate(FRAME_SUMMARY)) as { headings: string[]; bodyText: string };
}

function debugPerception(message: string, error: unknown): void {
  // A silent fallback is a lie by omission during development, so the reason is available on
  // demand rather than swallowed.
  if (process.env['PERCEPTION_DEBUG'] === '1') console.warn('[perception] ' + message, error);
}

function pathKey(contextPath: readonly string[]): string {
  return contextPath.join(' > ');
}

/**
 * Read the accessibility tree for the WHOLE page through one CDP session, and group the result
 * back into frames.
 *
 * One session, not one per frame: in Chromium a same-process iframe has no CDP session of its own,
 * it is part of its parent. Asking for one throws. A cross-origin iframe DOES get its own session,
 * and that case is handled separately below.
 *
 * DOM.getDocument with pierce:true is not optional. Backend node ids are only populated once the
 * document has been requested, and without pierce the ids inside iframes are missing, so every
 * resolveNode inside a frame fails and perception falls back to the degraded path while the
 * accessibility tree was available the whole time.
 */
function collectFrameIds(node: FrameTreeNode, into: string[]): void {
  into.push(node.frame.id);
  for (const child of node.childFrames ?? []) collectFrameIds(child, into);
}

/**
 * Structural nodes that carry nothing.
 *
 * A screen built out of nested tables produces a row or a cell around every single thing on it. A
 * numbered inventory full of unnamed rows and wrapper cells is worse than a shorter one: the model
 * has to choose from it, and every empty line is a chance to choose wrong.
 *
 * So a structural node is dropped when it has nothing of its own to offer:
 *   - it merely WRAPS a control that is already in the inventory under its own role
 *   - a CONTAINER (row, table, list, region) with no accessible name: its content is its children,
 *     which are in the inventory already, so the container line is pure duplication
 *   - a CELL with neither a name nor any text of its own: nothing to read, nothing to match on
 *
 * Interactive controls, headings and alerts are never dropped by this rule.
 */
const CONTAINER_AX_ROLES: ReadonlySet<string> = new Set([
  'row',
  'table',
  'grid',
  'list',
  'listitem',
  'region',
  'main',
  'navigation',
  'form',
]);

const INTERACTIVE_AX_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
]);

/**
 * Roles whose PRESENCE is the information, whatever they happen to contain.
 *
 * The `containsInteractive` rule below is right for a generic wrapper - it adds a line and no
 * information, because the control inside it is already listed. It is WRONG for these three: a
 * dialog is not a wrapper around its OK button, it is the fact that the screen is blocked, and an
 * alert region is not a wrapper around its Retry link, it is the fact that something was rejected.
 *
 * Found in PHASE 6. The unrecognised-modal fixture rendered a real `<dialog open>`, Chrome's
 * accessibility tree reported it as `dialog`, and the inventory dropped it - because it contained
 * a button. The needs_human rung depends on seeing a blocking dialog, so it could never fire.
 *
 * `alert` was the same latent bug: `APPLICATION_VALIDATION_REJECTED` is detected STRUCTURALLY by
 * the alert region, and today's validation banner is text-only, so it survives. An alert carrying
 * a "Retry" button would have vanished, and the detector would have silently stopped working on
 * exactly the screens where it mattered most.
 */
const PRESENCE_IS_SIGNAL_AX_ROLES: ReadonlySet<string> = new Set([
  'dialog',
  'alertdialog',
  'alert',
]);

function isNoiseStructure(axRole: string, node: AxNode, enrichment: EnrichResult): boolean {
  const role = axRole.toLowerCase();

  // Anything the model can act on is never dropped, whatever it looks like structurally.
  if (INTERACTIVE_AX_ROLES.has(role)) return false;

  // See above: these say something no child of theirs can say.
  if (PRESENCE_IS_SIGNAL_AX_ROLES.has(role)) return false;

  // A wrapper around a control adds a line and no information: the control is already listed.
  if (enrichment.containsInteractive) return true;

  const name = (typeof node.name?.value === 'string' ? node.name.value : '').trim();
  if (CONTAINER_AX_ROLES.has(role)) return name === '';

  // Cells, paragraphs and other leaf structure earn their line only by having something to read.
  return name === '' && enrichment.ownText === '';
}

async function enrichNodes(
  session: CDPSession,
  nodes: readonly AxNode[],
  byFrame: Map<string, RawControl[]>,
  budget: { remaining: number },
): Promise<void> {
  for (const node of nodes) {
    if (budget.remaining <= 0) return;
    if (node.ignored === true) continue;

    const axRole = typeof node.role?.value === 'string' ? node.role.value : '';
    if (axRole === '' || mapAxRole(axRole) === null) continue;

    const backendNodeId = node.backendDOMNodeId;
    if (backendNodeId === undefined) continue;

    let objectId: string | undefined;
    try {
      const resolved = (await session.send('DOM.resolveNode', { backendNodeId })) as unknown as {
        object?: { objectId?: string };
      };
      objectId = resolved.object?.objectId;
    } catch {
      continue;
    }
    if (objectId === undefined) continue;

    budget.remaining -= 1;

    const evaluated = (await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: ENRICH_FUNCTION,
      returnByValue: true,
    })) as unknown as { result?: { value?: EnrichResult } };

    await session.send('Runtime.releaseObject', { objectId }).catch(() => undefined);

    const enrichment = evaluated.result?.value;
    if (enrichment === undefined) continue;

    // An outer layout wrapper that contains another table is scaffolding, not content. Dropping it
    // removes most of the noise a table-built legacy screen generates, without losing a single
    // thing that can be acted on or read.
    if (enrichment.wrapsTable) continue;
    if (isNoiseStructure(axRole, node, enrichment)) continue;

    // Chrome computes no accessible name for a paragraph, so a block of prose arrives nameless and
    // renders as an empty line in the inventory. For a NON-INTERACTIVE node its visible text is its
    // name in every sense that matters here, so it is used as one. Interactive controls are left
    // alone: a button with no accessible name is a real finding, not something to paper over.
    const reportedName = typeof node.name?.value === 'string' ? node.name.value : '';
    const axName =
      reportedName !== '' || INTERACTIVE_AX_ROLES.has(axRole.toLowerCase())
        ? reportedName
        : enrichment.ownText;
    const axValue = typeof node.value?.value === 'string' ? node.value.value : undefined;
    const resolvedValue = enrichment.value ?? axValue;

    const control: RawControl = {
      axRole,
      name: axName,
      ...(resolvedValue === undefined ? {} : { value: resolvedValue }),
      disabled: enrichment.disabled,
      visible: enrichment.visible,
      ...(enrichment.nameAttribute === undefined
        ? {}
        : { nameAttribute: enrichment.nameAttribute }),
      ownText: enrichment.ownText,
      box: enrichment.box,
      nearbyText: enrichment.nearbyText,
      containers: enrichment.containers,
      ...(enrichment.rowCellTexts === undefined ? {} : { rowCellTexts: enrichment.rowCellTexts }),
    };

    const key = pathKey(enrichment.contextPath);
    const bucket = byFrame.get(key);
    if (bucket === undefined) byFrame.set(key, [control]);
    else bucket.push(control);
  }
}

/**
 * Read the accessibility tree for every frame of a page through ONE CDP session.
 *
 * Three things here are not obvious and all three were found the hard way:
 *
 *   ONE SESSION, NOT ONE PER FRAME. In Chromium a same-process iframe has no CDP session of its
 *   own, it is part of its parent, and asking for one throws. A cross-origin iframe DOES get its
 *   own session, and that case is handled by the caller.
 *
 *   getFullAXTree RETURNS ONE FRAME AT A TIME. Called with no argument it returns the MAIN frame
 *   tree only; iframe content is simply absent, and the result looks like a page with no controls
 *   on it rather than like an error. So the frame ids come from Page.getFrameTree and each frame
 *   subtree is requested explicitly.
 *
 *   DOM.getDocument WITH pierce:true IS NOT OPTIONAL. Backend node ids are only populated once the
 *   document has been requested, and without pierce the ids inside iframes are missing, so every
 *   resolveNode inside a frame fails and perception falls back to the degraded path while the
 *   accessibility tree was available the whole time.
 */
async function axControlsByFrame(session: CDPSession): Promise<Map<string, RawControl[]>> {
  await session.send('Page.enable');
  await session.send('DOM.enable');
  await session.send('DOM.getDocument', { depth: -1, pierce: true });
  await session.send('Accessibility.enable');

  const { frameTree } = (await session.send('Page.getFrameTree')) as unknown as {
    frameTree: FrameTreeNode;
  };

  const frameIds: string[] = [];
  collectFrameIds(frameTree, frameIds);

  const byFrame = new Map<string, RawControl[]>();
  const budget = { remaining: MAX_ENRICHED_NODES };

  for (const frameId of frameIds) {
    if (budget.remaining <= 0) break;
    try {
      const tree = (await session.send('Accessibility.getFullAXTree', { frameId })) as unknown as {
        nodes: AxNode[];
      };
      await enrichNodes(session, tree.nodes, byFrame, budget);
    } catch (error) {
      debugPerception('no accessibility tree for frame ' + frameId + ':', error);
    }
  }

  return byFrame;
}

/**
 * The DEGRADED fallback. Role and name only: no nearby text, no boxes, no stable attributes.
 *
 * It exists so that an application whose accessibility tree cannot be read is still partially
 * operable rather than completely opaque, and every observation it produces is stamped
 * `aria_snapshot`, so a thin inventory is never mistaken for a thin screen.
 */
async function ariaSnapshotControls(frame: Frame): Promise<RawControl[]> {
  const snapshot = await frame.locator('body').ariaSnapshot();
  const controls: RawControl[] = [];

  for (const line of snapshot.split(String.fromCharCode(10))) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- ')) continue;

    const rest = trimmed.slice(2);
    const firstSpace = rest.indexOf(' ');
    const rawRole = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)).replace(':', '');
    if (mapAxRole(rawRole) === null) continue;

    const open = rest.indexOf('"');
    const close = rest.lastIndexOf('"');
    const name = open >= 0 && close > open ? rest.slice(open + 1, close) : '';

    controls.push({
      axRole: rawRole,
      name,
      disabled: false,
      visible: true,
      ownText: name,
      box: { x: 0, y: 0, width: 0, height: 0 },
      nearbyText: [],
      containers: [],
    });
  }

  return controls;
}

/**
 * An IIFE EXPRESSION, not a function declaration.
 *
 * `frame.evaluate(string)` evaluates the string as an EXPRESSION and returns its value. Handed a
 * declaration it produces a function object, which is not serializable, so the call throws - and
 * the throw is caught, the offset is reported unknown, and every box silently stays in frame
 * coordinates. That failure is invisible until a mask lands in the wrong place.
 */
const FRAME_OFFSET_EXPRESSION = `(function () {
  var x = 0;
  var y = 0;
  var win = window;
  while (win.parent !== win) {
    var element = win.frameElement;
    if (element === null) return null;
    var rect = element.getBoundingClientRect();
    x += rect.x;
    y += rect.y;
    win = win.parent;
  }
  return { x: x, y: y };
})()`;

/**
 * Where this frame's viewport sits inside the TOP-LEVEL page, in CSS pixels.
 *
 * [MUST] Boxes come from `getBoundingClientRect()` INSIDE the frame, so they are relative to that
 * frame's own document. On this application every control worth masking lives in `contentFrame`,
 * which is nested inside a layout table - so an unoffset box lands tens of pixels up and to the
 * left of the thing it was meant to cover, and the screenshot looks masked while the value is still
 * legible next to a black rectangle. That is the worst possible outcome: a redaction that reads as
 * one and is not.
 *
 * Walks up through `frameElement`, which works for the same-origin frames this application uses.
 * A cross-origin frame throws on access; the offset is then reported as UNKNOWN rather than zero,
 * because zero is a coordinate and would silently produce the misplaced-mask failure above.
 */
/**
 * Cached per frame, because computing it is a CDP round trip and observation is the hot path.
 *
 * PHASE 7 added this and PHASE 8 measured what it cost: `observe()` went from 45ms to 195ms, and
 * since a replay observes dozens of times, the whole suite went from about 2 minutes to over 6.
 * Three round trips per observation, for a number that had not changed.
 *
 * The offset is the position of the frame ELEMENT inside its parent's layout. In this application
 * that is fixed by the shell: the content changes, the frameset geometry does not. So it is
 * recomputed only when the frame's own URL or its parent's URL changes - a navigation, which is
 * exactly when the layout could have moved. A WeakMap keyed by the frame object means a frame that
 * goes away takes its entry with it.
 */
const FRAME_OFFSETS = new WeakMap<
  Frame,
  { url: string; parentUrl: string; offset: { x: number; y: number } | 'unknown' }
>();

async function frameOffset(frame: Frame): Promise<{ x: number; y: number } | 'unknown'> {
  const parent = frame.parentFrame();
  if (parent === null) return { x: 0, y: 0 };

  const url = frame.url();
  const parentUrl = parent.url();
  const cached = FRAME_OFFSETS.get(frame);
  if (cached !== undefined && cached.url === url && cached.parentUrl === parentUrl) {
    return cached.offset;
  }

  const computed = await computeFrameOffset(frame);
  FRAME_OFFSETS.set(frame, { url, parentUrl, offset: computed });
  return computed;
}

async function computeFrameOffset(frame: Frame): Promise<{ x: number; y: number } | 'unknown'> {
  try {
    // Passed as a STRING for the same reason ENRICH_FUNCTION is: this module is compiled without
    // the DOM lib, deliberately, so that nothing in the perception layer can reach for a browser
    // global by accident.
    const offset = (await frame.evaluate(FRAME_OFFSET_EXPRESSION)) as {
      x: number;
      y: number;
    } | null;
    return offset ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function captureRaw(
  page: Page,
  context: BrowserContext,
  surfaceId: string,
): Promise<RawCapture> {
  const frames = page
    .frames()
    .filter((frame) => !(frame.url() === 'about:blank' && frame.parentFrame() !== null));

  let perceptionPath: PerceptionPath = 'cdp_ax';
  let byFrame = new Map<string, RawControl[]>();

  const pageSession = await context.newCDPSession(page);
  try {
    byFrame = await axControlsByFrame(pageSession);
  } catch (error) {
    debugPerception('page-level accessibility tree unavailable:', error);
    perceptionPath = 'aria_snapshot';
  } finally {
    await pageSession.detach().catch(() => undefined);
  }

  const captures: RawFrameCapture[] = [];

  for (const frame of frames) {
    const contextPath = await frameContextPath(frame);
    let controls = byFrame.get(pathKey(contextPath)) ?? [];

    if (controls.length === 0 && frame.parentFrame() !== null) {
      // A CROSS-ORIGIN iframe is a separate process and does not appear in the parent page tree,
      // but it does get a CDP session of its own. Same-origin frames never reach this branch.
      try {
        const frameSession = await context.newCDPSession(frame);
        try {
          const own = await axControlsByFrame(frameSession);
          controls = own.get('') ?? own.get(pathKey(contextPath)) ?? [];
        } finally {
          await frameSession.detach().catch(() => undefined);
        }
      } catch (error) {
        debugPerception('no separate session for ' + frame.url() + ', falling back:', error);
      }
    }

    if (controls.length === 0 && perceptionPath === 'aria_snapshot') {
      controls = await ariaSnapshotControls(frame);
    }

    const summary = await frameSummary(frame);
    const offset = await frameOffset(frame);
    captures.push({
      contextPath,
      title: await frame.title(),
      url: frame.url(),
      headings: summary.headings,
      bodyText: summary.bodyText,
      controls:
        offset === 'unknown'
          ? controls.map((control) => ({ ...control, boxSpace: 'frame' as const }))
          : controls.map((control) => ({
              ...control,
              box: {
                ...control.box,
                x: control.box.x + offset.x,
                y: control.box.y + offset.y,
              },
              boxSpace: 'page' as const,
            })),
    });
  }

  return { surfaceId, perceptionPath, frames: captures };
}
