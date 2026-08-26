/**
 * A count of calls made to a model provider, by ANY engine in this process.
 *
 * This is the RUNTIME layer of the no-LLM proof. Replay snapshots it before and after a run and
 * asserts the delta is zero.
 *
 * It is a COUNTER, not a mode flag. A module-global "we are replaying now" switch breaks the
 * moment discovery and replay share a process - and they will, in any service that offers both -
 * because the flag describes the process rather than the run. A counter is a fact about what
 * happened, and it stays true no matter who else is running alongside.
 *
 * Nothing here imports a provider SDK, so replay can depend on it without dragging one in.
 */
let calls = 0;

export function recordProviderCall(): void {
  calls += 1;
}

export function providerCallCount(): number {
  return calls;
}
