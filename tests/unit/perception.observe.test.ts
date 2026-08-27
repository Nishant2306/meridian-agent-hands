import { describe, expect, it } from 'vitest';
import { isCompatibleScreenContext } from '../../src/perception/screen-identity.js';
import { renderInventory } from '../../src/perception/inventory.js';
import { DefaultTargetResolver } from '../../src/perception/resolver.js';
import type { Observation } from '../../src/types/perception.js';
import type { TargetDescriptor } from '../../src/types/control.js';
import { valueMatchesParam } from '../../src/types/normalize.js';
import { loadObservation } from '../helpers/observations.js';

const resolver = new DefaultTargetResolver();

describe('observe() against the real fixture', () => {
  it('finds the member search box inside contentFrame, named by its label', () => {
    const observation = loadObservation('search');
    const control = observation.controls.find(
      (candidate) =>
        candidate.role === 'textbox' &&
        (candidate.name.includes('Member ID') ||
          candidate.nearbyText.some((text) => text.includes('Member ID'))),
    );

    expect(control).toBeDefined();
    expect(control?.contextPath).toEqual(['contentFrame']);
    // This one field has a real <label for>, so the accessible name carries it.
    expect(control?.name).toBe('Member ID');
    expect(observation.perceptionPath).toBe('cdp_ax');
  });

  it('[MUST] picks up the LEFT-adjacent cell as the label for every other form field', () => {
    const observation = loadObservation('subaccount-new');
    const byAttribute = (attribute: string) =>
      observation.controls.find((control) => control.stableAttributes['name'] === attribute);

    const accountType = byAttribute('ctl00$Main$ddlAccountType');
    const nickname = byAttribute('ctl00$Main$txtNickname');
    const deposit = byAttribute('ctl00$Main$txtInitialDeposit');

    // None of these has an accessible name at all. The cell to their LEFT is the only thing that
    // identifies them, which is the entire reason nearbyText exists.
    expect(accountType?.name).toBe('');
    expect(nickname?.name).toBe('');
    expect(deposit?.name).toBe('');

    expect(accountType?.nearbyText[0]).toBe('Account Type');
    expect(nickname?.nearbyText[0]).toBe('Nickname (optional)');
    expect(deposit?.nearbyText[0]).toBe('Initial Deposit');
  });

  it('[MUST] starts the form neutral, as perceived through the accessibility tree', () => {
    const observation = loadObservation('subaccount-new');
    const accountType = observation.controls.find((control) => control.role === 'combobox');
    expect(accountType?.value).toBe('Select an account type');

    for (const attribute of ['ctl00$Main$txtNickname', 'ctl00$Main$txtInitialDeposit']) {
      const field = observation.controls.find(
        (control) => control.stableAttributes['name'] === attribute,
      );
      expect(field?.value).toBe('');
    }
  });

  it('records only the name attribute as stable, never a class or a generated id', () => {
    for (const screen of ['search', 'member', 'subaccount-new'] as const) {
      for (const control of loadObservation(screen).controls) {
        expect(Object.keys(control.stableAttributes).every((key) => key === 'name')).toBe(true);
      }
    }
  });

  it('assigns mark ids that are unique and contiguous within one observation', () => {
    const observation = loadObservation('search-results');
    const marks = observation.controls.map((control) => control.markId);
    expect(new Set(marks).size).toBe(marks.length);
    expect(marks).toEqual(marks.map((_, index) => index + 1));
  });

  it('renders a compact inventory the model can choose from', () => {
    const rendered = renderInventory(loadObservation('search'));
    expect(rendered).toContain('frame: contentFrame');
    expect(rendered).toContain('textbox');
    expect(rendered).toContain('"Member ID"');
    expect(rendered).toContain('MERIDIAN Core v3.2.1');
  });
});

describe('typed comparison against real screen text', () => {
  it('matches "250.00" against the "$250.00" the review screen actually rendered', () => {
    const review = loadObservation('subaccount-review');
    const deposit = review.controls.find((control) => control.name.startsWith('$'));
    expect(deposit?.name).toBe('$250.00');

    expect(valueMatchesParam(deposit?.name ?? '', '250.00', { type: 'currency' })).toBe(true);
    expect(valueMatchesParam(deposit?.name ?? '', '250', { type: 'currency' })).toBe(true);
    expect(valueMatchesParam(deposit?.name ?? '', '250.01', { type: 'currency' })).toBe(false);
  });
});

describe('isCompatibleScreenContext', () => {
  const withScreen = (
    base: Observation,
    canonicalScreenName: string,
    title: string,
  ): Observation => ({
    ...base,
    observationId: base.observationId + '-variant',
    screenIdentity: { ...base.screenIdentity, canonicalScreenName, title },
  });

  it('accepts the same screen observed twice', () => {
    const first = loadObservation('subaccount-new');
    const second = { ...first, observationId: 'second' };
    expect(isCompatibleScreenContext(first, second)).toBe(true);
  });

  it('[MUST] separates two screens that both contain a "Continue" button', () => {
    const form = loadObservation('subaccount-new');
    const impostor = withScreen(form, 'Confirm Transfer', 'Confirm Transfer - MERIDIAN');

    const continueButton: TargetDescriptor = {
      semantic: { role: 'button', name: 'Continue', nameMatch: 'exact' },
      recordedTier: 'T1_EXACT_ROLE_NAME',
    };

    // Re-resolving alone would NOT catch the switch: the descriptor resolves cleanly on both.
    expect(resolver.resolve(form, continueButton).ok).toBe(true);
    expect(resolver.resolve(impostor, continueButton).ok).toBe(true);

    // The screen context does catch it. That is why staleness is checked on context, not on
    // whether the descriptor still resolves.
    expect(isCompatibleScreenContext(form, impostor)).toBe(false);
  });

  it('ignores the query string, so a parameterized page is still the same screen', () => {
    const results = loadObservation('search-results');
    const other: Observation = {
      ...results,
      screenIdentity: { ...results.screenIdentity, url: 'http://127.0.0.1:1/search?q=99999' },
    };
    expect(isCompatibleScreenContext(results, other)).toBe(true);
  });
});
