/**
 * Raw-offset HTML scanner.
 *
 * We deliberately do NOT use DOMParser/innerHTML round-trips: they normalise markup
 * (attribute quoting, entity handling, implied tags...). Instead this scanner tokenises
 * the source and records exact character offsets, so every output file is produced with
 * `source.slice(start, end)` and nothing is ever regenerated.
 */

export interface Attr {
  name: string;
  lname: string;
  value: string | null;
  /** Exact source text of this attribute, e.g. `data-x='1'` */
  raw: string;
}

export type TokenType = 'text' | 'comment' | 'doctype' | 'open' | 'close' | 'rawtext';

export interface Token {
  type: TokenType;
  start: number;
  end: number;
  name?: string;
  attrs?: Attr[];
  selfClosing?: boolean;
}

export interface ElNode {
  name: string;
  start: number;
  end: number;
  /** end offset of the opening tag */
  openEnd: number;
  /** start offset of closing tag, or -1 when void / implicitly closed */
  closeStart: number;
  attrs: Attr[];
  children: ElNode[];
}

export interface Unit {
  kind: 'element' | 'comment' | 'text' | 'doctype' | 'close';
  start: number;
  end: number;
  name?: string;
  node?: ElNode;
}

export const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
  'source', 'track', 'wbr', 'basefont', 'bgsound', 'frame', 'keygen',
]);

/** Elements whose content is raw text (no child tags are parsed). */
const RAW = new Set([
  'script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'noembed', 'noframes', 'iframe',
]);

const rawCloseRe: Record<string, RegExp> = {};
function closeRe(name: string): RegExp {
  return (rawCloseRe[name] ??= new RegExp('</' + name + '(?=[\\s/>])', 'ig'));
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(s: string): Attr[] {
  const out: Attr[] = [];
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s))) {
    const value = m[2] ?? m[3] ?? m[4] ?? null;
    out.push({ name: m[1], lname: m[1].toLowerCase(), value, raw: m[0] });
  }
  return out;
}

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  const flush = (end: number) => {
    if (end > textStart) toks.push({ type: 'text', start: textStart, end });
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) break;
    const c = src.charCodeAt(lt + 1);

    if (c === 33 && src.startsWith('<!--', lt)) {
      let e = src.indexOf('-->', lt + 4);
      e = e === -1 ? n : e + 3;
      flush(lt);
      toks.push({ type: 'comment', start: lt, end: e });
      i = textStart = e;
      continue;
    }
    if (c === 33 || c === 63) {
      let e = src.indexOf('>', lt + 2);
      e = e === -1 ? n : e + 1;
      flush(lt);
      toks.push({ type: 'doctype', start: lt, end: e });
      i = textStart = e;
      continue;
    }
    if (c === 47) {
      const m = /^<\/([A-Za-z][^\s/>]*)/.exec(src.slice(lt, lt + 80));
      if (m) {
        let e = src.indexOf('>', lt);
        e = e === -1 ? n : e + 1;
        flush(lt);
        toks.push({ type: 'close', start: lt, end: e, name: m[1].toLowerCase() });
        i = textStart = e;
        continue;
      }
      i = lt + 1;
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      let j = lt + 1;
      while (j < n) {
        const cc = src.charCodeAt(j);
        if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 12 || cc === 47 || cc === 62) break;
        j++;
      }
      const name = src.slice(lt + 1, j).toLowerCase();
      let quote = 0;
      let prevSig = 0;
      let k = j;
      for (; k < n; k++) {
        const ch = src.charCodeAt(k);
        if (quote) {
          if (ch === quote) {
            quote = 0;
            prevSig = ch;
          }
          continue;
        }
        if ((ch === 34 || ch === 39) && prevSig === 61) {
          quote = ch;
          continue;
        }
        if (ch === 62) break;
        if (!(ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12)) prevSig = ch;
      }
      const tagEnd = k >= n ? n : k + 1;
      let attrSrc = src.slice(j, k >= n ? n : k);
      const selfClosing = attrSrc.endsWith('/');
      if (selfClosing) attrSrc = attrSrc.slice(0, -1);
      flush(lt);
      toks.push({ type: 'open', start: lt, end: tagEnd, name, attrs: parseAttrs(attrSrc), selfClosing });
      i = textStart = tagEnd;

      if (RAW.has(name)) {
        const re = closeRe(name);
        re.lastIndex = tagEnd;
        const m = re.exec(src);
        if (m) {
          if (m.index > tagEnd) toks.push({ type: 'rawtext', start: tagEnd, end: m.index });
          let e = src.indexOf('>', m.index);
          e = e === -1 ? n : e + 1;
          toks.push({ type: 'close', start: m.index, end: e, name });
          i = textStart = e;
        } else {
          if (n > tagEnd) toks.push({ type: 'rawtext', start: tagEnd, end: n });
          i = textStart = n;
        }
      }
      continue;
    }
    i = lt + 1;
  }
  flush(n);
  return toks;
}

const P_CLOSERS = new Set([
  'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);
const IMPLIED: Record<string, string[]> = {
  li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], option: ['option'],
  tr: ['tr', 'td', 'th'], td: ['td', 'th'], th: ['td', 'th'],
};

function firstTokenIndex(toks: Token[], from: number): number {
  let lo = 0;
  let hi = toks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].start < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Build top-level units (elements with their subtree, comments, text...) within [from, to). */
export function buildUnits(toks: Token[], from: number, to: number): Unit[] {
  const units: Unit[] = [];
  const stack: ElNode[] = [];
  const topUnitOf = new Map<ElNode, Unit>();

  for (let idx = firstTokenIndex(toks, from); idx < toks.length; idx++) {
    const t = toks[idx];
    if (t.start >= to) break;
    if (t.end > to) break;

    if (t.type === 'open') {
      const name = t.name!;
      // implied end tags (minimal, keeps unit boundaries sane for sloppy HTML)
      for (;;) {
        const top = stack[stack.length - 1];
        if (!top) break;
        const closesP = top.name === 'p' && P_CLOSERS.has(name);
        const closesImplied = IMPLIED[name]?.includes(top.name);
        if (closesP || closesImplied) {
          top.end = t.start;
          stack.pop();
          const u = topUnitOf.get(top);
          if (u) u.end = top.end;
        } else break;
      }
      const node: ElNode = {
        name, start: t.start, end: t.end, openEnd: t.end, closeStart: -1,
        attrs: t.attrs ?? [], children: [],
      };
      const foreign = name === 'svg' || name === 'math' || stack.some((s) => s.name === 'svg' || s.name === 'math');
      const leaf = VOID.has(name) || (!!t.selfClosing && foreign && !RAW.has(name));
      if (stack.length) stack[stack.length - 1].children.push(node);
      else {
        const u: Unit = { kind: 'element', start: t.start, end: t.end, name, node };
        units.push(u);
        topUnitOf.set(node, u);
      }
      if (!leaf) stack.push(node);
    } else if (t.type === 'close') {
      const name = t.name!;
      let found = -1;
      for (let s = stack.length - 1; s >= 0; s--) {
        if (stack[s].name === name) {
          found = s;
          break;
        }
      }
      if (found >= 0) {
        for (let s = stack.length - 1; s > found; s--) {
          stack[s].end = t.start;
          const u = topUnitOf.get(stack[s]);
          if (u) u.end = stack[s].end;
        }
        const node = stack[found];
        node.closeStart = t.start;
        node.end = t.end;
        stack.length = found;
        const u = topUnitOf.get(node);
        if (u) u.end = node.end;
      } else if (stack.length === 0) {
        const structural = name === 'body' || name === 'html' || name === 'head';
        units.push({ kind: structural ? 'close' : 'text', start: t.start, end: t.end, name });
      }
    } else if (t.type === 'text' || t.type === 'comment' || t.type === 'doctype') {
      if (stack.length === 0) units.push({ kind: t.type, start: t.start, end: t.end });
    }
    // rawtext is covered by the open/close pair
  }
  for (const node of stack) {
    node.end = to;
    const u = topUnitOf.get(node);
    if (u) u.end = to;
  }
  // merge adjacent text units (stray closing tags next to text)
  const merged: Unit[] = [];
  for (const u of units) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === 'text' && u.kind === 'text' && prev.end === u.start) prev.end = u.end;
    else merged.push(u);
  }
  return merged;
}

export function getAttr(attrs: Attr[], lname: string): string | null | undefined {
  const a = attrs.find((x) => x.lname === lname);
  return a ? a.value ?? '' : undefined;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
