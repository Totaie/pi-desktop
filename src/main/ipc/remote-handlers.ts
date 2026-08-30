import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { RemoteStatus } from '../../shared/ipc-contracts'
import { RemoteTunnel } from '../remote-tunnel'
import { RemoteRelay, DEFAULT_RELAY_PORT } from '../remote-relay'
import { isObject } from './validation'
import type { IpcContext } from './context'

/**
 * Remote access: run the Remote Pi relay locally and publish it through a
 * temporary Cloudflare tunnel, so a phone can reach this machine by scanning a
 * QR code.
 *
 * Started as a pair on purpose. A relay nobody can reach and a tunnel pointing
 * at a closed port are both useless, and a QR generated from half of that is
 * worse than no QR: it fails on the phone, away from the machine that could
 * explain why. So the tunnel is only started once the relay answers /health,
 * and a relay that fails takes the whole operation down with a reason.
 *
 * One pair per app instance — two live URLs for the same machine would leave
 * the user with no way to tell which QR is current.
 */
export function registerRemoteHandlers(_ctx: IpcContext): void {
  const relay = new RemoteRelay()
  const tunnel = new RemoteTunnel()

  const snapshot = (): RemoteStatus => ({
    relay: relay.getStatus(),
    tunnel: tunnel.getStatus(),
  })

  ipcMain.handle(IPC_CHANNELS.REMOTE_START, async (_event, options: unknown): Promise<RemoteStatus> => {
    const raw = isObject(options) && typeof options.port === 'number' ? options.port : DEFAULT_RELAY_PORT
    if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
      throw new Error('port must be an integer between 1 and 65535')
    }
    const binaryPath = isObject(options) && typeof options.relayPath === 'string' ? options.relayPath : undefined

    const relayStatus = await relay.start(raw, binaryPath)
    // Publishing a port nothing is serving would hand out a QR that fails on
    // the phone; stop here and let the reason surface instead.
    if (relayStatus.state !== 'running') return snapshot()

    await tunnel.start(raw)
    return snapshot()
  })

  ipcMain.handle(IPC_CHANNELS.REMOTE_STOP, async (): Promise<RemoteStatus> => {
    // Tunnel first: it is the part reachable from outside, so it is the part
    // that must stop being reachable first.
    tunnel.stop()
    relay.stop()
    return snapshot()
  })

  ipcMain.handle(IPC_CHANNELS.REMOTE_STATUS, async (): Promise<RemoteStatus> => snapshot())

  // Neither half may outlive the app that opened it.
  const shutdown = (): void => {
    tunnel.stop()
    relay.stop()
  }
  process.once('exit', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
