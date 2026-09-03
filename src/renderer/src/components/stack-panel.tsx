import { useCallback, useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { AlertTriangle, CheckCircle2, Download, HardDriveDownload, Loader2, PackagePlus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import type { StackStatus, StackActionEvent } from '../../../shared/ipc-contracts'

/**
 * Maintenance the app can do to itself: update the engine, add or remove a
 * model, rebuild, and — the safety net — revert to a previous build.
 *
 * Every button here calls stack.ps1 through the main process. Nothing is
 * reimplemented in the app, so the same operations survive the app being
 * broken: they run from a terminal too. Long actions stream their console
 * output into the log pane rather than freezing a button.
 */

type Busy = null | string

export function StackPanel(): React.JSX.Element {
  const [status, setStatus] = useState<StackStatus | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLPreElement>(null)

  const [repo, setRepo] = useState('')
  const [file, setFile] = useState('')
  const [alias, setAlias] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.piDesktop.stack.status())
    } catch (err) {
      setLog((l) => [...l, `status failed: ${err instanceof Error ? err.message : String(err)}`])
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Stream action output into the log, and refresh status when one ends.
    const off = window.piDesktop.stack.onAction((e: StackActionEvent) => {
      if (e.phase === 'output' && e.text) setLog((l) => [...l, ...e.text!.replace(/\r/g, '').split('\n').filter(Boolean)])
      else if (e.phase === 'start') setLog((l) => [...l, `\u25B8 ${e.action}…`])
      else if (e.phase === 'error') setLog((l) => [...l, `\u2717 ${e.text ?? 'error'}`])
      else if (e.phase === 'end') {
        setLog((l) => [...l, e.code === 0 ? `\u2713 ${e.action} done` : `\u2717 ${e.action} exited ${e.code}`])
        setBusy(null)
        void refresh()
      }
    })
    return off
  }, [refresh])

  // Follow the log tail.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const act = useCallback((name: string, run: () => Promise<unknown>) => {
    setBusy(name)
    setLog((l) => [...l, ''])
    run().catch((err) => {
      setLog((l) => [...l, `\u2717 ${err instanceof Error ? err.message : String(err)}`])
      setBusy(null)
    })
  }, [])

  const disabled = busy !== null || status?.busy === true
  const llama = status?.llama
  const updateAvailable = llama?.latest && llama.reported && llama.latest !== llama.reported

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 overflow-y-auto p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-primary">Stack</h1>
          <p className="text-xs text-muted">Update the engine, manage models, and roll the app back if a change breaks it.</p>
        </div>
        <button
          onClick={() => void refresh()}
          className="flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
        >
          <RefreshCw size={13} /> Refresh
        </button>
      </header>

      {status && !status.scriptFound && (
        <div className="flex items-start gap-2 rounded-md border border-warning-bg bg-warning-bg/40 p-3 text-xs text-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>local-stack's <code>stack.ps1</code> was not found. Maintenance actions are unavailable until it exists at
            <code> E:\Folders\Coding\AI\local-stack\scripts</code> or <code>PI_DESKTOP_STACK_SCRIPT</code> points at it.</span>
        </div>
      )}

      {/* Engine */}
      <section className="rounded-lg border border-border bg-surface/50 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium text-primary">Engine (llama.cpp)</h2>
          {llama?.mismatch && (
            <span className="flex items-center gap-1 text-[11px] text-error"><AlertTriangle size={12} /> mixed build — re-run update</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Field label="installed" value={llama?.reported ?? '—'} />
          <Field label="latest" value={llama?.latest ?? 'offline?'} tone={updateAvailable ? 'warn' : 'ok'} />
          <Field label="status" value={status?.busy ? 'busy' : 'idle'} />
        </div>
        <div className="mt-3">
          <ActionButton
            icon={<Download size={13} />}
            label={updateAvailable ? `Update to ${llama?.latest}` : 'Reinstall / check for update'}
            highlight={Boolean(updateAvailable)}
            disabled={disabled}
            onClick={() => act('update-llama', () => window.piDesktop.stack.updateLlama())}
          />
        </div>
      </section>

      {/* Models */}
      <section className="rounded-lg border border-border bg-surface/50 p-4">
        <h2 className="mb-2 text-sm font-medium text-primary">Models</h2>
        <div className="grid grid-cols-[1fr,1fr,auto] gap-2">
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="huggingface repo (owner/name)"
            className="rounded border border-border-strong bg-card px-2 py-1.5 text-xs text-primary placeholder:text-faint focus:border-focus focus:outline-none" />
          <input value={file} onChange={(e) => setFile(e.target.value)} placeholder="file.gguf"
            className="rounded border border-border-strong bg-card px-2 py-1.5 text-xs text-primary placeholder:text-faint focus:border-focus focus:outline-none" />
          <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="alias (optional)"
            className="w-28 rounded border border-border-strong bg-card px-2 py-1.5 text-xs text-primary placeholder:text-faint focus:border-focus focus:outline-none" />
        </div>
        <div className="mt-2 flex gap-2">
          <ActionButton
            icon={<HardDriveDownload size={13} />}
            label="Download model"
            disabled={disabled || !repo.trim() || !file.trim()}
            onClick={() => act('download-model', () => window.piDesktop.stack.downloadModel(repo.trim(), file.trim(), alias.trim() || undefined))}
          />
        </div>
        <p className="mt-2 text-[11px] text-faint">Downloads to D:\AI-models, verifies the checksum, registers the alias, and restarts the server so the picker sees it.</p>
      </section>

      {/* App builds + revert */}
      <section className="rounded-lg border border-border bg-surface/50 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium text-primary">App</h2>
          <span className="text-[11px] text-muted">current: {status?.currentBuild ?? '—'}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton icon={<PackagePlus size={13} />} label="Build from source" disabled={disabled}
            onClick={() => act('build-app', () => window.piDesktop.stack.buildApp())} />
          <ActionButton icon={<RotateCcw size={13} />} label="Revert to previous build" disabled={disabled || (status?.builds.length ?? 0) < 2}
            onClick={() => act('revert-app', () => window.piDesktop.stack.revertApp())} />
          <ActionButton icon={<CheckCircle2 size={13} />} label="Snapshot source as known-good" disabled={disabled}
            onClick={() => act('snapshot', () => window.piDesktop.stack.snapshot())} />
        </div>
        {status && status.builds.length > 0 && (
          <div className="mt-3 space-y-0.5">
            {status.builds.map((b) => (
              <div key={b} className="flex items-center gap-2 text-[11px]">
                <span className={clsx('font-mono', b === status.currentBuild ? 'text-success' : 'text-muted')}>
                  {b === status.currentBuild ? '● ' : '  '}{b}
                </span>
                {b !== status.currentBuild && (
                  <button
                    onClick={() => act('revert-app', () => window.piDesktop.stack.revertApp(b))}
                    disabled={disabled}
                    className="text-faint transition-colors hover:text-primary disabled:opacity-40"
                  >use</button>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="mt-2 text-[11px] text-faint">Reverting swaps which build the shortcut opens — quit and relaunch to apply. Your icon never changes.</p>
      </section>

      {/* Live output */}
      <section className="flex min-h-[140px] flex-1 flex-col rounded-lg border border-border bg-app/60">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-xs text-muted">Output</span>
          <div className="flex items-center gap-2">
            {busy && <span className="flex items-center gap-1 text-[11px] text-warning"><Loader2 size={11} className="animate-spin" /> {busy}</span>}
            <button onClick={() => setLog([])} className="text-faint transition-colors hover:text-primary" title="Clear"><Trash2 size={12} /></button>
          </div>
        </div>
        <pre ref={logRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
          {log.length ? log.join('\n') : 'Ready.'}
        </pre>
      </section>
    </div>
  )
}

function Field({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }): React.JSX.Element {
  return (
    <div className="rounded border border-border bg-card px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className={clsx('truncate font-mono text-xs', tone === 'warn' ? 'text-warning' : 'text-primary')} title={value}>{value}</div>
    </div>
  )
}

function ActionButton({ icon, label, onClick, disabled, highlight }: {
  icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; highlight?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40',
        highlight ? 'bg-accent text-on-accent hover:opacity-90' : 'border border-border-strong text-muted hover:bg-surface-hover hover:text-primary'
      )}
    >
      {icon}{label}
    </button>
  )
}
