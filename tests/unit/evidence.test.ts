import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvidenceWriter } from '../../src/evidence/logger.js';
import { describeBinding, MissingBindingError, ValueResolver } from '../../src/surface/values.js';

describe('the evidence writer', () => {
  it('writes one JSON object per line, LF-delimited on every host', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-'));
    const writer = new EvidenceWriter({ runId: 'run-1', rootDir: root });

    writer.append({
      type: 'run_started',
      at: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      surfaceId: 'playwright-web',
      allowedOrigin: 'http://127.0.0.1:4180',
    });
    writer.append({
      type: 'action_blocked',
      at: '2026-01-01T00:00:01.000Z',
      actionType: 'click',
      error: 'POLICY_BLOCKED',
      reason: 'refusing to click Submit Request',
    });

    const raw = readFileSync(join(root, 'run-1', 'events.jsonl'), 'utf8');
    expect(raw).not.toContain(String.fromCharCode(13));

    const lines = raw.trim().split(String.fromCharCode(10));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ error: 'POLICY_BLOCKED' });
  });
});

describe('the executor value resolver', () => {
  const resolver = new ValueResolver({
    params: { memberId: '10001' },
    secrets: { passcode: 'never-logged' },
  });

  it('resolves literals, params and secrets', () => {
    expect(resolver.resolve({ kind: 'literal', value: 'Savings' })).toBe('Savings');
    expect(resolver.resolve({ kind: 'param', name: 'memberId' })).toBe('10001');
    expect(resolver.resolve({ kind: 'secretRef', name: 'passcode' })).toBe('never-logged');
  });

  it('fails loudly for a binding nobody supplied', () => {
    expect(() => resolver.resolve({ kind: 'param', name: 'nickname' })).toThrow(
      MissingBindingError,
    );
  });

  it('[MUST] describes a binding without ever revealing its value', () => {
    // Everything that writes a log line, an evidence event or a CLI message goes through this.
    // A secret that is never written down cannot leak through a debug statement.
    expect(describeBinding({ kind: 'secretRef', name: 'passcode' })).toBe('secret:passcode');
    expect(describeBinding({ kind: 'param', name: 'memberId' })).toBe('param:memberId');
    expect(describeBinding({ kind: 'literal', value: 'Savings' })).toBe('literal');

    for (const binding of [
      { kind: 'secretRef', name: 'passcode' },
      { kind: 'param', name: 'memberId' },
      { kind: 'literal', value: 'Savings' },
    ] as const) {
      expect(describeBinding(binding)).not.toContain('never-logged');
      expect(describeBinding(binding)).not.toContain('10001');
    }
  });
});
