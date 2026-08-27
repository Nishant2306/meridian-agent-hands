import { describe, expect, it } from 'vitest';
import { convertProposal } from '../../src/agent/proposal.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import { isCompatibleScreenContext } from '../../src/perception/screen-identity.js';
import { loadObservation } from '../helpers/observations.js';

const resolver = new DefaultTargetResolver();
const runtimeInputs = { memberId: '10001', accountType: 'Savings', initialDeposit: '250.00' };
const runtimeValues = Object.values(runtimeInputs);

describe('proposal conversion', () => {
  it('rejects a mark that is not in the inventory the model was shown', () => {
    const observation = loadObservation('member');
    const converted = convertProposal({
      sourceObservation: observation,
      freshObservation: observation,
      markId: 9999,
      kind: 'click',
      resolver,
      runtimeValues,
      runtimeInputs,
    });

    expect(converted.ok).toBe(false);
    if (converted.ok) return;
    expect(converted.rejection.code).toBe('UNKNOWN_MARK');
  });

  it('[MUST] rejects a stale proposal even when a same-named control exists on the new screen', () => {
    // This is the case re-resolution ALONE cannot catch. The navigation link named "Member Search"
    // is present on BOTH screens, so the descriptor built from the old screen resolves perfectly
    // against the new one - to a control the model never chose, on a screen it never saw.
    const source = loadObservation('member');
    const fresh = loadObservation('subaccount-new');

    const navLink = source.controls.find(
      (control) => control.role === 'link' && control.name === 'Member Search',
    );
    expect(navLink).toBeDefined();
    if (navLink === undefined) return;

    // Prove the premise: the same control really is on the new screen too.
    expect(
      fresh.controls.some((control) => control.role === 'link' && control.name === 'Member Search'),
    ).toBe(true);
    expect(isCompatibleScreenContext(source, fresh)).toBe(false);

    const converted = convertProposal({
      sourceObservation: source,
      freshObservation: fresh,
      markId: navLink.markId,
      kind: 'click',
      resolver,
      runtimeValues,
      runtimeInputs,
    });

    expect(converted.ok).toBe(false);
    if (converted.ok) return;
    expect(converted.rejection.code).toBe('STALE_OBSERVATION_CONTEXT');
    expect(converted.rejection.reason).toContain('Member Record');
    expect(converted.rejection.reason).toContain('New Sub-Account');
  });

  it('accepts the same proposal when the screen has not moved', () => {
    const observation = loadObservation('member');
    const navLink = observation.controls.find(
      (control) => control.role === 'link' && control.name === 'Member Search',
    );
    if (navLink === undefined) throw new Error('fixture capture changed');

    const converted = convertProposal({
      sourceObservation: observation,
      freshObservation: observation,
      markId: navLink.markId,
      kind: 'click',
      resolver,
      runtimeValues,
      runtimeInputs,
    });
    expect(converted.ok).toBe(true);
  });
});

describe('descriptor synthesis', () => {
  it('[MUST] parameterizes the row key rather than embedding the member id', () => {
    const observation = loadObservation('search-results');
    const open = observation.controls.find(
      (control) => control.role === 'link' && control.name === 'Open',
    );
    if (open === undefined) throw new Error('fixture capture changed');

    const converted = convertProposal({
      sourceObservation: observation,
      freshObservation: observation,
      markId: open.markId,
      kind: 'click',
      resolver,
      runtimeValues,
      runtimeInputs,
    });

    expect(converted.ok).toBe(true);
    if (!converted.ok) return;

    const rowKey = converted.descriptor.semantic.rowKey?.cellText;
    expect(rowKey).toEqual({ kind: 'param', name: 'memberId' });
    expect(JSON.stringify(converted.descriptor)).not.toContain('10001');
  });

  it('[MUST] a descriptor carrying a row key records the STRUCTURAL tier', () => {
    // The capture has four result rows, so the row key is doing visible work here.
    const fourRows = loadObservation('search-results');
    const open = fourRows.controls.find(
      (control) => control.role === 'link' && control.name === 'Open',
    );
    if (open === undefined) throw new Error('fixture capture changed');

    const convertedFromFour = convertProposal({
      sourceObservation: fourRows,
      freshObservation: fourRows,
      markId: open.markId,
      kind: 'click',
      resolver,
      runtimeValues,
      runtimeInputs,
    });
    expect(convertedFromFour.ok).toBe(true);
    if (!convertedFromFour.ok) return;
    expect(convertedFromFour.descriptor.recordedTier).toBe('T5_STRUCTURAL_ROW');

    // Now the case that matters. A search for ONE member returns ONE row, so role-plus-name
    // resolves the link uniquely and the cascade reports T1 - while the row key, which is the only
    // thing separating those links when four come back, did no work at all.
    //
    // Recording T1 there is wrong in the direction that looks fine: `recordedTier` is what replay
    // compares its own tier against to raise a drift signal, so claiming the strongest tier when a
    // weaker one is what the descriptor relies on makes a real downgrade read as normal.
    const otherRows = new Set(['10002', '10003', '10004']);
    const oneRow = {
      ...fourRows,
      observationId: 'derived-single-row',
      controls: fourRows.controls.filter(
        (control) => !(control.rowCellTexts ?? []).some((cell) => otherRows.has(cell)),
      ),
    };

    const survivingOpenLinks = oneRow.controls.filter(
      (control) => control.role === 'link' && control.name === 'Open',
    );
    expect(survivingOpenLinks).toHaveLength(1);

    const single = survivingOpenLinks[0];
    if (single === undefined) return;

    const convertedFromOne = convertProposal({
      sourceObservation: oneRow,
      freshObservation: oneRow,
      markId: single.markId,
      kind: 'click',
      resolver,
      runtimeValues,
      runtimeInputs,
    });

    expect(convertedFromOne.ok).toBe(true);
    if (!convertedFromOne.ok) return;
    expect(convertedFromOne.descriptor.semantic.rowKey?.cellText).toEqual({
      kind: 'param',
      name: 'memberId',
    });
    // Even though role-plus-name alone would have resolved it on this screen.
    expect(convertedFromOne.descriptor.recordedTier).toBe('T5_STRUCTURAL_ROW');
  });

  it('records the tier that actually fired when there is no row key', () => {
    const observation = loadObservation('subaccount-new');
    const deposit = observation.controls.find(
      (control) => control.stableAttributes['name'] === 'ctl00$Main$txtInitialDeposit',
    );
    if (deposit === undefined) throw new Error('fixture capture changed');

    const converted = convertProposal({
      sourceObservation: observation,
      freshObservation: observation,
      markId: deposit.markId,
      kind: 'type',
      value: { kind: 'param', name: 'initialDeposit' },
      resolver,
      runtimeValues,
      runtimeInputs,
    });

    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.descriptor.semantic.rowKey).toBeUndefined();
    expect(converted.descriptor.recordedTier).toBe('T3_EXTERNAL_LABEL_OR_NEARBY');
  });

  it('[MUST] identifies a value cell by its LABEL, never by the value it displays', () => {
    // The member-name cell's accessible name IS "Avery Lin". Using it would produce a capability
    // that only works for Avery Lin, and would write a member's name into a stored artifact.
    const observation = loadObservation('subaccount-review');
    const nameCell = observation.controls.find(
      (control) => control.role === 'cell' && control.name === 'Avery Lin',
    );
    if (nameCell === undefined) throw new Error('fixture capture changed');

    const converted = convertProposal({
      sourceObservation: observation,
      freshObservation: observation,
      markId: nameCell.markId,
      kind: 'read',
      resolver,
      runtimeValues: [...runtimeValues, 'Avery Lin'],
      runtimeInputs,
    });

    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.descriptor.semantic.name).toBeUndefined();
    expect(converted.descriptor.semantic.nearbyText).toContain('Member Name');
    expect(JSON.stringify(converted.descriptor)).not.toContain('Avery Lin');
  });

  it('drops a nearby hint that mentions a runtime value', () => {
    // The sub-account form carries "Member Name: Avery Lin (10001)" as a text node. A hint quoting
    // it would be over-permissive AND would embed the member id.
    const observation = loadObservation('subaccount-new');
    const deposit = observation.controls.find(
      (control) => control.stableAttributes['name'] === 'ctl00$Main$txtInitialDeposit',
    );
    if (deposit === undefined) throw new Error('fixture capture changed');

    const converted = convertProposal({
      sourceObservation: observation,
      freshObservation: observation,
      markId: deposit.markId,
      kind: 'type',
      value: { kind: 'param', name: 'initialDeposit' },
      resolver,
      runtimeValues,
      runtimeInputs,
    });

    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    for (const hint of converted.descriptor.semantic.nearbyText ?? []) {
      expect(hint).not.toContain('10001');
    }
  });
});
