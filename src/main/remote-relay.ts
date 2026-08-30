import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { appLog } from './app-log'
import { getGuiDataPath } from './app-data-paths'
import type { RemoteRelayStatus } from '../shared/ipc-contracts'

/**
 * Runs the Remote Pi relay locally so the phone app has something to talk to.
 *
 * The relay is deliberately NOT reimplemented here. It is the reference
 * implementation from the protocol's own repository (MIT, Rust/axum), and the
 * iOS app authenticates against its exact wire behaviour: Ed25519
 * challenge-response, `pi_envelope` routing by `to_pc`, Owner-signed mesh
 * membership, a closed `transport_error` grammar. A hand-written substitute
 * would have to match all of that and keep matching it, and every divergence
 * fails silently on the phone rather than loudly here.
 *
 * So this owns the process, not the protocol: spawn it, watch its health,
 * report where it is listening. The tunnel then publishes that port.
 */

/** Where a built relay is looked for, in order. */
function candidateBinaries(): string[] {
  const exe = process.platform === 'win32' ? 'relay.exe' : 'relay'
  return [
    join(homedir(), '.pi', 'agent', 'bin', process.platform === 'win32' ? 'remote-pi-relay.exe' : 'remote-pi-relay'),
    join(homedir(), '.pi', 'agent', 'bin', exe),
  ]
}

export function resolveRelayPath(explicit?: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  for (const candidate of candidateBinaries()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Default relay port, matching REMOTEPI_RELAY_PORT's own default. */
export const DEFAULT_RELAY_PORT = 3000

export class RemoteRelay extends EventEmitter {
  private child: ChildProcess | null = null
  private status: RemoteRelayStatus = { state: 'stopped', port: null, error: null }

  getStatus(): RemoteRelayStatus {
    return { ...this.status }
  }

  private setStatus(next: Partial<RemoteRelayStatus>): void {
    this.status = { ...this.status, ...next }
    this.emit('status', this.getStatus())
  }

  isRunning(): boolean {
    return this.status.state === 'running'
  }

  /**
   * Start the relay and resolve once it answers /health.
   *
   * Health-polled rather than assumed from a successful spawn: the relay opens
   * its SQLite membership store on boot, and a process that started but cannot
   * serve is exactly the case that would otherwise produce a QR code pointing
   * at nothing.
   */
  async start(port = DEFAULT_RELAY_PORT, binaryPath?: string, timeoutMs = 20_000): Promise<RemoteRelayStatus> {
    if (this.child) return this.getStatus()

    const bin = resolveRelayPath(binaryPath)
    if (!bin) {
      this.setStatus({
        state: 'error',
        port,
        error: 'The Remote Pi relay was not found. Build it with `cargo build --release` and put it at ~/.pi/agent/bin/remote-pi-relay.',
      })
      return this.getStatus()
    }

    // The relay resolves its DB path relative to cwd by default; give it a
    // stable home in the app's data directory rather than wherever the app
    // happened to be launched from.
    const dataDir = getGuiDataPath('remote-relay')
    mkdirSync(dataDir, { recursive: true })

    this.setStatus({ state: 'starting', port, error: null })

    const child = spawn(bin, [], {
      cwd: dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        REMOTEPI_RELAY_PORT: String(port),
        REMOTEPI_MESH_DB_PATH: join(dataDir, 'mesh.db'),
        RUST_LOG: process.env.RUST_LOG ?? 'info',
      },
    })
    this.child = child

    child.on('error', (err) => {
      if (this.child !== child) return
      this.child = null
      this.setStatus({ state: 'error', error: `relay failed to start: ${err.message}` })
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      this.setStatus({
        state: 'stopped',
        error: code === 0 ? null : `relay exited with code ${code}`,
      })
    })

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.child !== child) return this.getStatus()
      if (await healthy(port)) {
        appLog.info('remote', `Relay healthy on 127.0.0.1:${port}`)
        this.setStatus({ state: 'running', error: null })
        return this.getStatus()
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    this.setStatus({
      state: 'error',
      error: `relay did not answer /health within ${Math.round(timeoutMs / 1000)}s`,
    })
    this.stop()
    return this.getStatus()
  }

  stop(): void {
    const child = this.child
    if (!child) {
      this.setStatus({ state: 'stopped', error: null })
      return
    }
    this.child = null
    child.kill()
    this.setStatus({ state: 'stopped', port: null, error: null })
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return response.ok
  } catch {
    return false
  }
}
