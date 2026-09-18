// Parses JSONC (JSON with comments and trailing commas) the way wrangler
// reads its config: comments are stripped outside string literals only, so
// a `//` inside a URL value is left alone.
export function parseJsonc<T>(raw: string): T {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const char = raw.charAt(i);
    if (char === '"') {
      const end = closingQuote(raw, i);
      out += raw.slice(i, end + 1);
      i = end + 1;
    } else if (char === '/' && raw.charAt(i + 1) === '/') {
      i = skipTo(raw, i, '\n');
    } else if (char === '/' && raw.charAt(i + 1) === '*') {
      i = skipTo(raw, i + 2, '*/') + 2;
    } else {
      out += char;
      i += 1;
    }
  }
  return JSON.parse(out.replaceAll(/,(\s*[}\]])/g, '$1')) as T;
}

function closingQuote(raw: string, openAt: number): number {
  let i = openAt + 1;
  while (i < raw.length) {
    const char = raw.charAt(i);
    if (char === '\\') i += 2;
    else if (char === '"') return i;
    else i += 1;
  }
  return raw.length - 1;
}

function skipTo(raw: string, from: number, marker: string): number {
  const at = raw.indexOf(marker, from);
  return at === -1 ? raw.length : at;
}
