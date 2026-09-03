import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-contracts'
import type { StackActionEvent } from '../../shared/ipc-contracts'
import { StackControl } from '../stack-control'
import { isString } from './validation'
import type { IpcContext } from './context'

/**
 * Wires the in-app Stack panel to local-stack's stack.ps1.
 *
 * Action output is streamed to every window over EVENT_STACK_ACTION rather than
 * bundled into the invoke reply: a model download or an app build runs for
 * minutes, and the panel needs to show it happening, not hang on one await.
 */
export function registerStackHandlers(_ctx: IpcContext): void {
  const stack = new StackControl()

  stack.on('action', (event: StackActionEvent) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.EVENT_STACK_ACTION, event)
    }
  })

  ipcMain.handle(IPC_CHANNELS.STACK_STATUS, () => stack.status())

  ipcMain.handle(IPC_CHANNELS.STACK_UPDATE_LLAMA, (_e, tag: unknown) =>
    stack.updateLlama(isString(tag) && tag ? tag : undefined))

  ipcMain.handle(IPC_CHANNELS.STACK_DOWNLOAD_MODEL, (_e, repo: unknown, file: unknown, alias: unknown) => {
    if (!isString(repo) || !isString(file)) throw new Error('repo and file are required')
    // A repo id or filename with a quote or shell metacharacter must not reach
    // a spawned command as anything but a literal argument. spawn() with an
    // args array already prevents shell interpretation, but reject the obvious
    // path-escape shapes early with a clear message rather than a confusing
    // download failure.
    for (const [label, value] of [['repo', repo], ['file', file]] as const) {
      if (/["'`;&|<>\n\r]/.test(value)) throw new Error(`${label} contains illegal characters`)
    }
    if (!file.endsWith('.gguf')) throw new Error('file must be a .gguf')
    return stack.downloadModel(repo, file, isString(alias) && alias ? alias : undefined)
  })

  ipcMain.handle(IPC_CHANNELS.STACK_REMOVE_MODEL, (_e, name: unknown) => {
    if (!isString(name) || !name) throw new Error('name is required')
    return stack.removeModel(name)
  })

  ipcMain.handle(IPC_CHANNELS.STACK_BUILD_APP, () => stack.buildApp())
  ipcMain.handle(IPC_CHANNELS.STACK_REVERT_APP, (_e, to: unknown) =>
    stack.revertApp(isString(to) && to ? to : undefined))
  ipcMain.handle(IPC_CHANNELS.STACK_SNAPSHOT, (_e, note: unknown) =>
    stack.snapshot(isString(note) && note ? note : undefined))
  ipcMain.handle(IPC_CHANNELS.STACK_RESTART_SERVER, () => stack.restartServer())
}
