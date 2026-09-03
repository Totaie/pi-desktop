import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { EventEmitter } from 'events'
import { appLog } from './app-log'
import type { StackStatus, StackActionEvent } from '../shared/ipc-contracts'

/**
 * The in-app face of local-stack's stack.ps1.
 *
 * Everything maintenance-related — updating llama.cpp, downloading a model,
 * reverting the app — is done by that script, and this only shells out to it.
 * The reason is the same one that shaped the script: the recovery path must not
 * live inside the thing being recovered. If this app will not launch, the exact
 * same commands still run from a terminal, so the app is a convenience over the
 * script, never the only way to reach it.
 *
 * Long actions (a multi-GB download, a build) stream their output as events so
 * the panel shows progress instead of freezing on one long await.
 */

/** Where local-stack lives. Overridable for a moved checkout. */
function stackScript(): string | null {
  const candidates = [
    process.env.PI_DESKTOP_STACK_SCRIPT,
    'E:\\Folders\\Coding\\AI\\local-stack\\scripts\\stack.ps1',
    join(homedir(), 'local-stack', 'scripts', 'stack.ps1'),
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => existsSync(p)) ?? null
}

export class StackControl extends EventEmitter {
  /** Only one maintenance action at a time: they contend for the same files. */
  private running: string | null = null

  isBusy(): boolean {
    return this.running !== null
  }

  /**
   * Run a stack.ps1 subcommand, streaming stdout/stderr as 'output' events and
   * resolving with the exit code. Rejects only if it cannot be launched at all.
   */
  private run(action: string, args: string[]): Promise<{ code: number }> {
    const script = stackScript()
    if (!script) {
      return Promise.reject(new Error(
        'local-stack was not found. Expected stack.ps1 under E:\\Folders\\Coding\\AI\\local-stack\\scripts, ' +
        'or set PI_DESKTOP_STACK_SCRIPT to its path.'
      ))
    }
    if (this.running) {
      return Promise.reject(new Error(`A stack action (${this.running}) is already running.`))
    }
    this.running = action
    this.emit('action', { action, phase: 'start' } satisfies StackActionEvent)

    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, action, ...args,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

      const push = (chunk: Buffer): void => {
        const text = chunk.toString()
        this.emit('action', { action, phase: 'output', text } satisfies StackActionEvent)
      }
      child.stdout.on('data', push)
      child.stderr.on('data', push)

      child.on('error', (err) => {
        this.running = null
        this.emit('action', { action, phase: 'error', text: err.message } satisfies StackActionEvent)
        reject(err)
      })
      child.on('exit', (code) => {
        this.running = null
        const exit = code ?? -1
        appLog.info('stack', `action ${action} exited ${exit}`)
        this.emit('action', { action, phase: 'end', code: exit } satisfies StackActionEvent)
        resolve({ code: exit })
      })
    })
  }

  /**
   * Machine-readable status. Runs `stack.ps1 status` for the human view AND
   * reads the same underlying facts directly, so the panel has structured data
   * without scraping console text.
   */
  async status(): Promise<StackStatus> {
    const script = stackScript()
    const installedRaw = readJson(join(binDir(), 'INSTALLED.json'))?.tag
    const installed = typeof installedRaw === 'string' ? installedRaw : null
    const reported = await reportedLlamaBuild()
    const latest = await latestLlamaTag()
    const builds = listBuilds()
    const current = currentBuildName()
    return {
      scriptFound: Boolean(script),
      scriptPath: script,
      llama: { installed, reported, latest, mismatch: Boolean(installed && reported && installed !== reported) },
      builds,
      currentBuild: current,
      busy: this.isBusy(),
    }
  }

  updateLlama(tag?: string): Promise<{ code: number }> {
    return this.run('update-llama', tag ? ['-Tag', tag] : [])
  }
  downloadModel(repo: string, file: string, alias?: string): Promise<{ code: number }> {
    const args = [repo, file]
    if (alias) args.push('-Alias', alias)
    return this.run('download-model', args)
  }
  removeModel(name: string): Promise<{ code: number }> {
    return this.run('remove-model', [name])
  }
  buildApp(): Promise<{ code: number }> {
    return this.run('build-app', [])
  }
  revertApp(to?: string): Promise<{ code: number }> {
    return this.run('revert-app', to ? ['-To', to] : [])
  }
  snapshot(note?: string): Promise<{ code: number }> {
    return this.run('snapshot', note ? ['-Note', note] : [])
  }
  restartServer(): Promise<{ code: number }> {
    return this.run('restart-server', [])
  }
}

// ─── direct reads (structured status without scraping the script) ────────────

function binDir(): string {
  return process.env.PI_DESKTOP_STACK_BIN ?? 'E:\\Folders\\Coding\\AI\\local-stack\\bin'
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    // Lazy require: this file loads in the main process at startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return JSON.parse(require('fs').readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

async function reportedLlamaBuild(): Promise<string | null> {
  const exe = join(binDir(), 'llama-server.exe')
  if (!existsSync(exe)) return null
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(exe, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const grab = (c: Buffer): void => { out += c.toString() }
    child.stdout.on('data', grab)
    child.stderr.on('data', grab)
    child.on('error', () => resolve(null))
    child.on('exit', () => {
      const m = out.match(/build (\d+)/)
      resolve(m ? `b${m[1]}` : null)
    })
  })
}

async function latestLlamaTag(): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const r = await fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=1', { signal: controller.signal })
    clearTimeout(timer)
    const data = (await r.json()) as Array<{ tag_name?: string }>
    return data?.[0]?.tag_name ?? null
  } catch {
    return null
  }
}

function buildsDir(): string {
  return 'E:\\Folders\\Coding\\AI\\pi-desktop-fork\\release\\builds'
}

function listBuilds(): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    if (!fs.existsSync(buildsDir())) return []
    return fs.readdirSync(buildsDir(), { withFileTypes: true })
      .filter((d: import('fs').Dirent) => d.isDirectory())
      .map((d: import('fs').Dirent) => d.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
}

function currentBuildName(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs')
    const current = 'E:\\Folders\\Coding\\AI\\pi-desktop-fork\\release\\current'
    if (!fs.existsSync(current)) return null
    const target = fs.readlinkSync(current)
    // …\builds\<name>\win-unpacked -> <name>
    const parts = target.replace(/[\\/]win-unpacked[\\/]?$/, '').split(/[\\/]/)
    return parts[parts.length - 1] || null
  } catch {
    return null
  }
}
