import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { markersIn, renderReadme } from '../../scripts/evidence/lib/readme.js';
import type { Manifest } from '../../scripts/evidence/lib/manifest.js';

const HASH = 'a'.repeat(64);
const NL = String.fromCharCode(10);

/**
 * ================================================================================================
 * THE BUNDLE README IS DERIVED, SO IT CANNOT GO STALE OR BE WRONG BY HAND.
 * ================================================================================================
 *
 * It shipped with all 24 placeholders still in it. Filling them by hand would have been worse: it
 * goes stale the next time the bundle is regenerated, which is the class of rot `docs.paths` and D72
 * exist to prevent.
 *
 * These pin the two properties that make the generated version trustworthy: every value comes from a
 * FILE IN THE BUNDLE rather than from the orchestrator's memory, and a value that can only come from
 * the manifest says so instead of being asserted.
 */

function bundle(): { root: string; manifest: Manifest } {
  const root = mkdtempSync(join(tmpdir(), 'readme-'));

  // The template is the source, and it lives in the repository rather than in the bundle.
  writeFileSync(
    join(root, 'README.template.md'),
    [
      '# EVIDENCE',
      '',
      'discovery: <<FILL AFTER RUN: discovery.runId>>',
      'model:     <<FILL AFTER RUN: discovery.model>>',
      'success:   <<FILL AFTER RUN: success.result>>',
      'llm:       <<FILL AFTER RUN: success.llmCalls>>',
      'member:    <<FILL AFTER RUN: success.member>>',
      'handoff:   <<FILL AFTER RUN: handoff.result>>',
    ].join(NL),
    'utf8',
  );

  const write = (scenario: string, runId: string, files: Record<string, unknown>): void => {
    const dir = join(root, scenario, runId);
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(dir, name), JSON.stringify(body), 'utf8');
    }
  };

  write('discovery', 'discover-1', {
    'completion.json': { model: 'claude-sonnet-5', metrics: { llmCalls: 9, steps: 8 } },
    'result.json': {
      status: 'success',
      metrics: { durationMs: 1, llmCalls: 9, recoveriesUsed: 0, humanInterventions: 0 },
    },
  });
  write('success', 'replay-1', {
    'result.json': {
      status: 'success',
      metrics: { durationMs: 1800, llmCalls: 0, recoveriesUsed: 0, humanInterventions: 0 },
    },
    'steps.json': [],
  });

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    specHash: HASH,
    artifactContentHash: HASH,
    artifactFileHash: HASH,
    artifactDraftFileHash: 'b'.repeat(64),
    conditionProfileSha: HASH,
    safetyProfileSha: HASH,
    capability: { id: 'c', version: '1.0.0', approvedBy: 'test' },
    discoveryRunId: 'discover-1',
    discovery: {
      model: 'claude-sonnet-5',
      promptVersion: 'v2',
      llmCalls: 9,
      steps: 8,
      memberId: '10001',
    },
    fixtureSeeds: { discovery: 1, replay: 2 },
    replayRunIds: {
      success: 'replay-1',
      notFound: '',
      recovery: '',
      permissionDenied: '',
      unavailable: '',
      handoff: '',
    },
    scenarios: [
      {
        scenario: 'success',
        runId: 'replay-1',
        params: { memberId: '10002' },
        status: 'success',
        exitCode: 0,
        proves: 'x',
      },
    ],
  };

  return { root, manifest };
}

describe('the bundle README is rendered from the run files', () => {
  it('[MUST] fills every value it has a file for', () => {
    const { root, manifest } = bundle();
    renderReadme({ manifest, root });
    const text = readFileSync(join(root, 'README.md'), 'utf8');

    // Read out of completion.json and result.json, not out of the manifest - even though the
    // manifest happens to carry the model too. The run files are what a reviewer can check.
    expect(text).toContain('discovery: discover-1');
    expect(text).toContain('claude-sonnet-5   9 calls over 8 steps');
    expect(text).toContain('success:   success');
    expect(text).toContain('llm:       0');
  });

  it('[MUST] marks a value that can only come from the manifest', () => {
    // The run files are pseudonymized with a map that is random PER RUN, so the bundle genuinely
    // cannot say which member a run used. Saying so is the same distinction the verifier draws.
    const { root, manifest } = bundle();
    renderReadme({ manifest, root });
    const text = readFileSync(join(root, 'README.md'), 'utf8');

    expect(text).toContain('member:    [manifest] 10002, against discovery on 10001');
  });

  it('names the run it was generated from, so a stale one is detectable', () => {
    const { root, manifest } = bundle();
    renderReadme({ manifest, root });
    const text = readFileSync(join(root, 'README.md'), 'utf8');

    expect(text).toContain('GENERATED by npm run evidence:automated');
    expect(text).toContain('discover-1');
  });

  it('says a scenario was not run rather than leaving a placeholder', () => {
    // The handoff needs a person. "Not run" is a true statement; a leftover marker is not, and the
    // gate would fail on it - which would be one failure standing in for two different situations.
    const { root, manifest } = bundle();
    const rendered = renderReadme({ manifest, root });
    const text = readFileSync(join(root, 'README.md'), 'utf8');

    expect(rendered.unfilled).toEqual([]);
    expect(text).toContain('handoff:   (not run - npm run evidence:handoff)');
    expect(text).not.toContain('<<FILL AFTER RUN');
  });

  it('[MUST] the TEMPLATE keeps its markers, and the gate ignores it', () => {
    // A fresh clone that has never run anything must show a document that says what will go there.
    // The template is the source and is never filled in place.
    const { root, manifest } = bundle();
    renderReadme({ manifest, root });

    expect(readFileSync(join(root, 'README.template.md'), 'utf8')).toContain('<<FILL AFTER RUN');
    expect(markersIn(root)).toEqual([]);
  });

  it('[MUST] a published document that still has a placeholder is reported', () => {
    // The negative control for the gate's newest check.
    const { root, manifest } = bundle();
    renderReadme({ manifest, root });
    writeFileSync(join(root, 'NOTES.md'), 'run id: <<FILL AFTER RUN: something>>', 'utf8');

    expect(markersIn(root)).toEqual(['NOTES.md']);
    expect(existsSync(join(root, 'README.md'))).toBe(true);
  });
});
