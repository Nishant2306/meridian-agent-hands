import { describe, expect, it } from 'vitest';
import { bindDescriptor } from '../../src/perception/bind.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import type { TargetDescriptor } from '../../src/types/control.js';
import { loadObservation } from '../helpers/observations.js';

const resolver = new DefaultTargetResolver();

const descriptor = (
  semantic: TargetDescriptor['semantic'],
  recordedTier: TargetDescriptor['recordedTier'],
  adapterHints?: TargetDescriptor['adapterHints'],
): TargetDescriptor => ({
  semantic,
  recordedTier,
  ...(adapterHints === undefined ? {} : { adapterHints }),
});

describe('the resolver cascade', () => {
  it('T1: resolves a button by role and exact accessible name', () => {
    const result = resolver.resolve(
      loadObservation('search'),
      descriptor({ role: 'button', name: 'Search', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
    );

    expect(result.ok).toBe(true);
    expect(result.trace.tierUsed).toBe('T1_EXACT_ROLE_NAME');
    expect(result.trace.downgraded).toBe(false);
  });

  it('T3: resolves a control that has NO accessible name, by the cell to its left', () => {
    const result = resolver.resolve(
      loadObservation('subaccount-new'),
      descriptor(
        { role: 'combobox', nameMatch: 'normalized', nearbyText: ['Account Type'] },
        'T3_EXTERNAL_LABEL_OR_NEARBY',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.tierUsed).toBe('T3_EXTERNAL_LABEL_OR_NEARBY');
    expect(result.control.stableAttributes['name']).toBe('ctl00$Main$ddlAccountType');
  });

  it('T4: resolves by the legacy-stable name attribute', () => {
    const result = resolver.resolve(
      loadObservation('subaccount-new'),
      descriptor({ role: 'textbox', nameMatch: 'exact' }, 'T4_STABLE_ATTRIBUTE', {
        web: { stableAttribute: { name: 'ctl00$Main$txtInitialDeposit' } },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.trace.tierUsed).toBe('T4_STABLE_ATTRIBUTE');
  });

  it('T5: picks the right "Open" link out of four identical ones, by row key', () => {
    const observation = loadObservation('search-results');

    const openLinks = observation.controls.filter(
      (control) => control.role === 'link' && control.name === 'Open',
    );
    expect(openLinks).toHaveLength(4);

    const result = resolver.resolve(
      observation,
      descriptor(
        {
          role: 'link',
          name: 'Open',
          nameMatch: 'exact',
          rowKey: { cellText: { kind: 'literal', value: '10003' } },
        },
        'T5_STRUCTURAL_ROW',
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.tierUsed).toBe('T5_STRUCTURAL_ROW');
    expect(result.control.rowCellTexts).toContain('Casey Morgan');
  });

  it('[MUST] a row key constrains EVERY tier: it never resolves to the wrong row', () => {
    const observation = loadObservation('search-results');

    // Four rows, and the key names the third. Any tier that located a candidate must still be
    // filtered by the row it is in.
    const keyed = resolver.resolve(
      observation,
      descriptor(
        {
          role: 'link',
          name: 'Open',
          nameMatch: 'exact',
          rowKey: { cellText: { kind: 'literal', value: '10003' } },
        },
        'T5_STRUCTURAL_ROW',
      ),
    );

    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    expect(keyed.control.rowCellTexts).toContain('Casey Morgan');
    expect(keyed.trace.tierUsed).toBe('T5_STRUCTURAL_ROW');
  });

  it('[MUST] fails rather than resolving to the ONLY row when that row is not the keyed one', () => {
    // The case a row-key-as-a-tier design gets wrong. Narrow the capture to a single result row,
    // so role-plus-name alone resolves uniquely at T1 - then ask for a DIFFERENT member. Before
    // the row key became a constraint on every tier, T1 would win and the click would land on the
    // wrong record, with nothing at this step to notice.
    const fourRows = loadObservation('search-results');
    const others = new Set(['10002', '10003', '10004']);
    const oneRow = {
      ...fourRows,
      observationId: 'derived-single-row',
      controls: fourRows.controls.filter(
        (control) => !(control.rowCellTexts ?? []).some((cell) => others.has(cell)),
      ),
    };

    expect(
      oneRow.controls.filter((control) => control.role === 'link' && control.name === 'Open'),
    ).toHaveLength(1);

    const wrongRow = resolver.resolve(
      oneRow,
      descriptor(
        {
          role: 'link',
          name: 'Open',
          nameMatch: 'exact',
          rowKey: { cellText: { kind: 'literal', value: '10003' } },
        },
        'T5_STRUCTURAL_ROW',
      ),
    );

    expect(wrongRow.ok).toBe(false);
    if (wrongRow.ok) return;
    expect(wrongRow.error).toBe('CONTROL_NOT_FOUND');
  });

  it('reports the STRUCTURAL tier whenever a row key is in play', () => {
    // Even on a screen where role-plus-name alone would have been unique.
    const fourRows = loadObservation('search-results');
    const others = new Set(['10002', '10003', '10004']);
    const oneRow = {
      ...fourRows,
      observationId: 'derived-single-row',
      controls: fourRows.controls.filter(
        (control) => !(control.rowCellTexts ?? []).some((cell) => others.has(cell)),
      ),
    };

    const result = resolver.resolve(
      oneRow,
      descriptor(
        {
          role: 'link',
          name: 'Open',
          nameMatch: 'exact',
          rowKey: { cellText: { kind: 'literal', value: '10001' } },
        },
        'T5_STRUCTURAL_ROW',
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.trace.tierUsed).toBe('T5_STRUCTURAL_ROW');
    expect(result.trace.downgraded).toBe(false);
  });

  it('refuses to guess when several controls match and nothing separates them', () => {
    const result = resolver.resolve(
      loadObservation('search-results'),
      descriptor({ role: 'link', name: 'Open', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('AMBIGUOUS_CONTROL');
  });

  it('uses ordinal only as a last resort, and only when asked', () => {
    const result = resolver.resolve(
      loadObservation('search-results'),
      descriptor(
        { role: 'link', name: 'Open', nameMatch: 'exact', ordinal: 1 },
        'T1_EXACT_ROLE_NAME',
      ),
    );
    expect(result.ok).toBe(true);
  });
});

describe('drift, conflict and absence', () => {
  it('reports CONTROL_NOT_FOUND when nothing matches', () => {
    const result = resolver.resolve(
      loadObservation('search'),
      descriptor({ role: 'button', name: 'Wire Funds', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('CONTROL_NOT_FOUND');
  });

  it('records a tier downgrade as a drift signal without failing the action', () => {
    // Recorded at T1, resolves at T3: the screen has changed under the capability, and it still
    // works. That is exactly the moment worth noticing, well before it breaks outright.
    const result = resolver.resolve(
      loadObservation('subaccount-new'),
      descriptor(
        { role: 'combobox', nameMatch: 'normalized', nearbyText: ['Account Type'] },
        'T1_EXACT_ROLE_NAME',
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.trace.tierUsed).toBe('T3_EXTERNAL_LABEL_OR_NEARBY');
    expect(result.trace.downgraded).toBe(true);
  });

  it('[MUST] fails with LOCATOR_CONFLICT when two independent signals disagree', () => {
    // Role plus name says the "Back" link. The stable attribute says the Submit Request button.
    // One of them is wrong and nothing in the data says which, so the resolver stops rather than
    // quietly preferring the earlier tier.
    const result = resolver.resolve(
      loadObservation('subaccount-review'),
      descriptor({ role: 'link', name: 'Back', nameMatch: 'exact' }, 'T1_EXACT_ROLE_NAME', {
        web: { stableAttribute: { name: 'ctl00$Main$btnSubmitRequest' } },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('LOCATOR_CONFLICT');
    expect(result.trace.conflicts).toHaveLength(1);
    expect(result.trace.conflicts[0]?.tierA).toBe('T1_EXACT_ROLE_NAME');
    expect(result.trace.conflicts[0]?.tierB).toBe('T4_STABLE_ATTRIBUTE');
  });

  it('records every tier it actually attempted, and no tier it had no evidence for', () => {
    const result = resolver.resolve(
      loadObservation('subaccount-new'),
      descriptor(
        { role: 'textbox', name: 'Nickname', nameMatch: 'contains', nearbyText: ['Nickname'] },
        'T3_EXTERNAL_LABEL_OR_NEARBY',
      ),
    );

    const tiers = result.trace.tiersAttempted.map((attempt) => attempt.tier);
    expect(tiers).toContain('T1_EXACT_ROLE_NAME');
    expect(tiers).toContain('T3_EXTERNAL_LABEL_OR_NEARBY');
    expect(tiers).not.toContain('T2_NORMALIZED_IN_CONTAINER');
    expect(tiers).not.toContain('T4_STABLE_ATTRIBUTE');
    expect(tiers).not.toContain('T5_STRUCTURAL_ROW');
  });
});

describe('parameterized row keys', () => {
  const parameterized = descriptor(
    {
      role: 'link',
      name: 'Open',
      nameMatch: 'exact',
      rowKey: { cellText: { kind: 'param', name: 'memberId' } },
    },
    'T5_STRUCTURAL_ROW',
  );

  it('refuses to resolve an unbound parameter instead of guessing', () => {
    const result = resolver.resolve(loadObservation('search-results'), parameterized);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('CONTROL_NOT_FOUND');
    expect(result.detail).toContain('still parameterized');
  });

  it('resolves once the invocation values are bound', () => {
    const bound = bindDescriptor(parameterized, { memberId: '10002' });
    const result = resolver.resolve(loadObservation('search-results'), bound);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.control.rowCellTexts).toContain('Jordan Reyes');
  });
});
