import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declarationFor } from '../../src/redaction/declaration.js';
import { EvidenceWriter } from '../../src/evidence/logger.js';
import { Pseudonymizer } from '../../src/redaction/pseudonymize.js';

/**
 * ================================================================================================
 * THE DECLARATION HAS TO BE COMPLETED WITH WHAT THE RUN READ.
 * ================================================================================================
 *
 * Both defects this covers were found by `npm run evidence:verify` on the first successful evidence
 * bundle, which is the gate doing exactly what it is for:
 *
 *   discovery/.../result.json          carried "Avery Lin"
 *   discovery/.../0001.mask.json       carried "10001"
 *
 * The first because the discovery CLI never added the bound OUTPUTS to its declaration - the replay
 * CLI had done so since D73 and the two had been written separately. The second because the mask
 * manifest describes the control it covered, and the natural way to describe a control showing a
 * member id is to quote the member id: the file recording the masking was leaking the value the
 * mask exists to hide.
 */
const INPUTS = [
  { name: 'memberId', sensitivity: 'pii' },
  { name: 'accountType', sensitivity: 'public' },
  { name: 'initialDeposit', sensitivity: 'pii' },
];
const OUTPUTS = [
  { name: 'memberName', sensitivity: 'pii' },
  { name: 'reviewStatus', sensitivity: 'public' },
];
const PARAMS = { memberId: '10001', accountType: 'Savings', initialDeposit: '250.00' };

describe('the sensitivity declaration', () => {
  it('names declared-sensitive outputs before the run has read them', () => {
    // Naming is not protecting: there is no value to replace yet. But the NAME has to be there so
    // masking knows which controls to cover while the run is still going.
    const declaration = declarationFor({
      inputs: INPUTS,
      outputs: OUTPUTS,
      recordIdentityParam: 'memberId',
      params: PARAMS,
    });

    expect([...declaration.sensitiveNames].sort()).toEqual([
      'initialDeposit',
      'memberId',
      'memberName',
    ]);
    expect(declaration.values.get('memberName')).toBeUndefined();
  });

  it('[MUST] takes the value once the run has read it', () => {
    const declaration = declarationFor({
      inputs: INPUTS,
      outputs: OUTPUTS,
      recordIdentityParam: 'memberId',
      params: PARAMS,
      read: { memberName: 'Avery Lin', reviewStatus: 'PENDING REVIEW' },
    });

    expect(declaration.values.get('memberName')).toBe('Avery Lin');
    // `reviewStatus` is declared PUBLIC. It is a contract enum and labelling it would be theatre.
    expect(declaration.values.has('reviewStatus')).toBe(false);
  });

  it('ignores a value that is not text, because there is nothing to search for', () => {
    // A currency output is stored as minor units. Replacing "25000" wherever it appears would hit
    // timestamps and reference numbers, which is how a redactor becomes something people turn off.
    const declaration = declarationFor({
      inputs: INPUTS,
      outputs: [...OUTPUTS, { name: 'balance', sensitivity: 'pii' }],
      recordIdentityParam: 'memberId',
      params: PARAMS,
      read: { balance: { currency: 'USD', minorUnits: 25000 }, memberName: '' },
    });

    expect(declaration.values.has('balance')).toBe(false);
    expect(declaration.values.has('memberName')).toBe(false);
  });

  it('[MUST] a mask manifest does not carry the value the mask covers', () => {
    // The manifest is a persisted TEXT file and it was being written around the one seam. It goes
    // through the pseudonymizer now, like every other persisted file.
    const writer = new EvidenceWriter({
      runId: 'mask-manifest',
      rootDir: mkdtempSync(join(tmpdir(), 'mask-manifest-')),
      pseudonymizer: new Pseudonymizer(),
    });
    writer.declareSensitive(
      declarationFor({
        inputs: INPUTS,
        outputs: OUTPUTS,
        recordIdentityParam: 'memberId',
        params: PARAMS,
      }),
    );

    const written = writer.writeJson('probe.json', {
      maskedRegions: [
        {
          descriptorRef: 'cell "10001" near "Member ID"',
          reason: 'record-identity',
          rect: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
      refused: [],
    });

    const text = readFileSync(join(writer.runDir, 'probe.json'), 'utf8');
    expect(written).toContain('probe.json');
    expect(text).not.toContain('10001');
    expect(text).toContain('[memberId:');
    // The geometry is untouched: a redactor that mangled the boxes would be worse than none.
    expect(text).toContain('"width": 3');
  });
});
