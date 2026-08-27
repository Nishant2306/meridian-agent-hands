import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearScenarios } from '../../scripts/evidence/lib/runtime.js';
import { EvidenceWriter } from '../../src/evidence/logger.js';
import { Pseudonymizer } from '../../src/redaction/pseudonymize.js';
import { declarationFor } from '../../src/redaction/declaration.js';

describe('a bundle holds one run of each scenario', () => {
  it('[MUST] clears every scenario directory, the handoff included', () => {
    // After three evidence runs `/evidence` held three of everything while the manifest described
    // one. A reviewer grepping the bundle hits files from runs nobody is claiming anything about -
    // and did: a reported leak turned out to come from a superseded run.
    const root = mkdtempSync(join(tmpdir(), 'bundle-'));
    const scenarios = [
      'discovery',
      'artifact',
      'success',
      'notFound',
      'recovery',
      'permissionDenied',
      'unavailable',
      'handoff',
    ];
    for (const scenario of scenarios) {
      mkdirSync(join(root, scenario, 'run-1'), { recursive: true });
      writeFileSync(join(root, scenario, 'run-1', 'result.json'), '{}', 'utf8');
    }
    // Things that are NOT a scenario directory must survive: the README is tracked, and the
    // manifest is rewritten rather than removed.
    writeFileSync(join(root, 'README.md'), 'template', 'utf8');
    writeFileSync(join(root, 'manifest.json'), '{}', 'utf8');

    const cleared = clearScenarios(root);

    expect(cleared.sort()).toEqual([...scenarios].sort());
    for (const scenario of scenarios) expect(existsSync(join(root, scenario))).toBe(false);
    expect(existsSync(join(root, 'README.md'))).toBe(true);
    expect(existsSync(join(root, 'manifest.json'))).toBe(true);
  });

  it('[MUST] the handoff is cleared too, and that is deliberate', () => {
    // `evidence:automated` does not write the handoff, so leaving it would look like kindness. But
    // the handoff REPLAYS THE ARTIFACT THE DISCOVERY PRODUCED, and a new discovery produces a new
    // artifact with a new content hash. Fresh discovery plus stale handoff is a bundle that lies
    // about which capability the person operated.
    const root = mkdtempSync(join(tmpdir(), 'bundle-'));
    mkdirSync(join(root, 'handoff', 'replay-old'), { recursive: true });

    expect(clearScenarios(root)).toContain('handoff');
    expect(existsSync(join(root, 'handoff'))).toBe(false);
  });

  it('clearing an empty bundle is not an error', () => {
    expect(clearScenarios(mkdtempSync(join(tmpdir(), 'bundle-')))).toEqual([]);
  });
});

describe('a declared-sensitive value the run learns part way through', () => {
  const writer = (): EvidenceWriter => {
    const evidence = new EvidenceWriter({
      runId: 'learn',
      rootDir: mkdtempSync(join(tmpdir(), 'learn-')),
      pseudonymizer: new Pseudonymizer(),
    });
    evidence.declareSensitive(
      declarationFor({
        inputs: [{ name: 'memberId', sensitivity: 'pii' }],
        outputs: [{ name: 'memberName', sensitivity: 'pii' }],
        recordIdentityParam: 'memberId',
        params: { memberId: '20001' },
      }),
    );
    return evidence;
  };

  it('[MUST] is labelled in files written AFTER it is learned', () => {
    // A handoff stops part way through. The screen it stopped on displays the member's NAME, which
    // the capability reads from a later screen the run never reached - so the declaration named
    // `memberName` and had no value for it, and a real bundle carried the name into an
    // `observation-*.json`. The run knew the field was pii and knew where it lived; it had not
    // looked.
    const evidence = writer();
    expect(evidence.redactText('Dana Whitfield')).toBe('Dana Whitfield');

    evidence.learnSensitiveValue('memberName', 'Dana Whitfield');
    expect(evidence.redactText('Dana Whitfield')).toContain('[memberName:');
    // And the earlier declaration is not lost.
    expect(evidence.redactText('member 20001')).toContain('[memberId:');
  });

  it('[MUST] cannot invent a sensitivity that was never declared', () => {
    // Otherwise this becomes a way to mark anything sensitive at runtime, and the declaration stops
    // being the human-authored contract it exists to be.
    const evidence = writer();
    evidence.learnSensitiveValue('accountBalance', '1,250.00');
    expect(evidence.redactText('1,250.00')).toBe('1,250.00');
  });

  it('ignores an empty value', () => {
    const evidence = writer();
    evidence.learnSensitiveValue('memberName', '');
    expect(evidence.redactText('')).toBe('');
  });
});
