import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { RemoteTunnelStatus } from '../../shared/ipc-contracts'
import { RemoteTunnel } from '../remote-tunnel'
import { isObject } from './validation'
import type { IpcContext } from './context'

/**
 * Remote access: bring a temporary Cloudflare tunnel up over a local port and
 * report its short-lived URL, which the renderer turns into a QR code.
 *
 * One tunnel per app instance. Publishing two would produce two live URLs for
 * the same machine with no way for the user to tell which QR is which, and the
 * whole point of a quick tunnel is that exactly one capability is outstanding
 * at a time and revoking it means stopping the process.
 */
export function registerRemoteHandlers(_ctx: IpcContext): void {
  const tunnel = new RemoteTunnel()

  ipcMain.handle(IPC_CHANNELS.REMOTE_START, async (_event, options: unknown): Promise<RemoteTunnelStatus> => {
    const port = isObject(options) && typeof options.port === 'number' ? options.port : NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port must be an integer between 1 and 65535')
    }
    return tunnel.start(port)
  })

  ipcMain.handle(IPC_CHANNELS.REMOTE_STOP, async (): Promise<RemoteTunnelStatus> => {
    tunnel.stop()
    return tunnel.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.REMOTE_STATUS, async (): Promise<RemoteTunnelStatus> => tunnel.getStatus())

  // A tunnel is a live capability pointing at this machine; it must not outlive
  // the window that opened it.
  const shutdown = (): void => tunnel.stop()
  process.once('exit', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
