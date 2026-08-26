import type { CapabilityArtifact } from '../artifact/schema.js';
import type { RunResult } from '../types/run.js';
import type { ReplayOutcome, StepOutcome } from './engine.js';

/**
 * ================================================================================================
 * WHAT A HUMAN IS HANDED WHEN A RUN DOES NOT SUCCEED.
 * ================================================================================================
 *
 * The audience is somebody who did not watch the run and cannot re-run it cheaply. The test of this
 * function is whether they can decide what to do next WITHOUT opening the artifact, the evidence
 * bundle, or the code. That means every one of these, and it is a checklist rather than a wish:
 *
 *   which capability      id AND version. "prepare_subaccount_review failed" is not actionable when
 *                         two versions are deployed.
 *   which step            id AND its recorded intent. An id alone sends them to the artifact.
 *   expected vs observed  side by side. A failure is a disagreement, and one half of a disagreement
 *                         is not a diagnosis.
 *   tiers attempted       whether the locator resolved weaker than recorded. That is the difference
 *                         between "the app changed" and "the automation is wrong".
 *   recoveries attempted  what the system already tried, so nobody repeats it by hand.
 *   session alive         decides the next move: sign on again, or go and look at the screen.
 *   evidence path         where the screenshots and the event log are.
 *
 * A SUCCESSFUL run gets the short form. Nobody needs a diagnosis of something that worked.
 */

const NL = String.fromCharCode(10);

function pad(label: string): string {
  return (label + ':').padEnd(20);
}

function tierLine(steps: readonly StepOutcome[]): string {
  const attempted = steps
    .filter((step) => step.tierUsed !== null)
    .map((step) => step.stepId + ' -> ' + step.tierUsed + (step.downgraded ? ' (DOWNGRADED)' : ''));
  return attempted.length === 0 ? 'none reached' : attempted.join(NL + ' '.repeat(20));
}

function recoveryLine(steps: readonly StepOutcome[]): string {
  const tried = steps.flatMap((step) =>
    (step.recoveriesAttempted ?? []).map((id) => id + ' (at ' + step.stepId + ')'),
  );
  return tried.length === 0 ? 'none' : tried.join(', ');
}

function expectedObserved(result: RunResult): { expected: string; observed: string } {
  if (result.status === 'failed') {
    return {
      expected: result.expected ?? '(nothing was expected at this point)',
      observed: result.observed ?? '(nothing was observed)',
    };
  }
  if (result.status === 'business_outcome') {
    return { expected: 'the capability to complete', observed: result.detail };
  }
  if (result.status === 'needs_human') {
    return { expected: 'the capability to complete', observed: result.reason };
  }
  return { expected: '-', observed: '-' };
}

export interface ResultReportInput {
  readonly artifact: Pick<CapabilityArtifact, 'capabilityId' | 'capabilityVersion' | 'steps'>;
  readonly outcome: ReplayOutcome;
}

export function formatResultForHuman(input: ResultReportInput): string {
  const { artifact, outcome } = input;
  const { result, steps } = outcome;
  const capability = artifact.capabilityId + '@' + artifact.capabilityVersion;

  if (result.status === 'success') {
    const outputs = Object.entries(result.outputs);
    return [
      capability + ' SUCCEEDED (' + result.completionMode + ')',
      pad('steps') + steps.length + ', ' + result.metrics.durationMs + 'ms',
      ...outputs.map(([name, value]) => pad('  ' + name) + String(value)),
      pad('evidence') + result.evidenceRef,
    ].join(NL);
  }

  // The stepId is on most failure shapes but not all of them - a business outcome is not about a
  // step. Fall back to the last step that actually ran, which is where the screen came from.
  const stepId =
    'stepId' in result && typeof result.stepId === 'string'
      ? result.stepId
      : (steps[steps.length - 1]?.stepId ?? '(before any step)');
  const step = artifact.steps.find((candidate) => candidate.id === stepId);
  const { expected, observed } = expectedObserved(result);

  const headline =
    result.status === 'business_outcome'
      ? capability + ' returned a BUSINESS OUTCOME: ' + result.outcome
      : result.status === 'needs_human'
        ? capability + ' NEEDS A HUMAN'
        : capability + ' FAILED: ' + ('error' in result ? result.error : result.status);

  return [
    headline,
    '',
    pad('capability') + capability,
    pad('step') + stepId + (step === undefined ? '' : NL + pad('  intent') + step.intent),
    '',
    pad('expected') + expected,
    pad('observed') + observed,
    '',
    pad('tiers attempted') + tierLine(steps),
    pad('recoveries') + recoveryLine(steps),
    pad('session') + (outcome.sessionAlive ? 'still alive' : 'GONE - sign on again to look'),
    pad('evidence') + result.evidenceRef,
  ].join(NL);
}
