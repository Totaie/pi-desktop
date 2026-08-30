import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Loader2, QrCode, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { useAppStore } from '../store'
import type { RemoteStatus } from '../../../shared/ipc-contracts'

/**
 * Remote access: run the Remote Pi relay locally, publish it through a
 * temporary Cloudflare tunnel, and show the resulting URL as a QR code.
 *
 * The QR is the point. A quick-tunnel hostname is random, unguessable, and
 * dies with the process, so it behaves like a capability handed over in the
 * room rather than an address anyone can look up — which is why it is never
 * persisted and is regenerated every time the tunnel starts.
 *
 * The relay itself is the protocol's own reference implementation, run as a
 * child process. The phone app authenticates against its exact wire behaviour,
 * so this app owns its lifecycle and none of its protocol.
 */

/** Matches the relay's own REMOTEPI_RELAY_PORT default. */
const DEFAULT_PORT = 3000

const IDLE: RemoteStatus = {
  relay: { state: 'stopped', port: null, error: null },
  tunnel: { state: 'stopped', url: null, port: null, error: null },
}

function summarize(status: RemoteStatus): { label: string; busy: boolean } {
  if (status.relay.state === 'error' || status.tunnel.state === 'error') return { label: 'Failed', busy: false }
  if (status.relay.state === 'starting') return { label: 'Starting relay…', busy: true }
  if (status.tunnel.state === 'starting') return { label: 'Opening tunnel…', busy: true }
  if (status.relay.state === 'running' && status.tunnel.state === 'running') return { label: 'Live', busy: false }
  if (status.relay.state === 'running') return { label: 'Relay up, not published', busy: false }
  return { label: 'Off', busy: false }
}

export function RemotePanel(): React.JSX.Element | null {
  const open = useAppStore((state) => state.remotePanelOpen)
  const setOpen = useAppStore((state) => state.setRemotePanelOpen)

  const [status, setStatus] = useState<RemoteStatus>(IDLE)
  const [port, setPort] = useState(DEFAULT_PORT)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Reflect a session that was already up when the panel opened, so closing
  // the dialog does not lose the QR.
  useEffect(() => {
    if (!open) return
    void window.piDesktop.remote.status().then((next) => {
      setStatus(next)
      if (next.relay.port) setPort(next.relay.port)
    })
  }, [open])

  // Clear the QR the moment the URL does not hold. A stale QR pointing at a
  // dead tunnel is worse than none: it fails on the phone, away from the
  // machine that could explain why.
  const url = status.tunnel.url
  useEffect(() => {
    let cancelled = false
    if (!url) {
      setQr(null)
      return
    }
    void QRCode.toDataURL(url, { margin: 1, width: 232, errorCorrectionLevel: 'M' })
      .then((data) => { if (!cancelled) setQr(data) })
      .catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [url])

  const start = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await window.piDesktop.remote.start(port))
    } finally {
      setBusy(false)
    }
  }, [port])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await window.piDesktop.remote.stop())
    } finally {
      setBusy(false)
    }
  }, [])

  if (!open) return null

  const { label, busy: settling } = summarize(status)
  const live = status.relay.state === 'running' && status.tunnel.state === 'running' && url
  const problem = status.relay.error ?? status.tunnel.error

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app/70 backdrop-blur-sm">
      <div className="w-[420px] max-w-[92vw] rounded-lg border border-border-strong bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <QrCode size={15} />
            Remote access
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-faint transition-colors hover:bg-highlight hover:text-primary"
            aria-label="Close remote access"
          >
            <X size={14} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">Status</span>
            <span className="font-medium text-primary">{label}</span>
            {settling && <Loader2 size={12} className="animate-spin text-muted" />}
          </div>

          <label className="flex items-center gap-2 text-xs text-muted">
            Relay port
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              disabled={Boolean(live) || settling}
              onChange={(event) => setPort(Number(event.target.value))}
              className="w-24 rounded border border-border-strong bg-card px-2 py-1 text-primary focus:border-focus focus:outline-none disabled:opacity-50"
            />
          </label>

          {live && qr && (
            <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-card p-3">
              <img src={qr} alt="QR code for the remote relay URL" className="rounded" width={232} height={232} />
              <code className="break-all text-center text-[11px] text-muted">{url}</code>
              <span className="text-[11px] text-faint">Scan with the Remote Pi app</span>
            </div>
          )}

          {problem && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-card p-2 text-[11px] text-muted">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              <span>{problem}</span>
            </div>
          )}

          {/* Stated plainly rather than buried. */}
          <p className="text-[11px] leading-relaxed text-faint">
            While this is live, anyone holding the URL can reach the relay on this
            machine. It is unguessable and temporary, not private — treat it as a
            password, and stop it when you are done.
          </p>

          <div className="flex justify-end gap-2 pt-1">
            {live ? (
              <>
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary disabled:opacity-50"
                >
                  <RefreshCw size={12} />
                  New URL
                </button>
                <button
                  type="button"
                  onClick={() => void stop()}
                  disabled={busy}
                  className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-on-danger transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Stop
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void start()}
                disabled={busy || settling}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {settling ? 'Starting…' : 'Start'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
