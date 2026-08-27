import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalStringify, contentHashOf } from '../../src/config/canonical.js';
import { loadDiscoverySpec, parseDiscoverySpec, specHash } from '../../src/config/spec.js';
import { goalTemplatePlaceholders, renderGoal } from '../../src/types/spec.js';

const SPEC_PATH = fileURLToPath(
  new URL('../../config/specs/prepare_subaccount_review.yaml', import.meta.url),
);

describe('canonical serialization', () => {
  it('is insensitive to key order', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });

  it('preserves array order, because order is meaning for a sequence of actions', () => {
    expect(contentHashOf(['a', 'b'])).not.toBe(contentHashOf(['b', 'a']));
  });

  it('treats an absent optional and an explicit undefined as the same thing', () => {
    expect(canonicalStringify({ a: 1 })).toBe(canonicalStringify({ a: 1, b: undefined }));
  });

  it('refuses to silently coerce a non-finite number', () => {
    expect(() => contentHashOf({ amount: Number.NaN })).toThrow(TypeError);
  });
});

describe('the prepare_subaccount_review DiscoverySpec', () => {
  it('loads and validates', () => {
    const loaded = loadDiscoverySpec(SPEC_PATH);
    expect(loaded.spec.capabilityId).toBe('prepare_subaccount_review');
    expect(loaded.specHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('declares the four inputs with their sensitivities', () => {
    const { spec } = loadDiscoverySpec(SPEC_PATH);
    const byName = new Map(spec.inputs.map((input) => [input.name, input]));

    expect(byName.get('memberId')).toMatchObject({
      type: 'string',
      sensitivity: 'pii',
      required: true,
    });
    expect(byName.get('accountType')).toMatchObject({ type: 'enum', sensitivity: 'public' });
    expect(byName.get('nickname')).toMatchObject({ required: false, sensitivity: 'pii' });
    expect(byName.get('initialDeposit')).toMatchObject({ type: 'currency', sensitivity: 'pii' });
  });

  it('declares outputs as WHAT, never WHERE', () => {
    const { spec } = loadDiscoverySpec(SPEC_PATH);
    const names = spec.outputs.map((output) => output.name);
    expect(names).toEqual(['memberName', 'accountType', 'reviewStatus']);
    for (const output of spec.outputs) {
      expect(output.when).toBe('success');
      expect(output).not.toHaveProperty('target');
      expect(output).not.toHaveProperty('selector');
    }
  });

  it('names the record identity parameter', () => {
    const { spec } = loadDiscoverySpec(SPEC_PATH);
    expect(spec.recordIdentity.param).toBe('memberId');
  });

  it('names profiles that actually exist on disk', () => {
    // The spec is what points at the profile files. If these ids drift, distillation cannot find
    // the profiles to hash and nothing downstream can be pinned.
    const { spec } = loadDiscoverySpec(SPEC_PATH);
    for (const path of [
      'config/condition-profiles/' +
        spec.conditionProfile.id +
        '/' +
        spec.conditionProfile.version +
        '.yaml',
      'config/safety-profiles/' +
        spec.safetyProfile.id +
        '/' +
        spec.safetyProfile.version +
        '.yaml',
    ]) {
      expect(existsSync(fileURLToPath(new URL('../../' + path, import.meta.url)))).toBe(true);
    }
  });

  it('references profiles by id and version only - hashes are pinned at distillation', () => {
    const { spec } = loadDiscoverySpec(SPEC_PATH);
    expect(spec.conditionProfile).toEqual({ id: 'meridian-subaccount', version: '1.0.0' });
    expect(spec.safetyProfile).toEqual({ id: 'banking-default', version: '1.0.0' });
    expect(spec.conditionProfile).not.toHaveProperty('sha256');
    expect(spec.safetyProfile).not.toHaveProperty('sha256');
  });

  it('uses only synthetic examples, none of which is a seeded member', () => {
    const { spec } = loadDiscoverySpec(SPEC_PATH);
    const memberId = spec.inputs.find((input) => input.name === 'memberId');
    expect(memberId?.example).toBe('00000');
    for (const seeded of ['10001', '10002', '10003', '10004', '99999']) {
      expect(memberId?.example).not.toBe(seeded);
    }
  });
});

describe('specHash', () => {
  it('is stable across reformatting and comments', () => {
    const original = readFileSync(SPEC_PATH, 'utf8');
    const reformatted = `# an added comment\n${original}\n\n`;

    const a = parseDiscoverySpec(original, 'a.yaml');
    const b = parseDiscoverySpec(reformatted, 'b.yaml');
    expect(b.specHash).toBe(a.specHash);
  });

  it('changes when the declared contract changes', () => {
    const { spec } = loadDiscoverySpec(SPEC_PATH);
    const before = specHash(spec);

    const widened = {
      ...spec,
      inputs: spec.inputs.map((input) =>
        input.name === 'nickname' ? { ...input, required: true } : input,
      ),
    };

    expect(specHash(widened)).not.toBe(before);
  });
});

describe('DiscoverySpec validation', () => {
  const base = readFileSync(SPEC_PATH, 'utf8');

  it('rejects a goalTemplate that references an undeclared parameter', () => {
    const broken = base.replace('{{memberId}}', '{{memberNumber}}');
    expect(() => parseDiscoverySpec(broken, 'broken.yaml')).toThrow(/memberNumber/);
  });

  it('rejects a recordIdentity that names an undeclared parameter', () => {
    const broken = base.replace('  param: memberId', '  param: customerId');
    expect(() => parseDiscoverySpec(broken, 'broken.yaml')).toThrow(/customerId/);
  });

  it('rejects an enum input with no declared values', () => {
    const broken = base.replace(
      '    type: enum\n    values:\n      - Savings\n      - Checking\n',
      '    type: enum\n',
    );
    expect(() => parseDiscoverySpec(broken, 'broken.yaml')).toThrow(/must declare values/);
  });

  it('rejects an example that violates its own declared pattern', () => {
    const broken = base.replace("    example: '00000'", "    example: 'ABCDE'");
    expect(() => parseDiscoverySpec(broken, 'broken.yaml')).toThrow(
      /does not match its declared pattern/,
    );
  });
});

describe('the goal the model is actually given', () => {
  /**
   * An evidence run shipped "find member {{memberId}}" to a real model. The flow still worked -
   * values reach the screen through typed parameter bindings, not through the goal - but "is this
   * the right record" became a guess, and the model guessed three different ways before the run
   * ended on the repeated-action rule. See DECISIONS.md D80.
   */
  const TEMPLATE =
    'In MERIDIAN Core Servicing, find member {{memberId}} and prepare a new sub-account request ' +
    'for them of type {{accountType}} with nickname {{nickname}} and an initial deposit of ' +
    '{{initialDeposit}}.';

  it('[MUST] no placeholder survives into the goal the model is sent', () => {
    const rendered = renderGoal(TEMPLATE, {
      memberId: '10001',
      accountType: 'Savings',
      nickname: 'Holiday Fund',
      initialDeposit: '250.00',
    });

    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('find member 10001');
    expect(rendered).toContain('of type Savings');
    expect(goalTemplatePlaceholders(rendered)).toEqual([]);
  });

  it('an omitted optional renders as text, never as a leftover placeholder', () => {
    // `nickname` is optional. Leaving `{{nickname}}` in place would reintroduce the exact defect
    // this function exists to prevent, and dropping the clause around it cannot be done
    // mechanically without rewriting somebody's sentence.
    const rendered = renderGoal(TEMPLATE, { memberId: '10001', accountType: 'Savings' });

    expect(rendered).not.toContain('{{');
    expect(rendered).toContain('nickname (not provided)');
  });

  it('the SPEC still stores the template, because that is what provenance records', () => {
    // A rendered goal carries the member id. The reason there is no goalDigest is that a hash of
    // one is brute-forceable over 100,000 five-digit ids; the template is the traceable artefact.
    const spec = loadDiscoverySpec(SPEC_PATH).spec;
    expect(spec.goalTemplate).toContain('{{memberId}}');
    expect(goalTemplatePlaceholders(spec.goalTemplate)).toContain('memberId');
  });
});
