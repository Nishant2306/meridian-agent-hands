import type { ValueBinding } from '../types/values.js';

/**
 * THE EXECUTOR RESOLVES PARAMS AND SECRETS. THE MODEL NEVER HANDLES A SECRET.
 *
 * A model may propose that a field be filled from `secretRef:'operatorPasscode'`. It never sees,
 * and cannot see, the value behind that name: the binding travels as a NAME through the proposal,
 * the transcript and the artifact, and is exchanged for a value here, inside the adapter, one step
 * before the keystrokes.
 *
 * That is also why `describeBinding` exists. Everything that writes a log line, an evidence event
 * or a CLI message describes the binding rather than printing the value, so a secret cannot reach
 * persistence through a debug statement. Full persistence pseudonymization for PII is PHASE 7;
 * refusing to write secrets down at all is not deferrable, so it is here.
 */
export class MissingBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingBindingError';
  }
}

export interface ValueSources {
  readonly params?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string>>;
}

export class ValueResolver {
  readonly #params: Readonly<Record<string, string>>;
  readonly #secrets: Readonly<Record<string, string>>;

  constructor(sources: ValueSources = {}) {
    this.#params = sources.params ?? {};
    this.#secrets = sources.secrets ?? {};
  }

  resolve(binding: ValueBinding): string {
    switch (binding.kind) {
      case 'literal':
        return binding.value;
      case 'param': {
        const value = this.#params[binding.name];
        if (value === undefined) {
          throw new MissingBindingError('no value supplied for parameter ' + binding.name);
        }
        return value;
      }
      case 'secretRef': {
        const value = this.#secrets[binding.name];
        if (value === undefined) {
          throw new MissingBindingError('no value supplied for secret ' + binding.name);
        }
        return value;
      }
    }
  }
}

/** Safe to log, always. Never returns the value of a secret, and never the value of a param. */
export function describeBinding(binding: ValueBinding): string {
  switch (binding.kind) {
    case 'literal':
      return 'literal';
    case 'param':
      return 'param:' + binding.name;
    case 'secretRef':
      return 'secret:' + binding.name;
  }
}
