import { Command } from 'commander';
import {
  approveCapability,
  ApprovalRefusedError,
  ProfileIntegrityError,
} from '../artifact/approve.js';
import { contentHash } from '../artifact/hash.js';
import { FileCapabilityStore } from '../artifact/store.js';

/**
 * `npm run capability:approve -- <capabilityId>@<version> --by "<name>"`
 *
 * Approval VERIFIES the pinned profile hashes, verifies the artifact, and then changes exactly
 * three fields. It prints the content hash before and after, because the whole point is that they
 * are the same number: approval signs an artifact, it does not transform one.
 *
 * `--by` is required and has no default. An approval with nobody's name on it is not an approval,
 * and quietly filling in the logged-in user would make it look like one.
 */
const program = new Command();

program
  .name('capability:approve')
  .description('Verify a distilled capability artifact and mark it approved.')
  .argument('<target>', 'capabilityId@version, e.g. prepare_subaccount_review@1.0.0')
  .requiredOption('--by <name>', 'who is approving this capability')
  .option('--artifacts <dir>', 'artifact store root', 'artifacts')
  .option('--config <dir>', 'profile config root', 'config')
  .action(async (target: string, options: { by: string; artifacts: string; config: string }) => {
    const separator = target.lastIndexOf('@');
    if (separator <= 0) {
      console.error('expected <capabilityId>@<version>, got "' + target + '"');
      process.exitCode = 2;
      return;
    }

    const capabilityId = target.slice(0, separator);
    const version = target.slice(separator + 1);
    const store = new FileCapabilityStore(options.artifacts);

    const before = await store.get(capabilityId, version);
    if (before === undefined) {
      console.error(capabilityId + '@' + version + ' is not in ' + options.artifacts);
      process.exitCode = 2;
      return;
    }

    console.log('capability:   ' + capabilityId + '@' + version);
    console.log('status:       ' + before.status);
    console.log('content hash: ' + contentHash(before) + '  (before)');
    console.log('pins:');
    console.log(
      '  condition   ' + before.profiles.condition.id + '@' + before.profiles.condition.version,
    );
    console.log('              ' + before.profiles.condition.sha256);
    console.log(
      '  safety      ' + before.profiles.safety.id + '@' + before.profiles.safety.version,
    );
    console.log('              ' + before.profiles.safety.sha256);

    try {
      const result = await approveCapability(store, capabilityId, version, options.by, {
        configRoot: options.config,
      });

      console.log('');
      console.log('pins verified against ' + options.config + ', artifact verified.');
      console.log('content hash: ' + result.contentHash + '  (after)');
      console.log('status:       ' + result.artifact.status + ' by ' + options.by);
      console.log('');
      console.log('The two hashes are identical. Approval changed status, approvedAt and');
      console.log('approvedBy, and nothing else.');
    } catch (error) {
      console.error('');
      if (error instanceof ProfileIntegrityError) {
        console.error('PROFILE_INTEGRITY_FAILURE');
        console.error(error.message);
      } else if (error instanceof ApprovalRefusedError) {
        console.error(error.message);
      } else {
        console.error(error instanceof Error ? error.message : String(error));
      }
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
