import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalStringify, contentHashOf } from '../../src/config/canonical.js';
import { loadDiscoverySpec, parseDiscoverySpec, specHash } from '../../src/config/spec.js';

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
