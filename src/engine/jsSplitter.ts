import * as acorn from 'acorn';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function lineCount(s: string): number {
  if (!s.length) return 0;
  let c = 1;
  let i = -1;
  while ((i = s.indexOf('\n', i + 1)) !== -1) c++;
  return c;
}

function makeLineIndex(code: string): (pos: number) => number {
  const starts: number[] = [0];
  let i = -1;
  while ((i = code.indexOf('\n', i + 1)) !== -1) starts.push(i + 1);
  return (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

export interface SyntaxResult {
  ok: boolean;
  error?: string;
}

export function validateJs(code: string, isModule: boolean): SyntaxResult {
  try {
    acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: isModule ? 'module' : 'script',
      allowHashBang: true,
    });
    return { ok: true };
  } catch (e: any) {
    const loc = e?.loc ? ` (line ${e.loc.line}, col ${e.loc.column})` : '';
    return { ok: false, error: String(e?.message ?? e).replace(/\s*\(\d+:\d+\)$/, '') + loc };
  }
}

export interface JsPlan {
  chunks: string[];
  /** how many chunks the plain size limit asked for, before the hoisting guard merged some */
  requested: number;
  /** why the script was kept as one piece (if it was) */
  keptReason?: string;
  /** parse failure of the ORIGINAL block (so it is kept intact) */
  sourceError?: string;
  /** human-readable notes */
  notes: string[];
}

/* ------------------------------------------------------------------ AST helpers */

function* childNodes(node: any): Generator<{ child: any; key: string }> {
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const it of v) if (it && typeof it.type === 'string') yield { child: it, key };
    } else if (v && typeof v.type === 'string') yield { child: v, key };
  }
}

const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function isRefIdentifier(parent: any, key: string): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression':
      return !(key === 'property' && !parent.computed);
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return !(key === 'key' && !parent.computed);
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key !== 'label';
    default:
      return true;
  }
}

/** every identifier mentioned anywhere inside node (over-approximation; ignores scoping on purpose) */
function deepIds(node: any, out: Set<string>, parent: any = null, key = ''): void {
  if (node.type === 'Identifier') {
    if (isRefIdentifier(parent, key)) out.add(node.name);
    return;
  }
  for (const { child, key: k } of childNodes(node)) deepIds(child, out, node, k);
}

/** identifiers evaluated EAGERLY when the statement runs (function bodies are deferred, except IIFEs) */
function eagerIds(node: any, out: Set<string>, parent: any = null, key = ''): void {
  if (node.type === 'Identifier') {
    if (isRefIdentifier(parent, key)) out.add(node.name);
    return;
  }
  if (FN_TYPES.has(node.type)) {
    const iife = parent && parent.type === 'CallExpression' && key === 'callee';
    if (!iife) {
      // default param values are evaluated at call time -> deferred as well
      return;
    }
  }
  if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') {
    // class members run later; only computed keys are eager
    if (node.computed) eagerIds(node.key, out, node, 'key');
    return;
  }
  if (node.type === 'Property' && node.method) {
    if (node.computed) eagerIds(node.key, out, node, 'key');
    return;
  }
  for (const { child, key: k } of childNodes(node)) eagerIds(child, out, node, k);
}

function patternNames(p: any, out: string[]): void {
  if (!p) return;
  switch (p.type) {
    case 'Identifier':
      out.push(p.name);
      break;
    case 'ObjectPattern':
      for (const pr of p.properties) patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out);
      break;
    case 'ArrayPattern':
      for (const el of p.elements) patternNames(el, out);
      break;
    case 'AssignmentPattern':
      patternNames(p.left, out);
      break;
    case 'RestElement':
      patternNames(p.argument, out);
      break;
  }
}

/** names hoisted to the top of the script (function declarations + var), ignoring nested functions */
function hoistedNames(node: any, out: string[], top = true): void {
  if (node.type === 'FunctionDeclaration') {
    if (node.id) out.push(node.id.name);
    return;
  }
  if (FN_TYPES.has(node.type)) return;
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const d of node.declarations) patternNames(d.id, out);
  }
  if (node.type === 'ClassDeclaration' && !top) return;
  for (const { child } of childNodes(node)) hoistedNames(child, out, false);
}

/* ------------------------------------------------------------------ classic splitting */

export function planClassic(code: string, maxLines: number, hoistGuard: boolean): JsPlan {
  const plan: JsPlan = { chunks: [code], requested: 1, notes: [] };
  const total = lineCount(code);
  const comments: { start: number; end: number }[] = [];
  let ast: any;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true,
      onComment: (_b: boolean, _t: string, start: number, end: number) => {
        comments.push({ start, end });
      },
    });
  } catch (e: any) {
    const v = validateJs(code, false);
    plan.sourceError = v.error ?? String(e?.message ?? e);
    plan.keptReason = 'Acorn could not parse this block - kept intact (no AST-safe boundaries available)';
    return plan;
  }
  if (total <= maxLines) return plan;

  const stmts: any[] = ast.body;
  if (stmts.length < 2) {
    plan.keptReason = 'Single top-level statement (e.g. one big IIFE) - cannot be split without cutting inside it';
    return plan;
  }
  const first = stmts[0];
  if (first.type === 'ExpressionStatement' && typeof first.directive === 'string') {
    plan.keptReason = `Starts with the "${first.directive}" directive - splitting would silently drop it from later files`;
    return plan;
  }

  const lineAt = makeLineIndex(code);

  // boundary (start offset of chunk) before statement i: include own-line leading comments
  const boundary = (i: number): number => {
    if (i === 0) return 0;
    const prevEnd = stmts[i - 1].end;
    let b = stmts[i].start;
    // last comment ending at or before b
    let lo = 0;
    let hi = comments.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (comments[mid].end <= b) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (; idx >= 0; idx--) {
      const c = comments[idx];
      if (c.start < prevEnd) break;
      if (!/^\s*$/.test(code.slice(c.end, b))) break;
      const ls = code.lastIndexOf('\n', c.start - 1) + 1;
      if (ls < prevEnd || !/^[ \t]*$/.test(code.slice(ls, c.start))) break;
      b = ls;
    }
    const ls = code.lastIndexOf('\n', b - 1) + 1;
    if (ls >= prevEnd && /^[ \t]*$/.test(code.slice(ls, b))) b = ls;
    return b;
  };

  // 1. greedy size-based plan
  let starts: number[] = [0];
  let curPos = 0;
  for (let i = 1; i < stmts.length; i++) {
    const lines = lineAt(stmts[i].end) - lineAt(curPos) + 1;
    if (lines > maxLines) {
      starts.push(i);
      curPos = boundary(i);
    }
  }
  plan.requested = starts.length;
  if (starts.length === 1) {
    plan.keptReason = 'Top-level statements are individually larger than the limit - kept intact';
    return plan;
  }

  // 2. hoisting guard: function/var hoisting works across a whole <script> but NOT across files
  if (hoistGuard) {
    const eager: Set<string>[] = [];
    const deep = new Map<string, Set<string>>();
    const hoistMin = new Map<string, number>();
    const addDeep = (name: string, node: any) => {
      let s = deep.get(name);
      if (!s) deep.set(name, (s = new Set()));
      deepIds(node, s);
    };
    stmts.forEach((st, i) => {
      const e = new Set<string>();
      if (st.type !== 'FunctionDeclaration') eagerIds(st, e);
      eager.push(e);
      const hn: string[] = [];
      hoistedNames(st, hn);
      for (const n of hn) if (!hoistMin.has(n)) hoistMin.set(n, i);
      if (st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') {
        if (st.id) addDeep(st.id.name, st);
      } else if (st.type === 'VariableDeclaration') {
        for (const d of st.declarations) {
          const names: string[] = [];
          patternNames(d.id, names);
          if (d.init) for (const nm of names) addDeep(nm, d.init);
        }
      }
    });

    let guard = 0;
    for (;;) {
      if (++guard > 5000) break;
      const chunkOf = new Int32Array(stmts.length);
      starts.forEach((s, ci) => {
        const e = ci + 1 < starts.length ? starts[ci + 1] : stmts.length;
        for (let i = s; i < e; i++) chunkOf[i] = ci;
      });
      let violation: [number, number] | null = null;
      for (let ci = 0; ci < starts.length && !violation; ci++) {
        const e = ci + 1 < starts.length ? starts[ci + 1] : stmts.length;
        const queue: string[] = [];
        const seen = new Set<string>();
        for (let i = starts[ci]; i < e; i++) for (const n of eager[i]) if (!seen.has(n)) (seen.add(n), queue.push(n));
        while (queue.length && !violation) {
          const name = queue.pop()!;
          const h = hoistMin.get(name);
          if (h !== undefined && chunkOf[h] > ci) {
            violation = [ci, chunkOf[h]];
            break;
          }
          const d = deep.get(name);
          if (d) for (const n of d) if (!seen.has(n)) (seen.add(n), queue.push(n));
        }
      }
      if (!violation) break;
      const [a, b] = violation;
      starts = starts.filter((_, ci) => ci <= a || ci > b);
    }
    if (starts.length < plan.requested) {
      plan.notes.push(
        `Hoisting guard merged ${plan.requested} planned chunks into ${starts.length}: top-level code references function/var declarations that sit in a later chunk (hoisting does not cross file boundaries).`,
      );
    }
    if (starts.length === 1) {
      plan.keptReason = 'Hoisting guard: forward references between chunks - kept intact to guarantee identical behaviour';
      return plan;
    }
  }

  const cuts = starts.map((s) => boundary(s));
  const chunks: string[] = [];
  for (let k = 0; k < cuts.length; k++) chunks.push(code.slice(cuts[k], k + 1 < cuts.length ? cuts[k + 1] : code.length));
  plan.chunks = chunks;
  return plan;
}

/* ------------------------------------------------------------------ module inspection */

export function moduleRelativeImports(code: string): string[] {
  const rel: string[] = [];
  try {
    const ast: any = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    const visit = (node: any) => {
      if (
        (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
          (node.type === 'ExportNamedDeclaration' && node.source)) &&
        node.source && typeof node.source.value === 'string'
      ) {
        const v: string = node.source.value;
        if (/^\.{1,2}\//.test(v)) rel.push(v);
      }
      if (node.type === 'ImportExpression' && node.source?.type === 'Literal' && typeof node.source.value === 'string') {
        if (/^\.{1,2}\//.test(node.source.value)) rel.push(node.source.value);
      }
    };
    for (const st of ast.body) visit(st);
    // dynamic import() anywhere
    const walk = (n: any) => {
      if (n.type === 'ImportExpression') visit(n);
      for (const { child } of childNodes(n)) walk(child);
    };
    for (const st of ast.body) walk(st);
  } catch {
    /* handled by validateJs */
  }
  return rel;
}

export function scanCompatHints(code: string): string[] {
  const hints: string[] = [];
  if (/\bdocument\.write(ln)?\s*\(/.test(code)) hints.push('document.write()');
  if (/\bdocument\.currentScript\b/.test(code)) hints.push('document.currentScript');
  if (/\bdocument\.scripts\b|querySelector(All)?\(\s*['"]script/.test(code)) hints.push('script-element lookups');
  if (/\bimport\.meta\b/.test(code)) hints.push('import.meta');
  return hints;
}
