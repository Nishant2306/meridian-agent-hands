import { isCompatibleScreenContext } from '../perception/screen-identity.js';
import type { SurfaceAction } from '../types/action.js';
import type { TargetDescriptor } from '../types/control.js';
import type { Observation, PerceivedControl } from '../types/perception.js';
import type { ResolutionFailureCode } from '../types/resolution.js';
import type { ProposalRejectionCode } from '../types/outcomes.js';
import type { TargetResolver } from '../types/surface.js';
import type { ValueBinding } from '../types/values.js';
import { bindDescriptor } from '../perception/bind.js';
import { buildDescriptor } from './descriptors.js';

/**
 * ==============================================================================================
 * [MUST] CONVERSION AND VALIDATION, BEFORE ANYTHING IS ACTED ON.
 * ==============================================================================================
 *
 * A proposal arrives as a mark id. Six things happen before the browser is touched:
 *
 *   1  look the mark up in the EXACT observation the model reasoned over, by observationId
 *   2  build a full TargetDescriptor from that PerceivedControl
 *   3  capture a FRESH observation
 *   3.5 CHECK SCREEN CONTEXT COMPATIBILITY
 *   4  resolve the DESCRIPTOR - through the same TargetResolver replay will use
 *   5  on failure, ambiguity or conflict, reject and feed the reason back to the model
 *   6  only then act
 *
 * Step 4 is doing more work than it looks like. It proves, DURING DISCOVERY, that every descriptor
 * about to be recorded is resolvable by the replay engine. A descriptor that only ever worked as a
 * mark lookup gets caught here, on the run that would have produced it, rather than during a demo.
 *
 * [MUST] STEP 3.5 IS NOT REDUNDANT WITH STEP 4.
 *
 * Re-resolving does not catch a page change on its own. A different screen may also contain a
 * button named "Continue", or "Search", or a link named "Open" - this application has several -
 * and the descriptor would resolve perfectly, to the wrong control, on the wrong screen. So the
 * screen the proposal was FORMED against is compared with the screen in front of us now.
 * Incompatible means the proposal is stale: reject with STALE_OBSERVATION_CONTEXT, re-observe, and
 * continue the loop. That code is a ProposalRejection, not an ErrorCode, because the loop recovers.
 */
export type ProposalRejectionReason =
  ProposalRejectionCode | ResolutionFailureCode | 'UNKNOWN_MARK' | 'UNDESCRIBABLE_CONTROL';

export interface ProposalRejection {
  code: ProposalRejectionReason;
  reason: string;
}

export type ConvertedProposal =
  | {
      ok: true;
      action: SurfaceAction;
      descriptor: TargetDescriptor;
      rationale: string;
      control: PerceivedControl;
    }
  | { ok: false; rejection: ProposalRejection };

export interface ConvertProposalInput {
  sourceObservation: Observation;
  freshObservation: Observation;
  markId: number;
  kind: 'click' | 'type' | 'select' | 'read';
  value?: ValueBinding;
  resolver: TargetResolver;
  runtimeValues: readonly string[];
  runtimeInputs: Readonly<Record<string, string>>;
}

export function convertProposal(input: ConvertProposalInput): ConvertedProposal {
  // 1. The mark belongs to ONE observation. Looking it up anywhere else is how mark ids leak.
  const control = input.sourceObservation.controls.find(
    (candidate) => candidate.markId === input.markId,
  );
  if (control === undefined) {
    return {
      ok: false,
      rejection: {
        code: 'UNKNOWN_MARK',
        reason:
          'mark ' +
          input.markId +
          ' is not in the inventory you were shown (' +
          input.sourceObservation.observationId +
          '). Mark ids are only valid for the inventory ' +
          'they came with.',
      },
    };
  }

  // 3.5. Screen context, BEFORE resolution. See the banner above for why this ordering matters.
  if (!isCompatibleScreenContext(input.sourceObservation, input.freshObservation)) {
    return {
      ok: false,
      rejection: {
        code: 'STALE_OBSERVATION_CONTEXT',
        reason:
          'that proposal was formed against the screen "' +
          input.sourceObservation.screenIdentity.canonicalScreenName +
          '", and the screen is now "' +
          input.freshObservation.screenIdentity.canonicalScreenName +
          '". Look at the current inventory and choose again.',
      },
    };
  }

  // 2. Build the descriptor from what was perceived.
  const built = buildDescriptor(control, {
    observation: input.sourceObservation,
    resolver: input.resolver,
    runtimeValues: input.runtimeValues,
    runtimeInputs: input.runtimeInputs,
  });

  if ('error' in built) {
    return { ok: false, rejection: { code: 'UNDESCRIBABLE_CONTROL', reason: built.error } };
  }

  // 4. Resolve the DESCRIPTOR against the fresh screen, through the resolver replay will use.
  const resolution = input.resolver.resolve(
    input.freshObservation,
    bindDescriptor(built.descriptor, input.runtimeInputs),
  );
  if (!resolution.ok) {
    return {
      ok: false,
      rejection: {
        code: resolution.error,
        reason:
          'the control you chose could not be identified on the current screen: ' +
          resolution.detail,
      },
    };
  }

  const action: SurfaceAction =
    input.kind === 'click'
      ? { type: 'click', target: built.descriptor }
      : input.kind === 'read'
        ? { type: 'read', target: built.descriptor }
        : input.kind === 'type'
          ? {
              type: 'type',
              target: built.descriptor,
              value: input.value ?? { kind: 'literal', value: '' },
            }
          : {
              type: 'select',
              target: built.descriptor,
              value: input.value ?? { kind: 'literal', value: '' },
            };

  return { ok: true, action, descriptor: built.descriptor, rationale: built.rationale, control };
}
