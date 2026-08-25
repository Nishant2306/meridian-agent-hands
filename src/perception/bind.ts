import type { TargetDescriptor } from '../types/control.js';
import type { TextMatcher } from '../types/values.js';

/**
 * Replace parameter matchers with the invocation's actual values, before resolution.
 *
 * `TargetResolver.resolve` is pure and takes no invocation values, on purpose: it must behave
 * identically for discovery, for replay and for an assertion evaluated by a detector. So the
 * binding happens one step earlier. A descriptor whose rowKey still says `{kind:'param'}` when it
 * reaches the resolver is a caller bug, and the resolver says so rather than guessing.
 */
export function bindTextMatcher(
  matcher: TextMatcher,
  params: Readonly<Record<string, string>>,
): TextMatcher {
  if (matcher.kind === 'literal') return matcher;
  const value = params[matcher.name];
  return value === undefined ? matcher : { kind: 'literal', value };
}

export function bindDescriptor(
  descriptor: TargetDescriptor,
  params: Readonly<Record<string, string>>,
): TargetDescriptor {
  if (descriptor.semantic.rowKey === undefined) return descriptor;

  return {
    ...descriptor,
    semantic: {
      ...descriptor.semantic,
      rowKey: { cellText: bindTextMatcher(descriptor.semantic.rowKey.cellText, params) },
    },
  };
}
