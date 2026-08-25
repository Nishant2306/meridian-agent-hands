/**
 * The project's vocabulary.
 *
 * Everything downstream (perception, discovery, distillation, replay, policy, evidence) speaks
 * these types and only these types. If a concept is not expressible here, that is a signal to
 * change the vocabulary deliberately, not to widen a signature with `unknown` at the call site.
 */

export * from './values.js';
export * from './money.js';
export * from './risk.js';
export * from './control.js';
export * from './action.js';
export * from './assertion.js';
export * from './outcomes.js';
export * from './run.js';
export * from './spec.js';
export * from './perception.js';
export * from './resolution.js';
export * from './session.js';
export * from './surface.js';
export * from './proposal.js';
export * from './discovery.js';
export * from './normalize.js';
