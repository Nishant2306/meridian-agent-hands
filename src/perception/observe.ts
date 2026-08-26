import { randomUUID } from 'node:crypto';
import { normalizeText } from '../types/normalize.js';
import type { ControlRole } from '../types/control.js';
import type { InventoryTruncation, Observation, PerceivedControl } from '../types/perception.js';
import type { AdapterAddressing, AddressingRecipe } from './addressing.js';
import type { RawCapture, RawControl } from './raw.js';
import {
  ADDRESSABLE_ARIA_ROLES,
  mapAxRole,
  rolePriority,
  ROLES_NAMED_FROM_CONTENT,
} from './roles.js';
import { buildScreenIdentity } from './screen-identity.js';

/**
 * Cap on the inventory handed to the model.
 *
 * A legacy screen built out of nested layout tables can perceive several hundred nodes. The cap is
 * not about token cost, it is about a numbered list staying usable: past a certain length the model
 * is choosing from a haystack. When the cap bites it is RECORDED on the observation, never silent.
 */
export const MAX_INVENTORY_CONTROLS = 120;

const MAX_NEARBY_TEXT = 4;

interface Candidate {
  raw: RawControl;
  role: ControlRole;
  contextPath: string[];
  order: number;
  roleIndex: number;
  nameIndex: number;
  textIndex: number;
}

function recipeFor(candidate: Candidate): AddressingRecipe {
  const { raw } = candidate;

  if (raw.nameAttribute !== undefined && raw.nameAttribute !== '') {
    return { kind: 'attribute', attribute: 'name', value: raw.nameAttribute };
  }

  const ariaRole = raw.axRole.toLowerCase();
  if (ADDRESSABLE_ARIA_ROLES.has(ariaRole)) {
    // A name only goes into the recipe if `getByRole` will compute the same one. For a role that
    // is not named from its content, a "name" equal to the node's own text came from Chrome's AX
    // tree, not from ARIA, and filtering by it matches nothing. See ROLES_NAMED_FROM_CONTENT.
    const nameIsJustItsOwnText = normalizeText(raw.name) === normalizeText(raw.ownText);
    const nameIsAddressable =
      raw.name !== '' && (ROLES_NAMED_FROM_CONTENT.has(ariaRole) || !nameIsJustItsOwnText);

    if (nameIsAddressable) {
      return { kind: 'role', ariaRole, name: raw.name, index: candidate.nameIndex };
    }
    // Its own text still addresses it, and on this fixture it is the recipe that works.
    if (raw.ownText !== '') {
      return { kind: 'text', text: raw.ownText, index: candidate.textIndex };
    }
    return { kind: 'role', ariaRole, index: candidate.roleIndex };
  }

  if (raw.ownText !== '') {
    return { kind: 'text', text: raw.ownText, index: candidate.textIndex };
  }

  return { kind: 'none' };
}

/**
 * Turn a raw capture into a numbered inventory. PURE: no browser, no clock beyond what is passed
 * in, no randomness beyond the observation id. That is what makes it testable against a saved
 * capture, and it is why the resolver tests need no browser.
 */
export function buildObservation(
  capture: RawCapture,
  options: { observationId?: string; capturedAt?: string; maxControls?: number } = {},
): { observation: Observation; addressing: Map<number, AdapterAddressing> } {
  const maxControls = options.maxControls ?? MAX_INVENTORY_CONTROLS;

  const candidates: Candidate[] = [];
  let order = 0;

  for (const frame of capture.frames) {
    const roleCounts = new Map<string, number>();
    const nameCounts = new Map<string, number>();
    const textCounts = new Map<string, number>();

    for (const raw of frame.controls) {
      // Invisible nodes are not addressable and are shown to nobody, so they are dropped BEFORE
      // indices are counted. Counting them would shift every positional recipe by the number of
      // hidden elements above it, which is a very quiet way to click the wrong control.
      if (!raw.visible) continue;

      const ariaRole = raw.axRole.toLowerCase();
      const roleIndex = roleCounts.get(ariaRole) ?? 0;
      roleCounts.set(ariaRole, roleIndex + 1);

      const nameKey = ariaRole + ' ' + raw.name;
      const nameIndex = nameCounts.get(nameKey) ?? 0;
      nameCounts.set(nameKey, nameIndex + 1);

      const textIndex = textCounts.get(raw.ownText) ?? 0;
      textCounts.set(raw.ownText, textIndex + 1);

      const role = mapAxRole(raw.axRole);
      if (role === null) continue;

      candidates.push({
        raw,
        role,
        contextPath: [...frame.contextPath],
        order: order++,
        roleIndex,
        nameIndex,
        textIndex,
      });
    }
  }

  const kept = [...candidates]
    .sort((a, b) => rolePriority(a.role) - rolePriority(b.role) || a.order - b.order)
    .slice(0, maxControls)
    .sort((a, b) => a.order - b.order);

  const keptOrders = new Set(kept.map((candidate) => candidate.order));
  const droppedRoles = new Set<ControlRole>();
  for (const candidate of candidates) {
    if (!keptOrders.has(candidate.order)) droppedRoles.add(candidate.role);
  }

  const truncation: InventoryTruncation = {
    perceived: candidates.length,
    kept: kept.length,
    droppedByPriority: [...droppedRoles].sort(),
  };

  const controls: PerceivedControl[] = [];
  const addressing = new Map<number, AdapterAddressing>();

  kept.forEach((candidate, index) => {
    const markId = index + 1;
    const { raw } = candidate;

    const containers = raw.containers
      .map((container) => ({
        role: mapAxRole(container.axRole),
        name: normalizeText(container.name),
      }))
      .filter(
        (container): container is { role: ControlRole; name: string } => container.role !== null,
      )
      .map((container) => (container.name === '' ? { role: container.role } : container));

    controls.push({
      markId,
      role: candidate.role,
      name: normalizeText(raw.name),
      ...(raw.value === undefined ? {} : { value: normalizeText(raw.value) }),
      enabled: !raw.disabled,
      contextPath: candidate.contextPath,
      nearbyText: raw.nearbyText.map(normalizeText).filter(Boolean).slice(0, MAX_NEARBY_TEXT),
      stableAttributes:
        raw.nameAttribute === undefined || raw.nameAttribute === ''
          ? {}
          : { name: raw.nameAttribute },
      box: raw.box,
      ...(raw.boxSpace === undefined ? {} : { boxSpace: raw.boxSpace }),
      containers,
      ...(raw.rowCellTexts === undefined
        ? {}
        : { rowCellTexts: raw.rowCellTexts.map(normalizeText).filter(Boolean) }),
    });

    addressing.set(markId, {
      markId,
      contextPath: candidate.contextPath,
      recipe: recipeFor(candidate),
      expectedName: normalizeText(raw.name),
      ...(raw.nameAttribute === undefined ? {} : { expectedNameAttribute: raw.nameAttribute }),
    });
  });

  const observation: Observation = {
    observationId: options.observationId ?? randomUUID(),
    surfaceId: capture.surfaceId,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    perceptionPath: capture.perceptionPath,
    screenIdentity: buildScreenIdentity(capture.frames),
    controls,
    truncation,
  };

  return { observation, addressing };
}
