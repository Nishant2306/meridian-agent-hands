import type { ErrorCode } from '../types/outcomes.js';

/**
 * Protocol violations THROW. Operational outcomes are RETURNED.
 *
 * A bad lease or an illegal state transition means the CALLER is broken: some code tried to act
 * without the right to act, or drove the session into a state the machine does not have. There is
 * no sensible way for a discovery loop to "handle" that and continue, and swallowing it would turn
 * the single most important safety property in the system into a log line.
 *
 * A blocked action, a control that could not be found, an application error page: those are things
 * the screen did, and the loop is supposed to react to them. They come back as values.
 */
export class ProtocolViolationError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class LeaseViolationError extends ProtocolViolationError {
  constructor(message: string) {
    super('LEASE_VIOLATION', message);
  }
}

export class IllegalSessionTransitionError extends ProtocolViolationError {
  constructor(message: string) {
    super('INVARIANT_VIOLATED', message);
  }
}
