import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLegacyApp } from '../../fixtures/legacy-app/server.js';
import { tenantA } from '../../fixtures/legacy-app/tenants/tenant-a.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLE = join(REPO, 'examples/artifacts/prepare_subaccount_review@1.0.0.example.json');

/**
 * [MUST] THE --json CONTRACT.
 *
 * The caller of `npm run replay --json` is an AI agent reading stdout. One stray progress line
 * turns a machine-readable result into a parse error, in production, on the run that mattered. So
 * this test runs the real CLI as a real subprocess and asserts stdout is EXACTLY one JSON object
 * and nothing else.
 *
 * It deliberately does not require the replay to SUCCEED. The contract being tested is about the
 * stream, and a test that only holds on the happy path is a test that stops protecting the
 * contract precisely when something has gone wrong.
 */
describe('the replay CLI --json contract', () => {
  let origin: string;
  let close: () => Promise<void>;
  let store: string;

  beforeAll(async () => {
    const { app } = createLegacyApp({ tenant: tenantA });
    const server = app.listen(0);
    origin = await new Promise<string>((resolve) => {
      server.on('listening', () => {
        const address = server.address() as AddressInfo;
        resolve('http://127.0.0.1:' + address.port);
      });
    });
    close = () => new Promise<void>((done) => server.close(() => done()));

    store = mkdtempSync(join(tmpdir(), 'artifacts-'));
    mkdirSync(join(store, 'prepare_subaccount_review'), { recursive: true });
    cpSync(EXAMPLE, join(store, 'prepare_subaccount_review', '1.0.0.json'));
  }, 60_000);

  afterAll(async () => {
    await close();
  });

  /**
   * Run the CLI as a real subprocess and resolve on EXIT, not on stdio close.
   *
   * `spawnSync` (and the 'close' event) wait for every inherited pipe to reach EOF. The browser
   * Chromium launches is a grandchild holding those handles, so the call blocks long after the CLI
   * itself has exited and printed its result. Resolving on 'exit' and reading what was collected
   * is what makes a browser-driven CLI testable at all.
   */
  const runCli = async (
    params: string,
    /**
     * `--json` is a PARAMETER here because it used not to be, and that hid a defect.
     *
     * Every call passed `--json`, which suppresses every stderr log line in the CLI. So the
     * assertion "stderr does not contain Avery Lin" held for a reason that had nothing to do with
     * redaction: there was no stderr output at all. The human channel was never pseudonymized, and
     * a test that read as though it proved otherwise stood over it. See DECISIONS D73.
     */
    options: { json?: boolean } = { json: true },
  ): Promise<{ stdout: string; stderr: string; status: number | null }> => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        join(REPO, 'src', 'cli', 'replay.ts'),
        '--artifact',
        'prepare_subaccount_review@1.0.0',
        '--params',
        params,
        '--artifacts',
        store,
        '--origin',
        origin,
        ...(options.json === false ? [] : ['--json']),
      ],
      { cwd: REPO, env: { ...process.env, HEADLESS: 'true' } },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const status = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => {
        // Give the pipes a moment to flush what was written before exit.
        setTimeout(() => resolve(code), 250);
      });
    });

    child.kill();
    return { stdout, stderr, status };
  };

  it('[MUST] writes exactly ONE JSON object to stdout, and no log lines', async () => {
    const { stdout, stderr } = await runCli(
      JSON.stringify({ memberId: '10001', accountType: 'Savings', initialDeposit: '250.00' }),
    );

    const lines = stdout.split(String.fromCharCode(10)).filter((line) => line.trim() !== '');
    expect(lines, 'stderr was: ' + stderr.slice(-2000)).toHaveLength(1);

    const parsed = JSON.parse(lines[0] ?? '') as {
      status?: string;
      metrics?: { llmCalls?: number };
    };
    expect(typeof parsed.status).toBe('string');
    expect(parsed.metrics?.llmCalls).toBe(0);
  }, 180_000);

  it('[MUST] the CALLER channel is not redacted, and the LOG channel is', async () => {
    // ==========================================================================================
    // MECHANISM 3, WHICH IS THE ONE PEOPLE GET WRONG BY BEING HELPFUL.
    // ==========================================================================================
    //
    // The brief requires replay to RETURN what it read. A capability that pseudonymizes its own
    // return value is useless to the agent that called it: it asked what the review status is, and
    // "[reviewStatus:subject-01]" is not an answer.
    //
    // So the three channels differ ON PURPOSE:
    //   --json on stdout   real typed outputs
    //   stderr, for a human  pseudonymized
    //   evidence on disk     pseudonymized
    //
    // Asserting both halves in one test is the point: either alone would let the other regress.
    const { stdout, stderr } = await runCli(
      JSON.stringify({ memberId: '10001', accountType: 'Savings', initialDeposit: '250.00' }),
    );

    const line = stdout.split(String.fromCharCode(10)).find((entry) => entry.trim() !== '') ?? '';
    const parsed = JSON.parse(line) as {
      status?: string;
      outputs?: Record<string, unknown>;
    };

    if (parsed.status === 'success') {
      // The real values, unredacted, on the machine channel.
      expect(parsed.outputs?.['memberName']).toBe('Avery Lin');
      expect(JSON.stringify(parsed.outputs)).not.toContain('subject-');
    }

    // With --json there IS no human channel, so this alone proves nothing. The test below is the
    // one that actually holds mechanism 2 up.
    expect(stderr).not.toContain('Avery Lin');
  }, 180_000);

  it('[MUST] the HUMAN channel is pseudonymized, with --json off and stderr actually populated', async () => {
    // ==========================================================================================
    // THE TEST THE ONE ABOVE ONLY LOOKED LIKE.
    // ==========================================================================================
    //
    // Without --json the CLI writes its whole report to stderr, including `formatResultForHuman`,
    // which prints every declared output beside its name. That is the channel the claim in
    // docs/DATA_HANDLING.md is about, and it is the channel no test had ever produced.
    //
    // The first assertion is the guard on the test itself: if stderr is empty, the rest is vacuous,
    // which is exactly how the defect survived.
    const { stderr, stdout } = await runCli(
      JSON.stringify({ memberId: '10001', accountType: 'Savings', initialDeposit: '250.00' }),
      { json: false },
    );

    expect(stderr.length, 'stderr was empty, so nothing below is being tested').toBeGreaterThan(
      200,
    );
    expect(stdout.trim()).toBe('');

    // Unlike the tests above, this one REQUIRES the run to succeed - the outputs are only printed
    // on the success form, and they are the thing being checked. A vacuous pass is what went wrong
    // here the first time.
    expect(stderr, 'the run did not succeed, so no outputs were printed').toContain('SUCCEEDED');

    // `memberName` is declared `pii` in the spec. Its VALUE is not known until the run has read it,
    // so labelling it means completing the declaration with what the run discovered before anything
    // is printed or written. No shape detector would ever catch a person's name.
    expect(stderr).not.toContain('Avery Lin');
    expect(stderr).toContain('[memberName:');
  }, 180_000);

  it('keeps stdout clean even when the run fails before the browser opens', async () => {
    const { stdout, status } = await runCli(JSON.stringify({ memberId: 'abc' }));

    const lines = stdout.split(String.fromCharCode(10)).filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0] ?? '') as { status?: string; error?: string };
    expect(parsed.status).toBe('failed');
    expect(parsed.error).toBe('INPUT_VALIDATION_FAILED');
    expect(status).toBe(30);
  }, 120_000);

  it('exits 10 for a business outcome, not 30', async () => {
    // "There is no such member" must never page anybody. The exit code is where a calling system
    // sees that distinction, and it is the reason detectors are checked inside the wait loop.
    const { stdout, status } = await runCli(
      JSON.stringify({ memberId: '99999', accountType: 'Savings', initialDeposit: '250.00' }),
    );

    const lines = stdout.split(String.fromCharCode(10)).filter((line) => line.trim() !== '');
    const parsed = JSON.parse(lines[0] ?? '') as { status?: string; outcome?: string };

    expect(parsed.status).toBe('business_outcome');
    expect(parsed.outcome).toBe('MEMBER_NOT_FOUND');
    expect(status).toBe(10);
  }, 180_000);

  it('the example artifact on disk is what the CLI loaded', () => {
    const onDisk = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as { schemaVersion?: number };
    expect(onDisk.schemaVersion).toBe(2);
  });
});
