import {
  buildUnits, decodeEntities, getAttr, tokenize, VOID,
  type Attr, type ElNode, type Token, type Unit,
} from './htmlScanner';
import { lineCount, moduleRelativeImports, planClassic, scanCompatHints, validateJs } from './jsSplitter';
import { planCss, relativeCssUrls, scanCss } from './cssSplitter';

/* ============================================================== public types */

export interface Options {
  partialMode: 'every' | 'grouped';
  /** grouped mode: close a group once it reaches this many lines */
  partialMinLines: number;
  maxJsLines: number;
  maxCssLines: number;
  extractBodyStyles: boolean;
  keepRelativeCssInline: boolean;
  hoistGuard: boolean;
  atomicScripts: boolean;
}

export const DEFAULT_OPTIONS: Options = {
  partialMode: 'grouped',
  partialMinLines: 150,
  maxJsLines: 1000,
  maxCssLines: 1000,
  extractBodyStyles: true,
  keepRelativeCssInline: true,
  hoistGuard: true,
  atomicScripts: false,
};

export type FileKind = 'html' | 'css' | 'js' | 'json' | 'md' | 'loader';

export interface OutFile {
  path: string;
  content: string;
  kind: FileKind;
  lines: number;
  bytes: number;
  note?: string;
}

export interface Check {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail?: string;
}

export interface Notice {
  level: 'info' | 'warn';
  message: string;
}

export interface Result {
  rootName: string;
  files: OutFile[];
  checks: Check[];
  notices: Notice[];
  stats: {
    inputLines: number;
    inputBytes: number;
    partials: number;
    jsFiles: number;
    cssFiles: number;
    externalScripts: number;
    inlineStylesKept: number;
    ms: number;
  };
}

/* ============================================================== helpers */

const JS_TYPE = /^(?:module|(?:text|application)\/(?:x-)?(?:javascript|ecmascript|jscript|livescript))$/i;

const slug = (s: string, fallback = 'item') => {
  const r = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return r || fallback;
};
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const byteLen = (s: string) => new TextEncoder().encode(s).length;

function lineIndent(src: string, pos: number): string {
  const ls = src.lastIndexOf('\n', pos - 1) + 1;
  const pre = src.slice(ls, pos);
  return /^[ \t]*$/.test(pre) ? pre : '';
}

interface Res {
  kind: 'script' | 'style' | 'link';
  node: ElNode;
  region: 'head' | 'body';
}

function countScripts(node: ElNode): number {
  let c = node.name === 'script' ? 1 : 0;
  for (const ch of node.children) c += countScripts(ch);
  return c;
}

/* ============================================================== main */

export function modularize(
  src: string,
  fileName: string,
  opts: Options,
  loaderSource: string,
): Result {
  const t0 = performance.now();
  const notices: Notice[] = [];
  const checks: Check[] = [];
  const note = (level: Notice['level'], message: string) => notices.push({ level, message });

  const baseName = fileName.replace(/\.[^.]+$/, '');
  const rootName = `${slug(baseName, 'project')}-modular`;

  /* ---------------------------------------------------------- 1. structure */
  const toks: Token[] = tokenize(src);
  const n = src.length;
  const firstOpen = (name: string, before = Infinity) => toks.find((t) => t.type === 'open' && t.name === name && t.start < before);

  const bodyTok = firstOpen('body') ?? null;
  const htmlTok = firstOpen('html') ?? null;
  let headTok = firstOpen('head', bodyTok ? bodyTok.start : Infinity) ?? null;
  if (headTok && htmlTok && headTok.start < htmlTok.start) headTok = null;

  const headishNames = new Set(['meta', 'link', 'title', 'base', 'style', 'script', 'noscript']);
  const firstTokAt = (pos: number) => {
    let lo = 0;
    let hi = toks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (toks[mid].start < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const headEndHeuristic = (from: number): number => {
    let i = firstTokAt(from);
    while (i < toks.length) {
      const t = toks[i];
      if (t.type === 'comment') { i++; continue; }
      if (t.type === 'text') {
        if (/^\s*$/.test(src.slice(t.start, t.end))) { i++; continue; }
        return t.start;
      }
      if (t.type === 'open' && headishNames.has(t.name!)) {
        if (VOID.has(t.name!)) { i++; continue; }
        const name = t.name!;
        i++;
        while (i < toks.length && !(toks[i].type === 'close' && toks[i].name === name)) i++;
        i++;
        continue;
      }
      return t.start;
    }
    return n;
  };

  let headFrom: number;
  const synthHead = !headTok;
  if (headTok) headFrom = headTok.end;
  else if (htmlTok) headFrom = htmlTok.end;
  else {
    let i = 0;
    headFrom = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (t.type === 'doctype' || t.type === 'comment' || (t.type === 'text' && /^\s*$/.test(src.slice(t.start, t.end)))) {
        headFrom = t.end;
        i++;
      } else break;
    }
  }
  const headCloseTok = headTok
    ? toks.find((t) => t.type === 'close' && t.name === 'head' && t.start >= headFrom && (!bodyTok || t.start < bodyTok.start)) ?? null
    : null;

  let headTo: number;
  if (headCloseTok) headTo = headCloseTok.start;
  else if (bodyTok) headTo = bodyTok.start;
  else headTo = headEndHeuristic(headFrom);

  const bodyFrom = bodyTok ? bodyTok.end : headCloseTok ? headCloseTok.end : headTo;

  if (!bodyTok) note('info', 'No explicit <body> tag in the source - a plain <body> was created in index.html (browsers do this implicitly).');
  if (synthHead) note('info', 'No explicit <head> tag in the source - one was created in index.html (browsers do this implicitly).');
  if (!toks.some((t) => t.type === 'doctype' && /^<!doctype/i.test(src.slice(t.start, t.end)))) {
    note('info', 'No <!DOCTYPE> found: output keeps the same (quirks-mode) behaviour; nothing was added.');
  }

  const headUnits = buildUnits(toks, headFrom, headTo);
  const bodyUnits = buildUnits(toks, bodyFrom, n);

  /* ---------------------------------------------------------- 2. collect resources */
  const resources: Res[] = [];
  let scriptsInTemplates = 0;
  const collect = (nodes: ElNode[], region: 'head' | 'body') => {
    for (const node of nodes) {
      if (node.name === 'template') {
        scriptsInTemplates += countScripts(node);
        continue;
      }
      if (node.name === 'script') resources.push({ kind: 'script', node, region });
      else if (node.name === 'style') resources.push({ kind: 'style', node, region });
      else if (node.name === 'link') resources.push({ kind: 'link', node, region });
      else if (node.children.length) collect(node.children, region);
    }
  };
  collect(headUnits.filter((u) => u.kind === 'element').map((u) => u.node!), 'head');
  collect(bodyUnits.filter((u) => u.kind === 'element').map((u) => u.node!), 'body');

  const contentOf = (node: ElNode) => src.slice(node.openEnd, node.closeStart >= 0 ? node.closeStart : node.end);

  /* ---------------------------------------------------------- 3. plan styles & scripts */
  interface CssPiece { inline: boolean; content: string; path?: string; part: number; parts: number }
  interface PlannedStyle { res: Res; pieces: CssPiece[]; origIndex: number }
  interface JsItem { code: string; module: boolean; path?: string; part: number; parts: number; blockNo: number }
  interface ManifestScript {
    src: string; local: boolean; origin: 'head' | 'body'; attrs: [string, string][]; item?: JsItem;
  }

  const styles: PlannedStyle[] = [];
  const scripts: ManifestScript[] = [];
  const jsItems: JsItem[] = [];
  const hoisted: { start: number; text: string }[] = []; // importmaps / body stylesheet links (kept verbatim)
  const removals: { start: number; end: number; region: 'head' | 'body' }[] = [];
  const replacements: { start: number; end: number; style: PlannedStyle }[] = [];
  const bodyStyleHoists: { start: number; style: PlannedStyle }[] = [];
  const validationRows: { label: string; ok: boolean; detail?: string; kind: 'js' | 'css' }[] = [];
  let verbatimJsOk = 0;
  let verbatimJsBad = 0;
  let verbatimCssOk = 0;
  let verbatimCssBad = 0;
  let dataScriptsKept = 0;
  let emptyScriptsDropped = 0;
  let scriptBlockNo = 0;
  let styleBlockNo = 0;
  let inlineStylesKept = 0;
  const orderOffsets: number[] = [];
  const handledHeadNodes = new Set<ElNode>();

  const bodyHasExtractableStyle = (() => {
    if (!opts.extractBodyStyles) return false;
    return resources.some((r) => r.region === 'body' && r.kind === 'style' && styleExtractable(r.node));
  })();

  function styleExtractable(node: ElNode): boolean {
    const type = (getAttr(node.attrs, 'type') ?? '').trim().toLowerCase();
    if (type && type !== 'text/css') return false;
    return contentOf(node).trim().length > 0;
  }

  for (const res of resources) {
    const { node, region } = res;

    /* ---- <link rel=stylesheet> in the body: hoist (only to keep cascade order with hoisted <style>) */
    if (res.kind === 'link') {
      if (region !== 'body' || !bodyHasExtractableStyle) continue;
      const rel = (getAttr(node.attrs, 'rel') ?? '').toLowerCase().split(/\s+/);
      if (!rel.includes('stylesheet')) continue;
      hoisted.push({ start: node.start, text: src.slice(node.start, node.end) });
      removals.push({ start: node.start, end: node.end, region });
      continue;
    }

    /* ---- <style> */
    if (res.kind === 'style') {
      if (region === 'body' && !opts.extractBodyStyles) continue;
      if (!styleExtractable(node)) {
        if (region === 'head') handledHeadNodes.add(node);
        continue;
      }
      styleBlockNo++;
      const css = contentOf(node);
      const plan = planCss(css, opts.maxCssLines);
      if (plan.error) note('warn', `<style> block #${styleBlockNo}: ${plan.error} - kept as one intact file.`);
      else if (plan.chunks.length === 1 && lineCount(css) > opts.maxCssLines) {
        note('info', `<style> block #${styleBlockNo} exceeds ${opts.maxCssLines} lines but has no safe depth-0 boundary to split at.`);
      }
      const joined = plan.chunks.join('');
      if (joined === css) verbatimCssOk++;
      else {
        verbatimCssBad++;
        validationRows.push({ kind: 'css', ok: false, label: `style block #${styleBlockNo}`, detail: 'chunks do not re-join to the original' });
      }
      const idAttr = getAttr(node.attrs, 'id');
      if (idAttr) note('warn', `<style id="${idAttr}"> becomes a <link> element: scripts that read/write that element's textContent will behave differently.`);
      const pieces: CssPiece[] = plan.chunks.map((content, i) => {
        const rel = opts.keepRelativeCssInline ? relativeCssUrls(content) : [];
        if (rel.length) {
          inlineStylesKept++;
          note('info', `CSS chunk ${i + 1}/${plan.chunks.length} of <style> #${styleBlockNo} uses relative URL(s) (${rel.slice(0, 2).join(', ')}${rel.length > 2 ? ', ...' : ''}) - kept inline in index.html so they still resolve against the page.`);
        } else if (relativeCssUrls(content).length) {
          note('warn', `CSS in <style> #${styleBlockNo} has relative url() paths; moved to css/ they resolve relative to css/, not the page.`);
        }
        return { inline: rel.length > 0, content, part: i + 1, parts: plan.chunks.length };
      });
      const ps: PlannedStyle = { res, pieces, origIndex: styleBlockNo };
      styles.push(ps);
      if (region === 'head') {
        replacements.push({ start: node.start, end: node.end, style: ps });
      } else {
        removals.push({ start: node.start, end: node.end, region });
        bodyStyleHoists.push({ start: node.start, style: ps });
      }
      continue;
    }

    /* ---- <script> */
    const typeAttr = (getAttr(node.attrs, 'type') ?? '').trim().toLowerCase();
    const srcAttr = getAttr(node.attrs, 'src');

    if (typeAttr === 'importmap') {
      if (region === 'body') {
        hoisted.push({ start: node.start, text: src.slice(node.start, node.end) });
        removals.push({ start: node.start, end: node.end, region });
        note('info', 'An <script type="importmap"> found in <body> was moved to <head> (import maps are only honoured when present before module loading).');
      } else handledHeadNodes.add(node);
      dataScriptsKept++;
      continue;
    }
    const isModule = typeAttr === 'module';
    const isJs = typeAttr === '' || JS_TYPE.test(typeAttr);
    if (!isJs) {
      dataScriptsKept++; // JSON / templates / text-babel etc: inert, kept verbatim in place
      if (region === 'head') handledHeadNodes.add(node);
      continue;
    }

    orderOffsets.push(node.start);
    const attrs: [string, string][] = node.attrs
      .filter((a: Attr) => a.lname !== 'src')
      .map((a: Attr) => [a.name, decodeEntities(a.value ?? '')]);

    if (srcAttr !== undefined && srcAttr !== null && srcAttr !== '') {
      scripts.push({ src: decodeEntities(srcAttr), local: false, origin: region, attrs });
      removals.push({ start: node.start, end: node.end, region });
      continue;
    }

    const code = contentOf(node);
    removals.push({ start: node.start, end: node.end, region });
    if (!code.trim()) {
      emptyScriptsDropped++;
      orderOffsets.pop();
      continue;
    }
    scriptBlockNo++;
    const blockNo = scriptBlockNo;
    const hints = scanCompatHints(code);
    if (hints.length) note('warn', `<script> #${blockNo} uses ${hints.join(', ')} - behaviour can depend on the script being inline in the page.`);

    if (isModule) {
      const rel = moduleRelativeImports(code);
      if (rel.length) note('warn', `Module <script> #${blockNo} has relative import(s) (${rel.slice(0, 3).join(', ')}) - they resolve relative to js/ once extracted.`);
      const item: JsItem = { code, module: true, part: 1, parts: 1, blockNo };
      jsItems.push(item);
      scripts.push({ src: '', local: true, origin: region, attrs, item });
      if (lineCount(code) > opts.maxJsLines) note('info', `Module <script> #${blockNo} is ${lineCount(code)} lines - kept as ONE intact file on purpose (ES module scope + import/export).`);
    } else {
      const plan = planClassic(code, opts.maxJsLines, opts.hoistGuard);
      if (plan.sourceError) note('warn', `<script> #${blockNo}: ${plan.sourceError}. ${plan.keptReason}`);
      else if (plan.keptReason) note('info', `<script> #${blockNo} (${lineCount(code)} lines): ${plan.keptReason}.`);
      plan.notes.forEach((m) => note('info', `<script> #${blockNo}: ${m}`));
      if (plan.chunks.join('') === code) verbatimJsOk++;
      else {
        verbatimJsBad++;
        validationRows.push({ kind: 'js', ok: false, label: `script #${blockNo}`, detail: 'chunks do not re-join to the original' });
      }
      plan.chunks.forEach((c, i) => {
        const item: JsItem = { code: c, module: false, part: i + 1, parts: plan.chunks.length, blockNo };
        jsItems.push(item);
        const a = attrs.filter(([nm]) => !(i > 0 && nm.toLowerCase() === 'id'));
        scripts.push({ src: '', local: true, origin: region, attrs: a, item });
      });
    }
  }

  /* ---------------------------------------------------------- 4. naming */
  const jsClassic = jsItems.filter((j) => !j.module);
  const jsModules = jsItems.filter((j) => j.module);
  const pjs = Math.max(2, String(jsClassic.length).length);
  const pmod = Math.max(2, String(jsModules.length).length);
  jsClassic.forEach((j, i) => (j.path = `js/script-${pad(i + 1, pjs)}.js`));
  jsModules.forEach((j, i) => (j.path = `js/module-${pad(i + 1, pmod)}.js`));
  scripts.forEach((s) => {
    if (s.item) s.src = s.item.path!;
  });
  const cssFilePieces: CssPiece[] = [];
  styles.forEach((s) => s.pieces.forEach((p) => !p.inline && cssFilePieces.push(p)));
  const pcss = Math.max(2, String(cssFilePieces.length).length);
  cssFilePieces.forEach((p, i) => (p.path = `css/style-${pad(i + 1, pcss)}.css`));

  const styleTags = (ps: PlannedStyle): string[] => {
    const node = ps.res.node;
    const openRaw = src.slice(node.start, node.openEnd);
    const closeRaw = node.closeStart >= 0 ? src.slice(node.closeStart, node.end) : '</style>';
    return ps.pieces.map((p, i) => {
      if (p.inline) return openRaw + p.content + closeRaw;
      const attrRaw = node.attrs
        .filter((a) => !(i > 0 && a.lname === 'id') && a.lname !== 'rel' && a.lname !== 'href')
        .map((a) => ' ' + a.raw)
        .join('');
      return `<link rel="stylesheet" href="${p.path}"${attrRaw}>`;
    });
  };

  /* ---------------------------------------------------------- 5. build index.html */
  type Edit = { start: number; end: number; text: string };
  const headEdits: Edit[] = [];
  for (const r of replacements) {
    const indent = lineIndent(src, r.start);
    headEdits.push({ start: r.start, end: r.end, text: styleTags(r.style).join('\n' + indent) });
  }
  for (const r of removals) {
    if (r.region !== 'head') continue;
    let s = r.start;
    let e = r.end;
    const ls = src.lastIndexOf('\n', s - 1) + 1;
    const le = src.indexOf('\n', e);
    const lineEnd = le === -1 ? headTo : le;
    if (ls >= headFrom && /^[ \t]*$/.test(src.slice(ls, s)) && /^[ \t\r]*$/.test(src.slice(e, Math.min(lineEnd, headTo))) && le !== -1 && le < headTo) {
      s = ls;
      e = le + 1;
    }
    headEdits.push({ start: s, end: e, text: '' });
  }
  headEdits.sort((a, b) => a.start - b.start);
  let headOut = '';
  {
    let p = headFrom;
    for (const ed of headEdits) {
      headOut += src.slice(p, ed.start) + ed.text;
      p = ed.end;
    }
    headOut += src.slice(p, headTo);
  }

  const manifestScripts = scripts.map((s) => ({
    src: s.src,
    local: s.local,
    origin: s.origin,
    attrs: s.attrs,
  }));
  const partialsPlaceholder: { path: string; lines: number }[] = [];

  /* ---------------------------------------------------------- 6. body partials */
  const sortedRemovals = removals.filter((r) => r.region === 'body').sort((a, b) => a.start - b.start);
  const bodySlice = (s: number, e: number): string => {
    let out = '';
    let p = s;
    for (const r of sortedRemovals) {
      if (r.end <= s || r.start >= e) continue;
      out += src.slice(p, r.start);
      p = r.end;
    }
    return out + src.slice(p, e);
  };

  interface Group { parts: string[]; nodes: ElNode[]; lines: number }
  const groups: Group[] = [];
  let cur: Group = { parts: [], nodes: [], lines: 0 };
  let pending: string[] = [];
  const flush = () => {
    if (cur.nodes.length) groups.push(cur);
    cur = { parts: [], nodes: [], lines: 0 };
  };
  const addEl = (text: string, node: ElNode) => {
    for (const p of pending) {
      cur.parts.push(p);
      cur.lines += lineCount(p) - 1;
    }
    pending = [];
    cur.parts.push(text);
    cur.nodes.push(node);
    cur.lines += lineCount(text);
  };
  for (const u of bodyUnits as Unit[]) {
    if (u.kind === 'close' || u.kind === 'doctype') continue;
    if (u.kind === 'element') {
      const text = bodySlice(u.start, u.end);
      if (text === '') continue; // top-level <script>/<style> that was extracted
      const lines = lineCount(text);
      if (opts.partialMode === 'every') {
        if (cur.nodes.length) flush();
        addEl(text, u.node!);
      } else if (lines >= opts.partialMinLines) {
        flush();
        addEl(text, u.node!);
        flush();
      } else {
        addEl(text, u.node!);
        if (cur.lines >= opts.partialMinLines) flush();
      }
    } else {
      const text = bodySlice(u.start, u.end);
      if (text === '') continue;
      if (u.kind === 'text' && /^\s*$/.test(text) && cur.nodes.length && pending.length === 0) {
        cur.parts.push(text);
        cur.lines += lineCount(text) - 1;
      } else pending.push(text);
    }
  }
  if (pending.length) {
    if (cur.nodes.length || groups.length) {
      const target = cur.nodes.length ? cur : groups[groups.length - 1];
      for (const p of pending) target.parts.push(p);
    } else {
      cur.parts.push(...pending);
      cur.nodes.push({ name: 'body', start: 0, end: 0, openEnd: 0, closeStart: -1, attrs: [], children: [] });
    }
    pending = [];
  }
  flush();

  const labelOf = (node: ElNode): string => {
    const id = getAttr(node.attrs, 'id') || '';
    const cls = (getAttr(node.attrs, 'class') || '').trim().split(/\s+/)[0] || '';
    const key = `${id} ${getAttr(node.attrs, 'class') || ''}`;
    if (node.name === 'dialog' || /modal|dialog|popup|overlay|drawer|lightbox/i.test(key)) return 'modals';
    switch (node.name) {
      case 'header': return 'header';
      case 'nav': return 'navigation';
      case 'main': return 'main-content';
      case 'footer': return 'footer';
      case 'aside': return 'sidebar';
      case 'template': return 'templates';
      case 'section': case 'article': return id || cls || node.name;
      case 'div': return id || cls || 'content';
      case 'body': return 'body';
      default: return id || node.name;
    }
  };
  const usedNames = new Map<string, number>();
  const pparts = Math.max(2, String(groups.length).length);
  const partials: { path: string; content: string; elements: number }[] = groups.map((g, i) => {
    const labels = g.nodes.map(labelOf);
    let label = slug(labels[0], 'content');
    if (labels.some((l) => l !== labels[0])) label += `-plus-${g.nodes.length - 1}`;
    else if (g.nodes.length > 1 && labels[0] !== 'modals' && labels[0] !== 'templates') label += `-x${g.nodes.length}`;
    const k = (usedNames.get(label) ?? 0) + 1;
    usedNames.set(label, k);
    return { path: `partials/${pad(i + 1, pparts)}-${label}${k > 1 ? '-' + k : ''}.html`, content: g.parts.join(''), elements: g.nodes.length };
  });
  partials.forEach((p) => partialsPlaceholder.push({ path: p.path, lines: lineCount(p.content) }));
  partials.forEach((p) => {
    const l = lineCount(p.content);
    if (l > 3000) note('info', `${p.path} is ${l.toLocaleString()} lines: a single top-level element is that large (DOM hierarchy is never split mid-element).`);
  });

  /* ---------------------------------------------------------- 7. manifest + index.html */
  const manifest = {
    generator: 'HTML Modularizer Pro',
    version: 1,
    source: fileName,
    settings: { atomic: opts.atomicScripts },
    partials: partialsPlaceholder.map((p) => ({ path: p.path })),
    scripts: manifestScripts,
  };
  const manifestInline = JSON.stringify(manifest).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

  // hoisted extras: body <style>s become links, in document order together with body stylesheet links/importmaps
  const hoistList: { start: number; text: string }[] = [...hoisted];
  for (const b of bodyStyleHoists) hoistList.push({ start: b.start, text: styleTags(b.style).join('\n  ') });
  hoistList.sort((a, b) => a.start - b.start);

  const injection =
    hoistList.map((h) => '  ' + h.text + '\n').join('') +
    `  <script type="application/json" id="modularizer-manifest">${manifestInline}</script>\n` +
    `  <script defer src="js/app-loader.js" data-modularizer-loader></script>\n`;

  const trailWs = /[ \t]*$/.exec(headOut)![0];
  let core = trailWs ? headOut.slice(0, -trailWs.length) : headOut;
  if (core.length && !core.endsWith('\n')) core += '\n';
  const headFinal = core + injection + trailWs;

  let indexHtml = src.slice(0, headFrom);
  if (synthHead) indexHtml += (indexHtml.endsWith('\n') || indexHtml === '' ? '' : '\n') + '<head>\n';
  indexHtml += headFinal;
  if (headCloseTok) indexHtml += src.slice(headTo, headCloseTok.end);
  else indexHtml += '</head>\n';
  if (bodyTok) indexHtml += src.slice(headCloseTok ? headCloseTok.end : headTo, bodyTok.end);
  else indexHtml += '<body>';
  indexHtml += '\n</body>\n</html>\n';

  /* ---------------------------------------------------------- 8. validation */
  // (a) verbatim JS/CSS
  checks.push({
    id: 'verbatim-js',
    label: 'Verbatim JavaScript: every split chunk re-joins byte-for-byte to its original <script>',
    status: verbatimJsBad ? 'fail' : 'pass',
    detail: `${verbatimJsOk} classic block(s) verified${jsModules.length ? `, ${jsModules.length} module(s) kept intact` : ''}`,
  });
  checks.push({
    id: 'verbatim-css',
    label: 'Verbatim CSS: every split chunk re-joins byte-for-byte to its original <style>',
    status: verbatimCssBad ? 'fail' : 'pass',
    detail: `${verbatimCssOk} block(s) verified`,
  });

  // (b) acorn validation of every generated JS file
  const jsErrors: string[] = [];
  const jsPreExisting: string[] = [];
  for (const it of jsItems) {
    const v = validateJs(it.code, it.module);
    if (!v.ok) {
      const whole = jsItems.filter((x) => x.blockNo === it.blockNo).length === 1;
      if (whole) jsPreExisting.push(`${it.path}: ${v.error}`);
      else jsErrors.push(`${it.path}: ${v.error}`);
    }
  }
  checks.push({
    id: 'acorn',
    label: 'Acorn syntax validation of every generated .js file (classic + module)',
    status: jsErrors.length ? 'fail' : jsPreExisting.length ? 'warn' : 'pass',
    detail: jsErrors.length
      ? jsErrors.join(' | ')
      : jsPreExisting.length
        ? `${jsItems.length - jsPreExisting.length}/${jsItems.length} parse cleanly. ${jsPreExisting.length} un-split block(s) Acorn cannot parse (not caused by splitting): ${jsPreExisting.join(' | ')}`
        : `${jsItems.length} file(s), 0 syntax errors`,
  });

  // (c) css structure
  const cssBad: string[] = [];
  for (const p of cssFilePieces) {
    const s = scanCss(p.content);
    if (!s.ok) cssBad.push(`${p.path}: ${s.error}`);
  }
  checks.push({
    id: 'css',
    label: 'CSS structure: strings/comments closed and braces balanced in every css file',
    status: cssBad.length ? 'warn' : 'pass',
    detail: cssBad.length ? cssBad.join(' | ') : `${cssFilePieces.length} file(s) checked`,
  });

  // (d) partial integrity (independent recomputation from raw source)
  {
    let expected = '';
    let p = bodyFrom;
    const dropTail: [number, number][] = [];
    for (const u of bodyUnits) if (u.kind === 'close' || u.kind === 'doctype') dropTail.push([u.start, u.end]);
    const all = [...sortedRemovals.map((r) => [r.start, r.end] as [number, number]), ...dropTail].sort((a, b) => a[0] - b[0]);
    for (const [s, e] of all) {
      expected += src.slice(p, s);
      p = Math.max(p, e);
    }
    expected += src.slice(p);
    const actual = partials.map((x) => x.content).join('');
    const ok = expected === actual;
    checks.push({
      id: 'partials',
      label: 'Partials: concatenated in order they equal the original <body> content (minus extracted scripts/styles)',
      status: ok ? 'pass' : 'fail',
      detail: ok ? `${partials.length} partial(s), ${actual.length.toLocaleString()} chars` : 'mismatch between partials and source body',
    });
  }

  // (e) script count / order
  {
    const totalTags = toks.filter((t) => t.type === 'open' && t.name === 'script').length;
    const accounted =
      scriptBlockNo + (scripts.length - jsItems.length) + dataScriptsKept + emptyScriptsDropped + scriptsInTemplates;
    const sortedOk = orderOffsets.every((v, i) => i === 0 || v > orderOffsets[i - 1]);
    const classicOrModuleBlocks = new Set(jsItems.map((j) => j.blockNo)).size;
    const countOk = totalTags === accounted && classicOrModuleBlocks === scriptBlockNo;
    checks.push({
      id: 'scripts',
      label: 'Script manifest: every <script> accounted for and kept in exact document order',
      status: countOk && sortedOk ? 'pass' : 'fail',
      detail: `${totalTags} tag(s) in source -> ${scripts.length} manifest entr${scripts.length === 1 ? 'y' : 'ies'} (${scripts.length - jsItems.length} external), ${dataScriptsKept} inert data block(s) kept in place${emptyScriptsDropped ? `, ${emptyScriptsDropped} empty dropped` : ''}${scriptsInTemplates ? `, ${scriptsInTemplates} inside <template> untouched` : ''}`,
    });
  }

  // (f) head & root tag preservation
  {
    const missing: string[] = [];
    if (htmlTok && !indexHtml.includes(src.slice(htmlTok.start, htmlTok.end))) missing.push('<html ...>');
    if (headTok && !indexHtml.includes(src.slice(headTok.start, headTok.end))) missing.push('<head ...>');
    if (bodyTok && !indexHtml.includes(src.slice(bodyTok.start, bodyTok.end))) missing.push('<body ...>');
    let headKept = 0;
    for (const u of headUnits) {
      if (u.kind !== 'element') continue;
      const node = u.node!;
      const touched = node.name === 'style' ? !handledHeadNodes.has(node) : node.name === 'script' ? !handledHeadNodes.has(node) : false;
      if (touched) continue;
      headKept++;
      const raw = src.slice(u.start, u.end);
      if (!indexHtml.includes(raw)) missing.push(raw.slice(0, 60));
    }
    checks.push({
      id: 'head',
      label: 'Head & root tags: <html>, <head>, <body> attributes and every head element preserved verbatim',
      status: missing.length ? 'fail' : 'pass',
      detail: missing.length ? 'Missing: ' + missing.join(' | ') : `${headKept} head element(s) + root tags byte-identical`,
    });
  }

  /* ---------------------------------------------------------- 9. environment notices */
  if (firstOpen('base')) note('warn', 'A <base> tag is present: relative paths of loader/partials/scripts resolve against it. The loader resolves its own URLs from js/app-loader.js, but check <base href>.');
  const charsetMeta = toks.find((t) => t.type === 'open' && t.name === 'meta' && t.attrs!.some((a) => a.lname === 'charset' && !/^utf-?8$/i.test(a.value ?? '')));
  if (charsetMeta) note('warn', 'The source declares a non-UTF-8 <meta charset>. Output files are written as UTF-8.');
  const bodyOnload = bodyTok?.attrs?.some((a) => a.lname === 'onload');
  if (bodyOnload) note('info', '<body onload="..."> is preserved; the loader fires it after all scripts have executed.');
  if (sortedRemovals.some((r) => r.end > r.start)) {
    const nested = resources.filter((r) => r.region === 'body' && r.kind === 'script').length;
    if (nested) note('info', `${nested} <script> tag(s) located in <body> were lifted out of their position (they run after all partials are mounted, in original relative order).`);
  }

  /* ---------------------------------------------------------- 10. assemble files */
  const files: OutFile[] = [];
  const add = (path: string, content: string, kind: FileKind, noteText?: string) =>
    files.push({ path, content, kind, lines: lineCount(content), bytes: byteLen(content), note: noteText });

  add('index.html', indexHtml, 'html', 'Preserved head + body tag, ordered CSS links, manifest, loader');
  add('manifest.json', JSON.stringify(manifest, null, 2) + '\n', 'json', 'Ordered partials + scripts');
  for (const p of cssFilePieces) {
    const ps = styles.find((s) => s.pieces.includes(p))!;
    add(p.path!, p.content, 'css', `<style> #${ps.origIndex} (${ps.res.region}) part ${p.part}/${p.parts}`);
  }
  add('js/app-loader.js', loaderSource, 'loader', 'Runtime loader (shim -> partials -> scripts -> lifecycle)');
  for (const j of jsItems) {
    add(j.path!, j.code, 'js', `${j.module ? 'module ' : ''}<script> #${j.blockNo} part ${j.part}/${j.parts}`);
  }
  for (const p of partials) add(p.path, p.content, 'html', `${p.elements} top-level node(s)`);

  const readme = buildReadme(rootName, fileName, files, notices, opts);
  add('README.md', readme, 'md');

  // order: index, manifest, README first for nicer trees
  const order = (f: OutFile) => (f.path === 'index.html' ? 0 : f.path === 'manifest.json' ? 1 : f.path === 'README.md' ? 2 : 3);
  files.sort((a, b) => order(a) - order(b));

  return {
    rootName,
    files,
    checks,
    notices,
    stats: {
      inputLines: lineCount(src),
      inputBytes: byteLen(src),
      partials: partials.length,
      jsFiles: jsItems.length + 1,
      cssFiles: cssFilePieces.length,
      externalScripts: scripts.length - jsItems.length,
      inlineStylesKept,
      ms: Math.round(performance.now() - t0),
    },
  };
}

function buildReadme(root: string, source: string, files: OutFile[], notices: Notice[], opts: Options): string {
  const tree = files
    .filter((f) => f.path !== 'README.md')
    .map((f) => `  ${f.path}  (${f.lines.toLocaleString()} lines)`)
    .join('\n');
  const warn = notices.filter((n) => n.level === 'warn').map((n) => `- ${n.message}`).join('\n') || '- none';
  const info = notices.filter((n) => n.level === 'info').map((n) => `- ${n.message}`).join('\n') || '- none';
  return `# ${root}

Generated by **HTML Modularizer Pro** from \`${source}\`.
All code was sliced verbatim from the original file - nothing was rewritten, minified or reformatted.

## Run it (a local server is required)

\`index.html\` loads \`partials/*.html\` with \`fetch()\`, which browsers block on \`file://\`.
Open a terminal in this folder and run one of:

    python3 -m http.server 8000
    npx serve .
    php -S localhost:8000

Then open http://localhost:8000 (on a phone: http://<your-computer-LAN-IP>:8000).

## Structure

${tree}

## Load order (js/app-loader.js)

1. Install a lifecycle shim that captures DOMContentLoaded / load listeners (and window.onload / <body onload>).
2. Fetch every partial in order and mount them into <body>.
3. Execute every script (external CDN + local) one-by-one, awaiting each one${opts.atomicScripts ? ' (local classic chunks are prefetched and run atomically)' : ''}.
4. Dispatch the captured DOMContentLoaded and load events.

## Things worth a look

${warn}

## Notes

${info}
`;
}
