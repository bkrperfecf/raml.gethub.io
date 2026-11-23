import { useCallback, useRef, useState } from 'react';
import loaderSource from './engine/app-loader.js?raw';
import { DEFAULT_OPTIONS, modularize, type Options, type Result } from './engine/modularize';
import { makeSample } from './engine/sample';
import { buildZip, downloadBlob } from './engine/zip';
import { lineCount } from './engine/jsSplitter';
import SettingsPanel from './components/SettingsPanel';
import ResultView from './components/ResultView';

interface Loaded {
  name: string;
  text: string;
}

const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [opts, setOpts] = useState<Options>(DEFAULT_OPTIONS);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [zipInfo, setZipInfo] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const readFile = useCallback(async (f: File) => {
    setError(null);
    setResult(null);
    setZipInfo(null);
    setBusy('Reading file…');
    try {
      const text = await f.text();
      setLoaded({ name: f.name, text });
    } catch (e) {
      setError('Could not read file: ' + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const loadSample = (scale: 'demo' | 'stress') => {
    const s = makeSample(scale);
    setLoaded({ name: s.name, text: s.html });
    setResult(null);
    setZipInfo(null);
    setError(null);
  };

  const run = async () => {
    if (!loaded) return;
    setBusy('Parsing, splitting & validating…');
    setError(null);
    setZipInfo(null);
    await sleep(40); // let the spinner paint before the synchronous engine runs
    try {
      setResult(modularize(loaded.text, loaded.name, opts, loaderSource));
    } catch (e) {
      console.error(e);
      setError('Modularization failed: ' + (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!result) return;
    setBusy('Packaging ZIP…');
    await sleep(20);
    try {
      const blob = await buildZip(result);
      downloadBlob(blob, `${result.rootName}.zip`);
      setZipInfo(`${result.rootName}.zip · ${fmtBytes(blob.size)}`);
    } catch (e) {
      setError('ZIP failed: ' + (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const hasFail = result?.checks.some((c) => c.status === 'fail');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="pointer-events-none fixed inset-0 -z-0 bg-[radial-gradient(ellipse_at_top,rgba(99,102,241,0.18),transparent_55%)]" />
      <div className="relative mx-auto max-w-6xl px-4 pb-24 pt-10 sm:px-6">
        {/* Header */}
        <header className="mb-10 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-2xl shadow-lg shadow-indigo-500/30">
            ⧉
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-5xl">
            HTML Modularizer <span className="bg-gradient-to-r from-indigo-400 to-fuchsia-400 bg-clip-text text-transparent">Pro</span>
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-slate-400">
            Split a massive single-file HTML app into <code className="text-slate-300">partials/</code>, <code className="text-slate-300">css/</code> and{' '}
            <code className="text-slate-300">js/</code> — verbatim slices only, AST-safe boundaries, guaranteed script order. Nothing leaves your browser.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs">
            {['Zero code mutation', 'Acorn AST boundaries', 'Hoisting guard', '100% client-side', '50k+ lines'].map((b) => (
              <span key={b} className="rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-slate-300">{b}</span>
            ))}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          {/* Step 1 */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="mb-4 flex items-center gap-2 font-semibold text-white">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 text-xs">1</span> Upload your HTML
            </h2>
            <div
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files?.[0];
                if (f) readFile(f);
              }}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
                drag ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-500 hover:bg-slate-900'
              }`}
            >
              <div className="mb-2 text-4xl">📄</div>
              <div className="font-medium text-slate-200">Drop a .html file here, or click to browse</div>
              <div className="mt-1 text-sm text-slate-500">10,000 – 50,000+ lines are fine · processed locally</div>
              <input
                ref={inputRef}
                type="file"
                accept=".html,.htm,.xhtml,text/html"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) readFile(f);
                  e.target.value = '';
                }}
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-500">No file handy?</span>
              <button onClick={() => loadSample('demo')} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800">
                Load small demo
              </button>
              <button onClick={() => loadSample('stress')} className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800">
                Load 12k-line stress test
              </button>
            </div>

            {loaded && (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-950 p-4">
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm text-indigo-300">{loaded.name}</div>
                  <div className="text-xs text-slate-500">
                    {lineCount(loaded.text).toLocaleString()} lines · {fmtBytes(new Blob([loaded.text]).size)}
                  </div>
                </div>
                <button
                  onClick={run}
                  disabled={!!busy}
                  className="rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 px-6 py-2.5 font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:brightness-110 disabled:opacity-50"
                >
                  {result ? 'Re-run with these settings' : 'Modularize →'}
                </button>
              </div>
            )}
          </section>

          {/* Step 2 */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="mb-4 flex items-center gap-2 font-semibold text-white">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 text-xs">2</span> Splitting settings
            </h2>
            <SettingsPanel opts={opts} onChange={setOpts} />
          </section>
        </div>

        {busy && (
          <div className="mt-6 flex items-center gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-200">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-300 border-t-transparent" />
            {busy}
          </div>
        )}
        {error && <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div>}

        {result && (
          <div className="mt-10">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500 text-xs">3</span> Result
              </h2>
              <div className="flex items-center gap-3">
                {zipInfo && <span className="text-sm text-emerald-300">Saved {zipInfo}</span>}
                <button
                  onClick={download}
                  disabled={!!busy}
                  className="rounded-xl bg-emerald-500 px-6 py-2.5 font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 disabled:opacity-50"
                >
                  ⬇ Download {result.rootName}.zip
                </button>
              </div>
            </div>
            {hasFail && (
              <div className="mb-5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                One or more validation checks failed. Review them below before using this export.
              </div>
            )}
            <ResultView result={result} />
            <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-sm text-slate-300">
              <h3 className="mb-2 font-semibold text-white">Run the exported folder</h3>
              <p className="mb-2 text-slate-400">
                Unzip, open a terminal inside <code className="text-slate-200">{result.rootName}/</code> and start any static server (the loader uses
                <code className="mx-1 text-slate-200">fetch()</code>, which browsers block on <code className="text-slate-200">file://</code> — the page shows a helpful banner if you try).
              </p>
              <div className="flex flex-wrap gap-2 font-mono text-xs">
                {['python3 -m http.server 8000', 'npx serve .', 'php -S localhost:8000'].map((c) => (
                  <code key={c} className="select-all rounded-lg bg-slate-950 px-3 py-2 text-emerald-300">{c}</code>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
