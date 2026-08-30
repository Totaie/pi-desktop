import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { appLog } from './app-log'
import type { RemoteTunnelStatus } from '../shared/ipc-contracts'

/**
 * Publishes one local port through a temporary Cloudflare tunnel.
 *
 * Quick tunnels (`cloudflared tunnel --url …`) are deliberate here rather than
 * named ones: they need no Cloudflare account, no domain, and no DNS, and the
 * hostname they hand back is random and short-lived. That is the right shape
 * for a URL whose only means of transfer is a QR code someone scans in the
 * room — it is a capability, not an address, and it dies with the process.
 *
 * The trade is that the hostname changes on every start, so nothing may cache
 * it: the QR is regenerated per session, which is why this emits 'url' rather
 * than exposing a stable value.
 */

/** Where a user-installed cloudflared is looked for, in order. */
function candidateBinaries(): string[] {
  const home = homedir()
  return [
    join(home, '.pi', 'agent', 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    join(home, '.local', 'bin', 'cloudflared'),
    process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared',
  ]
}

export function resolveCloudflaredPath(): string | null {
  for (const candidate of candidateBinaries()) {
    // The bare name is the PATH fallback; only absolute candidates are probed.
    if (!candidate.includes('/') && !candidate.includes('\\')) return candidate
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * cloudflared prints the assigned hostname inside an ASCII box on stderr, e.g.
 *   INF |  https://town-blvd-indexed-republic.trycloudflare.com   |
 * so the URL is extracted by shape rather than by line position — the banner's
 * layout is presentation and has changed between releases.
 */
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export class RemoteTunnel extends EventEmitter {
  private child: ChildProcess | null = null
  private status: RemoteTunnelStatus = { state: 'stopped', url: null, port: null, error: null }

  getStatus(): RemoteTunnelStatus {
    return { ...this.status }
  }

  private setStatus(next: Partial<RemoteTunnelStatus>): void {
    this.status = { ...this.status, ...next }
    this.emit('status', this.getStatus())
  }

  /**
   * Bring a tunnel up for `port` and resolve once Cloudflare has named it.
   *
   * Resolves on the URL rather than on spawn, because a tunnel with no
   * hostname yet is useless to the caller — there is nothing to put in a QR.
   */
  async start(port: number, timeoutMs = 45_000): Promise<RemoteTunnelStatus> {
    if (this.child) this.stop()

    const bin = resolveCloudflaredPath()
    if (!bin) {
      const error = 'cloudflared was not found. Install it, or place it at ~/.pi/agent/bin/cloudflared.'
      this.setStatus({ state: 'error', url: null, port, error })
      return this.getStatus()
    }

    this.setStatus({ state: 'starting', url: null, port, error: null })

    const child = spawn(bin, [
      'tunnel',
      '--url', `http://127.0.0.1:${port}`,
      // The tunnel must not restart itself into a NEW hostname behind a QR the
      // user already scanned; an update is the app's business, not a running
      // session's.
      '--no-autoupdate',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child

    return new Promise<RemoteTunnelStatus>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(this.getStatus())
      }

      const timer = setTimeout(() => {
        if (settled) return
        this.setStatus({
          state: 'error',
          error: `cloudflared did not report a URL within ${Math.round(timeoutMs / 1000)}s.`,
        })
        this.stop()
        finish()
      }, timeoutMs)

      const scan = (chunk: Buffer): void => {
        const text = chunk.toString()
        if (this.status.url) return
        const match = text.match(QUICK_TUNNEL_URL)
        if (!match) return
        appLog.info('remote', `Quick tunnel up on ${match[0]} -> 127.0.0.1:${port}`)
        this.setStatus({ state: 'running', url: match[0], error: null })
        finish()
      }

      // Both streams are scanned: cloudflared has moved the banner between
      // stdout and stderr across releases, and which one it lands on is not
      // worth depending on.
      child.stdout?.on('data', scan)
      child.stderr?.on('data', scan)

      child.on('error', (err) => {
        this.setStatus({ state: 'error', url: null, error: `cloudflared failed to start: ${err.message}` })
        this.child = null
        finish()
      })

      child.on('exit', (code) => {
        // Only an exit we did not ask for is a failure; stop() clears `child`
        // first precisely so this can tell the difference.
        if (this.child !== child) return
        this.child = null
        const wasRunning = this.status.state === 'running'
        this.setStatus({
          state: 'stopped',
          url: null,
          error: wasRunning || code === 0 ? null : `cloudflared exited with code ${code}`,
        })
        finish()
      })
    })
  }

  stop(): void {
    const child = this.child
    if (!child) {
      this.setStatus({ state: 'stopped', url: null, error: null })
      return
    }
    // Cleared first so the exit handler reads this as intentional.
    this.child = null
    child.kill()
    this.setStatus({ state: 'stopped', url: null, error: null })
  }
}
