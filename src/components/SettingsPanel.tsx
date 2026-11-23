import type { Options } from '../engine/modularize';

interface Props {
  opts: Options;
  onChange: (o: Options) => void;
}

function Num({
  label, hint, value, min, onChange,
}: { label: string; hint: string; value: number; min: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-200">{label}</span>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(Math.max(min, Number(e.target.value) || min))}
        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/30"
      />
      <span className="mt-1 block text-xs leading-snug text-slate-400">{hint}</span>
    </label>
  );
}

function Toggle({
  label, hint, checked, onChange,
}: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3 hover:border-slate-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span className="mt-0.5 h-5 w-9 shrink-0 rounded-full bg-slate-700 p-0.5 transition peer-checked:bg-indigo-500 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400 [&>span]:peer-checked:translate-x-4">
        <span className="block h-4 w-4 rounded-full bg-white transition" />
      </span>
      <span>
        <span className="block text-sm font-medium text-slate-200">{label}</span>
        <span className="block text-xs leading-snug text-slate-400">{hint}</span>
      </span>
    </label>
  );
}

export default function SettingsPanel({ opts, onChange }: Props) {
  const set = <K extends keyof Options>(k: K, v: Options[K]) => onChange({ ...opts, [k]: v });
  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 text-sm font-medium text-slate-200">Body partial granularity</div>
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-950 p-1">
          {(['every', 'grouped'] as const).map((m) => (
            <button
              key={m}
              onClick={() => set('partialMode', m)}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                opts.partialMode === m ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {m === 'every' ? 'Every top-level block' : 'Group small blocks'}
            </button>
          ))}
        </div>
        {opts.partialMode === 'grouped' && (
          <div className="mt-3">
            <Num
              label="Group until ≥ N lines"
              hint="Adjacent small nodes are merged until a partial reaches this size; bigger blocks stay alone."
              value={opts.partialMinLines}
              min={1}
              onChange={(v) => set('partialMinLines', v)}
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Num label="Max JS lines / file" hint="Classic scripts are cut only at top-level AST statements." value={opts.maxJsLines} min={20} onChange={(v) => set('maxJsLines', v)} />
        <Num label="Max CSS lines / file" hint="Cut only at brace depth 0 (never inside @media etc.)." value={opts.maxCssLines} min={20} onChange={(v) => set('maxCssLines', v)} />
      </div>

      <div className="space-y-2">
        <Toggle
          label="Hoisting guard"
          hint="Merges chunks when top-level code uses a function/var declared in a later chunk (hoisting doesn't cross files)."
          checked={opts.hoistGuard}
          onChange={(v) => set('hoistGuard', v)}
        />
        <Toggle
          label="Keep CSS with relative url() inline"
          hint="Moving CSS into css/ would break relative asset paths, so those chunks stay as <style> in index.html."
          checked={opts.keepRelativeCssInline}
          onChange={(v) => set('keepRelativeCssInline', v)}
        />
        <Toggle
          label="Extract <style> blocks found in <body>"
          hint="They are linked from <head> after all head styles, which preserves the cascade order."
          checked={opts.extractBodyStyles}
          onChange={(v) => set('extractBodyStyles', v)}
        />
        <Toggle
          label="Atomic classic-script execution"
          hint="Loader prefetches local classic chunks and runs them back-to-back with no network gap (closest to one big <script>)."
          checked={opts.atomicScripts}
          onChange={(v) => set('atomicScripts', v)}
        />
      </div>
    </div>
  );
}
