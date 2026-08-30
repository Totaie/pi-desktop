import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Loader2, QrCode, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { useAppStore } from '../store'
import type { RemoteTunnelStatus } from '../../../shared/ipc-contracts'

/**
 * Remote access: publish a local port through a temporary Cloudflare tunnel and
 * show the resulting URL as a QR code to scan.
 *
 * The QR is the point. A quick-tunnel hostname is random, unguessable, and
 * dies with the process, so it behaves like a capability handed over in the
 * room rather than an address anyone can look up — which is why it is never
 * persisted and is regenerated every time the tunnel starts.
 */

/** Default target: pi-web's port, the usual thing worth reaching from a phone. */
const DEFAULT_PORT = 31415

function statusLabel(status: RemoteTunnelStatus): string {
  switch (status.state) {
    case 'running': return 'Live'
    case 'starting': return 'Starting…'
    case 'error': return 'Failed'
    default: return 'Off'
  }
}

export function RemotePanel(): React.JSX.Element | null {
  const open = useAppStore((state) => state.remotePanelOpen)
  const setOpen = useAppStore((state) => state.setRemotePanelOpen)

  const [status, setStatus] = useState<RemoteTunnelStatus>({
    state: 'stopped', url: null, port: null, error: null,
  })
  const [port, setPort] = useState(DEFAULT_PORT)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Reflect a tunnel that was already up when the panel opened, so the QR is
  // not lost by closing the dialog.
  useEffect(() => {
    if (!open) return
    void window.piDesktop.remote.status().then((next) => {
      setStatus(next)
      if (next.port) setPort(next.port)
    })
  }, [open])

  // Render the QR whenever the URL changes, and clear it the moment it does
  // not — a stale QR pointing at a dead tunnel is worse than none, because it
  // fails silently on the phone.
  useEffect(() => {
    let cancelled = false
    if (!status.url) {
      setQr(null)
      return
    }
    void QRCode.toDataURL(status.url, { margin: 1, width: 232, errorCorrectionLevel: 'M' })
      .then((data) => { if (!cancelled) setQr(data) })
      .catch(() => { if (!cancelled) setQr(null) })
    return () => { cancelled = true }
  }, [status.url])

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

  const live = status.state === 'running' && status.url

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
            <span className="font-medium text-primary">{statusLabel(status)}</span>
            {status.state === 'starting' && <Loader2 size={12} className="animate-spin text-muted" />}
          </div>

          <label className="flex items-center gap-2 text-xs text-muted">
            Local port
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              disabled={live !== null && live !== false}
              onChange={(event) => setPort(Number(event.target.value))}
              className="w-24 rounded border border-border-strong bg-card px-2 py-1 text-primary focus:border-focus focus:outline-none disabled:opacity-50"
            />
          </label>

          {live && qr && (
            <div className="flex flex-col items-center gap-2 rounded-md border border-border bg-card p-3">
              <img src={qr} alt="QR code for the remote URL" className="rounded" width={232} height={232} />
              <code className="break-all text-center text-[11px] text-muted">{status.url}</code>
            </div>
          )}

          {status.error && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-card p-2 text-[11px] text-muted">
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              <span>{status.error}</span>
            </div>
          )}

          {/* Stated plainly rather than buried: the URL is the only thing
              standing between the internet and whatever is on that port. */}
          <p className="text-[11px] leading-relaxed text-faint">
            Anyone with this URL reaches port {port} on this machine until you stop the
            tunnel. It is unguessable and temporary, not private — treat it as a
            password and stop it when you are done.
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
                disabled={busy || status.state === 'starting'}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {status.state === 'starting' ? 'Starting…' : 'Start tunnel'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
