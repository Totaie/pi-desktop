import { useMemo } from 'react'
import { clsx } from 'clsx'
import { FolderOpen, FolderTree, GitCompare, MessageSquarePlus, PanelLeft, QrCode, Settings, ShieldCheck, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useGlobalWorkflowOpen } from '../hooks'
import { getSessionTitle } from '../utils/session-title'
import { pathsEqual } from '../../../shared/path-compare'
import { SessionRuntimeIndicator } from './session-runtime-indicator'
import type { SessionRuntimeInfo, Workspace } from '../../../shared/ipc-contracts'

/**
 * One flat row of chats.
 *
 * Replaces the two-tier project row + session row. A chat is a session runtime
 * plus the directory it runs in — there is no project layer above it and no
 * session layer below it, so there is nothing to navigate between. Every chat
 * from every directory is in this one list, which is the point: switching
 * chats and switching directories were previously two different gestures in
 * two different bars for what the user experiences as one action.
 *
 * The workspace model still exists underneath because a cwd has to live
 * somewhere and Pi is spawned per directory; it is simply not a thing the user
 * is asked to think about any more.
 */

/** Directory label for a chat — the folder name, not the project's given name. */
function directoryLabel(workspace: Workspace | undefined): string {
  if (!workspace) return ''
  return workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path
}

export function ChatTabs(): React.JSX.Element {
  const sessionRuntimes = useAppStore((state) => state.sessionRuntimes)
  const workspaces = useAppStore((state) => state.workspaces)
  const sessionList = useAppStore((state) => state.sessionList)
  const activeSessionRuntimeId = useAppStore((state) => state.activeSessionRuntimeId)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const currentView = useAppStore((state) => state.currentView)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const setWorkflowPanelOpen = useAppStore((state) => state.setWorkflowPanelOpen)
  const openChat = useAppStore((state) => state.openChat)
  const closeSessionTab = useAppStore((state) => state.closeSessionTab)
  const createChatInDirectory = useAppStore((state) => state.createChatInDirectory)
  const setRemotePanelOpen = useAppStore((state) => state.setRemotePanelOpen)
  const globalWorkflowOpen = useGlobalWorkflowOpen()

  const toolView = ['settings', 'packages', 'notes', 'skills', 'diagnostics'] as const
  const toolsActive =
    toolView.includes(currentView as (typeof toolView)[number]) || globalWorkflowOpen

  // Creation order, so a chat never moves under the pointer. Selecting one
  // changes which tab is highlighted and nothing else about the layout.
  const chats = useMemo(
    () => Object.values(sessionRuntimes).sort((a, b) => a.runtimeId.localeCompare(b.runtimeId)),
    [sessionRuntimes]
  )

  const workspaceById = useMemo(() => {
    const map = new Map<string, Workspace>()
    for (const workspace of workspaces) map.set(workspace.id, workspace)
    return map
  }, [workspaces])

  const chatTitle = (runtime: SessionRuntimeInfo): string => {
    const session = sessionList.find(
      (item) => runtime.sessionPath && pathsEqual(item.path, runtime.sessionPath)
    )
    if (!session) return 'New chat'
    return getSessionTitle(session.name, session.sessionId, session.preview)
  }

  return (
    <div className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-app px-2 pt-1">
      {!sidebarOpen && (
        <button
          type="button"
          onClick={toggleSidebar}
          className="mb-1 flex h-7 w-7 shrink-0 animate-fade-in items-center justify-center rounded-md border border-border-strong bg-surface text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus"
          title="Show sidebar"
          aria-label="Show sidebar"
        >
          <PanelLeft size={15} />
        </button>
      )}

      {chats.map((runtime) => {
        const workspace = workspaceById.get(runtime.workspaceId)
        const active = !toolsActive && runtime.runtimeId === activeSessionRuntimeId
        const folder = directoryLabel(workspace)
        return (
          <div
            key={runtime.runtimeId}
            onAuxClick={(event) => {
              if (event.button !== 1) return
              event.preventDefault()
              void closeSessionTab(runtime.runtimeId)
            }}
            className={clsx(
              'group mb-1 flex min-w-0 max-w-[260px] shrink-0 items-center rounded-md text-xs transition-colors',
              active
                ? 'bg-card text-primary shadow-sm'
                : 'text-muted hover:bg-highlight hover:text-secondary'
            )}
          >
            <button
              type="button"
              onClick={() => void openChat(runtime.runtimeId)}
              className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
              title={workspace ? `${chatTitle(runtime)} — ${workspace.path}` : chatTitle(runtime)}
              aria-current={active ? 'page' : undefined}
            >
              <SessionRuntimeIndicator runtime={runtime} />
              <span className="truncate">{chatTitle(runtime)}</span>
              {/* The directory is the only thing configured about a chat, so it
                  stays visible rather than living in a parent tab the user has
                  to look up. */}
              {folder && (
                <span className="shrink-0 text-[10px] text-faint" title={workspace?.path}>
                  {folder}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void closeSessionTab(runtime.runtimeId)}
              className="mr-1 shrink-0 rounded p-0.5 text-faint opacity-0 transition-all hover:bg-highlight-strong hover:text-primary group-hover:opacity-100"
              title="Close chat"
              aria-label="Close chat"
            >
              <X size={11} />
            </button>
          </div>
        )
      })}

      {toolsActive && (
        <div className="group mb-1 flex shrink-0 items-center rounded-md bg-card text-xs text-primary shadow-sm">
          <span className="flex items-center gap-1.5 px-2 py-1.5">
            <Settings size={13} />
            Tools
          </span>
          <button
            type="button"
            onClick={() => {
              setWorkflowPanelOpen(false)
              setCurrentView('chat')
            }}
            className="mr-1 rounded p-0.5 text-faint opacity-0 transition-all hover:bg-highlight-strong hover:text-primary group-hover:opacity-100"
            title="Close tools"
            aria-label="Close tools"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* The Chat button. Asks for a directory, because that is the one thing a
          chat is configured with. */}
      <button
        type="button"
        onClick={() => {
          setWorkflowPanelOpen(false)
          void createChatInDirectory()
        }}
        className="mb-1 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-primary"
        title="New chat in a folder you choose"
        aria-label="New chat in a folder you choose"
      >
        <MessageSquarePlus size={15} />
        Chat
      </button>

      {/* Same thing without the dialog, for the folder already in front of you. */}
      <button
        type="button"
        onClick={() => {
          setWorkflowPanelOpen(false)
          const current = useAppStore.getState().activeWorkspace
          if (current) void createChatInDirectory(current.path)
          else void createChatInDirectory()
        }}
        className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-primary"
        title="New chat in this folder (Ctrl/Cmd+N)"
        aria-label="New chat in this folder"
      >
        <FolderOpen size={15} />
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {/* Rehomed from the removed toolbar row. These three had no other
            entry point — terminal has the status bar and the sidebar has its
            own toggle, but review, files and diff would simply have become
            unreachable. */}
        <button
          type="button"
          onClick={() => useAppStore.getState().toggleReview()}
          className="mb-1 flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-primary"
          title="Review panel"
          aria-label="Review panel"
        >
          <ShieldCheck size={15} />
        </button>
        <button
          type="button"
          onClick={() => {
            const state = useAppStore.getState()
            void state.setChatSidePanel(state.chatSidePanel === 'files' ? null : 'files')
          }}
          className="mb-1 flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-primary"
          title="File tree"
          aria-label="File tree"
        >
          <FolderTree size={15} />
        </button>
        <button
          type="button"
          onClick={() => {
            const state = useAppStore.getState()
            void state.setChatSidePanel(state.chatSidePanel === 'diff' ? null : 'diff')
          }}
          className="mb-1 flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-primary"
          title="Diff viewer"
          aria-label="Diff viewer"
        >
          <GitCompare size={15} />
        </button>
        <button
          type="button"
          onClick={() => setRemotePanelOpen(true)}
          className={clsx(
            'mb-1 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors',
            'text-muted hover:bg-surface-hover hover:text-primary'
          )}
          title="Show a QR code to reach this machine from your phone"
          aria-label="Remote access"
        >
          <QrCode size={15} />
          Remote
        </button>
      </div>
    </div>
  )
}
