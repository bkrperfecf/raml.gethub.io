import { useMemo, useState } from 'react';
import type { OutFile, Result } from '../engine/modularize';

const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);

const KIND_STYLE: Record<string, string> = {
  html: 'bg-orange-500/15 text-orange-300',
  css: 'bg-sky-500/15 text-sky-300',
  js: 'bg-yellow-500/15 text-yellow-300',
  loader: 'bg-fuchsia-500/15 text-fuchsia-300',
  json: 'bg-emerald-500/15 text-emerald-300',
  md: 'bg-slate-500/20 text-slate-300',
};

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <div className="text-2xl font-semibold tracking-tight text-white">{value}</div>
      <div className="text-xs uppercase tracking-wider text-slate-400">{label}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const STATUS = {
  pass: { icon: '✓', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  warn: { icon: '!', cls: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  fail: { icon: '✕', cls: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
};

const PREVIEW_LINES = 400;

export default function ResultView({ result }: { result: Result }) {
  const [selected, setSelected] = useState<string>('index.html');
  const [showInfo, setShowInfo] = useState(false);

  const groups = useMemo(() => {
    const g = new Map<string, OutFile[]>();
    for (const f of result.files) {
      const dir = f.path.includes('/') ? f.path.split('/')[0] + '/' : './';
      if (!g.has(dir)) g.set(dir, []);
      g.get(dir)!.push(f);
    }
    const order = ['./', 'partials/', 'css/', 'js/'];
    return [...g.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [result]);

  const file = result.files.find((f) => f.path === selected) ?? result.files[0];
  const preview = useMemo(() => {
    const lines = file.content.split('\n');
    const truncated = lines.length > PREVIEW_LINES;
    return { text: lines.slice(0, PREVIEW_LINES).join('\n'), truncated, total: lines.length };
  }, [file]);

  const warns = result.notices.filter((n) => n.level === 'warn');
  const infos = result.notices.filter((n) => n.level === 'info');
  const failed = result.checks.some((c) => c.status === 'fail');

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Input" value={result.stats.inputLines.toLocaleString()} sub={`lines · ${fmtBytes(result.stats.inputBytes)}`} />
        <Stat label="Partials" value={result.stats.partials} sub="partials/*.html" />
        <Stat label="JS files" value={result.stats.jsFiles} sub={`incl. loader · ${result.stats.externalScripts} external`} />
        <Stat label="CSS files" value={result.stats.cssFiles} sub={result.stats.inlineStylesKept ? `${result.stats.inlineStylesKept} chunk(s) kept inline` : 'css/*.css'} />
        <Stat label="Split time" value={`${result.stats.ms} ms`} sub="in your browser" />
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-white">Pre-export validation</h3>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${failed ? STATUS.fail.cls : STATUS.pass.cls}`}>
            {failed ? 'Problems found' : 'All parity checks passed'}
          </span>
        </div>
        <ul className="space-y-2">
          {result.checks.map((c) => (
            <li key={c.id} className="flex gap-3">
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-1 ${STATUS[c.status].cls}`}>
                {STATUS[c.status].icon}
              </span>
              <div className="min-w-0">
                <div className="text-sm text-slate-200">{c.label}</div>
                {c.detail && <div className="break-words text-xs text-slate-400">{c.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {(warns.length > 0 || infos.length > 0) && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          {warns.length > 0 && (
            <>
              <h3 className="mb-2 font-semibold text-amber-300">Worth a look ({warns.length})</h3>
              <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-300">
                {warns.map((n, i) => <li key={i}>{n.message}</li>)}
              </ul>
            </>
          )}
          {infos.length > 0 && (
            <>
              <button onClick={() => setShowInfo(!showInfo)} className="text-sm font-medium text-slate-300 hover:text-white">
                {showInfo ? '▾' : '▸'} Split decisions &amp; notes ({infos.length})
              </button>
              {showInfo && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-400">
                  {infos.map((n, i) => <li key={i}>{n.message}</li>)}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60">
        <div className="border-b border-slate-800 px-5 py-3 text-sm text-slate-300">
          <span className="font-mono text-indigo-300">{result.rootName}/</span>
          <span className="ml-2 text-slate-500">{result.files.length} files</span>
        </div>
        <div className="grid md:grid-cols-[320px_1fr]">
          <div className="max-h-[560px] overflow-auto border-b border-slate-800 p-3 md:border-b-0 md:border-r">
            {groups.map(([dir, files]) => (
              <div key={dir} className="mb-3">
                <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">{dir === './' ? 'root' : dir}</div>
                {files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setSelected(f.path)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                      f.path === file.path ? 'bg-indigo-500/20 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${KIND_STYLE[f.kind]}`}>{f.kind === 'loader' ? 'js' : f.kind}</span>
                      <span className="truncate font-mono text-xs">{f.path.split('/').pop()}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-500">{f.lines.toLocaleString()} L</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2 text-xs text-slate-400">
              <span className="font-mono text-slate-200">{file.path}</span>
              <span>{file.lines.toLocaleString()} lines · {fmtBytes(file.bytes)}{file.note ? ` · ${file.note}` : ''}</span>
            </div>
            <pre className="max-h-[520px] overflow-auto p-4 font-mono text-xs leading-relaxed text-slate-300">{preview.text}</pre>
            {preview.truncated && (
              <div className="border-t border-slate-800 px-4 py-2 text-xs text-slate-500">
                Preview truncated to {PREVIEW_LINES} of {preview.total.toLocaleString()} lines — the ZIP contains the full file.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
