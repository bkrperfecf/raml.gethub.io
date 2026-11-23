import { lineCount } from './jsSplitter';

export interface CssScan {
  ok: boolean;
  error?: string;
  /** offsets just after a top-level `}` or top-level `;` */
  boundaries: number[];
}

/** Single linear pass tracking comments, strings, url(...) and brace depth. */
export function scanCss(css: string): CssScan {
  const n = css.length;
  const boundaries: number[] = [];
  let depth = 0;
  let i = 0;
  const fail = (error: string): CssScan => ({ ok: false, error, boundaries });

  while (i < n) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const e = css.indexOf('*/', i + 2);
      if (e === -1) return fail('Unterminated /* comment');
      i = e + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        const c = css[j];
        if (c === '\\') j += 2;
        else if (c === ch) break;
        else if (c === '\n') break;
        else j++;
      }
      if (j >= n) return fail('Unterminated string');
      i = css[j] === ch ? j + 1 : j;
      continue;
    }
    if ((ch === 'u' || ch === 'U') && css.substr(i, 4).toLowerCase() === 'url(' && !/[\w-]/.test(css[i - 1] ?? ' ')) {
      let j = i + 4;
      while (j < n && /\s/.test(css[j])) j++;
      if (css[j] === '"' || css[j] === "'") {
        i = j; // quoted: regular string handling, then ')' falls through
        continue;
      }
      const e = css.indexOf(')', j);
      if (e === -1) return fail('Unterminated url(');
      i = e + 1;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < 0) return fail('Unbalanced closing brace');
      if (depth === 0) boundaries.push(i + 1);
    } else if (ch === ';' && depth === 0) boundaries.push(i + 1);
    i++;
  }
  if (depth !== 0) return fail('Unbalanced braces (depth ' + depth + ' at end)');
  return { ok: true, boundaries };
}

export interface CssPlan {
  chunks: string[];
  error?: string;
  keptReason?: string;
}

export function planCss(css: string, maxLines: number): CssPlan {
  const scan = scanCss(css);
  if (!scan.ok) return { chunks: [css], error: scan.error, keptReason: 'CSS structure scan failed - kept intact' };
  if (lineCount(css) <= maxLines || scan.boundaries.length < 2) return { chunks: [css] };

  const starts: number[] = [0];
  for (let i = 0; i < css.length; i++) if (css.charCodeAt(i) === 10) starts.push(i + 1);
  const lineAt = (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // extend each boundary over trailing blanks + one newline so cuts land on line starts
  const cuts = scan.boundaries.map((b) => {
    const m = /^[ \t]*(\r?\n)/.exec(css.slice(b, b + 200));
    return m ? b + m[0].length : b;
  });

  const chunks: string[] = [];
  let start = 0;
  let prev = -1;
  for (const c of cuts) {
    if (c >= css.length) break;
    const lines = lineAt(Math.max(c - 1, start)) - lineAt(start) + 1;
    if (lines > maxLines && prev > start) {
      chunks.push(css.slice(start, prev));
      start = prev;
    }
    prev = c;
  }
  chunks.push(css.slice(start));
  return { chunks };
}

/** Relative url()/@import references would resolve against css/ instead of the page once moved. */
export function relativeCssUrls(css: string): string[] {
  const found: string[] = [];
  const isRel = (u: string) => {
    const v = u.trim();
    return v !== '' && !/^([a-z][a-z0-9+.-]*:|\/|#|var\()/i.test(v);
  };
  const urlRe = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(css))) {
    const u = m[1] ?? m[2] ?? m[3] ?? '';
    if (isRel(u)) found.push(u.trim());
  }
  const impRe = /@import\s+(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = impRe.exec(css))) {
    const u = m[1] ?? m[2] ?? '';
    if (isRel(u)) found.push(u.trim());
  }
  return found;
}
