/**
 * A minimal JSONC reader, for the ONE complete artifact embedded in docs/SCHEMA.md.
 *
 * It exists so the documentation can be prose-formatted by prettier and still be machine-checked.
 * Prettier formats embedded code blocks and adds trailing commas, which strict JSON rejects, so a
 * naive `JSON.parse` on the block breaks every time the docs are reformatted.
 *
 * Two rules, and both are deliberately narrow:
 *
 *   COMMENTS ARE STRIPPED BY LINE, not by scanning. Comments in that block are always on their own
 *   line, never trailing a value. `entryPoint` contains "http://", and a scanning stripper cuts the
 *   URL in half and then reports a confusing parse error three fields later.
 *
 *   TRAILING COMMAS are removed by a scan that tracks string literals, because a comma inside a
 *   description is not a trailing comma.
 */
export function jsoncToJson(text: string): string {
  const withoutComments = text
    .split(String.fromCharCode(10))
    .filter((line) => !line.trim().startsWith('//'))
    .join(String.fromCharCode(10));

  const BACKSLASH = String.fromCharCode(92);
  const out: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < withoutComments.length; i += 1) {
    const ch = withoutComments[i] ?? '';

    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === BACKSLASH) escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out.push(ch);
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < withoutComments.length && (withoutComments[j] ?? '').trim() === '') j += 1;
      const next = withoutComments[j];
      if (next === '}' || next === ']') continue;
    }

    out.push(ch);
  }

  return out.join('');
}
