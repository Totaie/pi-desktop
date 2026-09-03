import { useAppStore } from '../store'
import { pathGroupKey, pathsEqual } from '../../../shared/path-compare'
import { clsx } from 'clsx'
import {
  Home,
  MessageSquare,
  Settings,
  FolderOpen,
  PanelLeftClose,
  Clock,
  Package,
  ChevronDown,
  Archive,
  Sparkles,
  Stethoscope,
  HardDriveDownload,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import { useMemo, useState, useRef } from 'react'
import { StatusPopover } from './status-popover'
import { useContextMenu, buildSessionContextMenu } from './context-menu'
import { getSessionEngineLabel, getSessionRowLabels, hasMixedSessionEngines } from './sidebar-session-labels'
import { ResizeHandle } from './resize-handle'
import { formatRelativeTime } from '../utils/format-relative-time'
import { SessionRuntimeIndicator } from './session-runtime-indicator'
import { resolveRunSessionId } from '../utils/workflow-runs'
import { useGlobalWorkflowOpen } from '../hooks'
import { clampSidebarWidth, resolveSidebarWidth } from '../../../shared/sidebar-width'
import type { SessionListItem } from '../../../shared/ipc-contracts'

/** Views reachable from the sidebar's Tools group. */
type ToolView = 'packages' | 'notes' | 'skills' | 'diagnostics' | 'settings' | 'stack'

/** Cap how many workspace groups appear in the Recent list. */
const MAX_RECENT_GROUPS = 12
/** Cap sessions shown inside an expanded workspace group. */
const MAX_SESSIONS_PER_GROUP = 12

interface RecentSessionGroup {
  projectPath: string
  projectName: string
  sessions: SessionListItem[]
  latest: SessionListItem
}

export function Sidebar(): React.JSX.Element {
  const currentView = useAppStore((state) => state.currentView)
  const setCurrentView = useAppStore((state) => state.setCurrentView)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  const sessionState = useAppStore((state) => state.sessionState)
  const sessionList = useAppStore((state) => state.sessionList)
  const sessionRuntimes = useAppStore((state) => state.sessionRuntimes)
  const activeSessionRuntimeId = useAppStore((state) => state.activeSessionRuntimeId)
  const createNewSession = useAppStore((state) => state.createNewSession)
  const openWorkflowRunsForSession = useAppStore((state) => state.openWorkflowRunsForSession)
  const setWorkflowPanelOpen = useAppStore((state) => state.setWorkflowPanelOpen)
  const globalWorkflowOpen = useGlobalWorkflowOpen()
  const activeWorkspace = useAppStore((state) => state.activeWorkspace)
  const archivedSessions = useAppStore((state) => state.archivedSessions)
  const archiveSession = useAppStore((state) => state.archiveSession)
  const unarchiveSession = useAppStore((state) => state.unarchiveSession)
  const deleteSession = useAppStore((state) => state.deleteSession)
  const setSessionName = useAppStore((state) => state.setSessionName)
  const persistedWidth = useAppStore((state) => state.settings?.sidebarWidth)
  const saveSidebarWidth = useAppStore((state) => state.saveSidebarWidth)

  const { show: showMenu, ContextMenuComponent: SessionMenu } = useContextMenu()

  const [archivedOpen, setArchivedOpen] = useState(false)

  // The live width during a drag. Kept local so dragging never writes
  // settings.json; the draft outlives the drag so the row does not jump while the
  // save round-trips, and a remount falls back to the saved value.
  const [widthDraft, setWidthDraft] = useState<number | null>(null)
  const sidebarWidth = resolveSidebarWidth(widthDraft, persistedWidth)
  const savedWidth = resolveSidebarWidth(null, persistedWidth)
  // The handle registers its mousemove listener once per drag, so its callback
  // closes over a single render. Deltas must therefore accumulate through the
  // state updater — reading the width off a render-scoped value (or a ref written
  // during render) drops every event that lands before React re-renders.
  const widthRef = useRef(sidebarWidth)

  const applyResizeDelta = (delta: number): void => {
    setWidthDraft((current) => {
      const next = clampSidebarWidth((current ?? savedWidth) + delta)
      // Mirrored for onResizeEnd, which has no access to the updated state.
      widthRef.current = next
      return next
    })
  }

  // Inline session rename. Only the active session can be renamed (Pi's rename
  // targets it), and it's reachable from two spots — the Current Session panel
  // (`'current'`) and its highlighted row in Recent Sessions (`'recent'`).
  const [renamingWhere, setRenamingWhere] = useState<'current' | 'recent' | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameCancelRef = useRef(false)

  const startSessionRename = (where: 'current' | 'recent'): void => {
    renameCancelRef.current = false
    // Prefill with the explicit name only; a timestamp/guid is not a name.
    setRenameValue(sessionState?.sessionName ?? '')
    setRenamingWhere(where)
  }

  // Single commit path (both Enter and Escape blur the input, which lands here).
  const finishSessionRename = (): void => {
    const cancelled = renameCancelRef.current
    renameCancelRef.current = false
    setRenamingWhere(null)
    // Pi's set_session_name RPC rejects an empty name ("cannot be empty"), so an
    // empty commit is a no-op (keeps the current name) rather than a doomed call.
    const trimmed = renameValue.trim()
    if (!cancelled && trimmed) setSessionName(trimmed)
  }

  const renderRenameInput = (): React.JSX.Element => (
    <input
      type="text"
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          renameCancelRef.current = true
          e.currentTarget.blur()
        }
      }}
      onBlur={finishSessionRename}
      placeholder="Session name"
      autoFocus
      className="min-w-0 flex-1 rounded border border-border-strong bg-card px-2 py-0.5 text-sm text-primary placeholder:text-faint focus:border-focus focus:outline-none"
    />
  )

  // Archived sessions live in their own collapsible section; Recent excludes them.
  const activeSessions = useMemo(
    () => sessionList.filter((s) => !(s.sessionId in archivedSessions)),
    [sessionList, archivedSessions]
  )
  const archivedList = useMemo(
    () => sessionList.filter((s) => s.sessionId in archivedSessions),
    [sessionList, archivedSessions]
  )

  // Group recents by project folder (path). Display name = folder basename.
  const recentGroups = useMemo((): RecentSessionGroup[] => {
    // Group key is case-fold only on win32 (shared path-compare helper).
    const byProject = new Map<string, { displayPath: string; sessions: SessionListItem[] }>()
    for (const session of activeSessions) {
      const displayPath = session.projectPath || 'unknown'
      const key = pathGroupKey(displayPath)
      const existing = byProject.get(key)
      if (existing) existing.sessions.push(session)
      else byProject.set(key, { displayPath, sessions: [session] })
    }

    const groups: RecentSessionGroup[] = []
    for (const { displayPath, sessions } of byProject.values()) {
      const sorted = [...sessions].sort((a, b) => b.lastModified - a.lastModified)
      const latest = sorted[0]
      if (!latest) continue
      const folderName =
        latest.projectName?.trim() ||
        displayPath.split(/[\\/]/).filter(Boolean).pop() ||
        displayPath
      groups.push({
        projectPath: displayPath,
        projectName: folderName,
        sessions: sorted.slice(0, MAX_SESSIONS_PER_GROUP),
        latest,
      })
    }

    groups.sort((a, b) => b.latest.lastModified - a.latest.lastModified)
    return groups.slice(0, MAX_RECENT_GROUPS)
  }, [activeSessions])

  // Explicit expand/collapse overrides. Folders default to collapsed except the
  // one that contains the active session (until the user toggles).
  const [expandOverride, setExpandOverride] = useState<Record<string, boolean>>({})

  const activeProjectKey = useMemo(() => {
    if (!sessionState?.sessionFile) return null
    const active = activeSessions.find((s) => s.path === sessionState.sessionFile)
    return active ? pathGroupKey(active.projectPath || 'unknown') : null
  }, [activeSessions, sessionState?.sessionFile])

  const isGroupExpanded = (projectPath: string): boolean => {
    const key = pathGroupKey(projectPath)
    if (Object.prototype.hasOwnProperty.call(expandOverride, key)) {
      return expandOverride[key]
    }
    return activeProjectKey === key
  }

  const toggleGroup = (projectPath: string): void => {
    const key = pathGroupKey(projectPath)
    setExpandOverride((prev) => ({
      ...prev,
      [key]: !isGroupExpanded(projectPath),
    }))
  }

  // The live session state has no preview, so the Current Session panel would
  // fall back to the raw id while the same session's Recent row shows its first
  // message. Both read the same preview instead.
  // Gated on every known session, not on one section's slice, so the same chat
  // carries the same tag in Recent, in a folder group and under Archived.
  const showEngineTags = useMemo(() => hasMixedSessionEngines(sessionList), [sessionList])

  const recentSessionsForWorkspace = useMemo(() => {
    if (!activeWorkspace?.path) return []
    return activeSessions
      .filter((session) => pathsEqual(session.projectPath, activeWorkspace.path))
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, MAX_SESSIONS_PER_GROUP)
  }, [activeSessions, activeWorkspace?.path])

  const startNewSession = async (): Promise<void> => {
    if (!activeWorkspace) {
      setCurrentView('home')
      return
    }
    setCurrentView('chat')
    await createNewSession()
  }

  // A tool view is only "showing" when nothing covers it — the global workflow
  // surface replaces the main pane while currentView stays put behind it.
  const toolViewShowing = (view: ToolView): boolean => currentView === view && !globalWorkflowOpen

  // Tool entries are toggles, like every other tab-like control here: clicking
  // the one already on screen returns to Chat (what the Tools tab's close
  // button does), while a covered one is revealed rather than dismissed.
  const openToolView = (view: ToolView): void => {
    const showing = toolViewShowing(view)
    setWorkflowPanelOpen(false)
    setCurrentView(showing ? 'chat' : view)
  }

  // Workspace auto-switch/create + session switch + show Chat, shared with the
  // session panel and the quick switcher.
  const openSession = useAppStore((state) => state.openSessionItem)

  const handleSessionRightClick = (e: React.MouseEvent, session: SessionListItem): void => {
    // Prevent the app-level document-level contextmenu handler from also
    // firing (which would build & show a *default* menu on top of ours).
    // React's synthetic stopPropagation isn't enough — that handler is
    // attached to `document` and fires on native bubbling.
    e.nativeEvent.stopPropagation()
    const isActive = sessionState?.sessionFile === session.path
    showMenu(
      e,
      buildSessionContextMenu(session, session.sessionId in archivedSessions, {
        onOpen: (s) => { openSession(s) },
        onArchive: (id) => archiveSession(id),
        onUnarchive: (id) => unarchiveSession(id),
        onDelete: (s) => { deleteSession(s) },
        // Rename only offered for the active session (Pi renames the active one).
        onRename: isActive ? () => startSessionRename('recent') : undefined,
        onRuns: (s) => openWorkflowRunsForSession(resolveRunSessionId(s.piSessionId, s.sessionId) ?? s.sessionId),
      })
    )
  }

  // Right-click menu for the Current Session panel — same active session, so
  // just the rename affordance.
  const renderSessionRow = (
    session: SessionListItem,
    options?: { nested?: boolean }
  ): React.JSX.Element => {
    const labels = getSessionRowLabels(session)
    // Runs are keyed by Pi's header UUID, never the filename stem (the
    // tags/archive registry key). The stem suffix IS the UUID, so it is a
    // safe fallback when a row's header is unreadable.
    const workflowSessionId = resolveRunSessionId(session.piSessionId, session.sessionId) ?? session.sessionId
    const runtime = Object.values(sessionRuntimes).find((item) => item.sessionPath && pathsEqual(item.sessionPath, session.path))
    const isActive = sessionState?.sessionFile === session.path || runtime?.runtimeId === activeSessionRuntimeId
    const nested = options?.nested ?? false
    const engineLabel = showEngineTags ? getSessionEngineLabel(session) : null

    // Inline rename for the active row.
    if (isActive && renamingWhere === 'recent') {
      return (
        <div
          key={session.path}
          className={clsx(
            'flex w-full items-center gap-2 rounded bg-card px-2 py-1.5',
            nested && 'pl-2'
          )}
        >
          <Clock size={12} className="shrink-0 text-muted" />
          {renderRenameInput()}
        </div>
      )
    }

    return (
      <div key={session.path} className="group relative">
        <button
          onClick={() => openSession(session)}
          onDoubleClick={() => { if (isActive) startSessionRename('recent') }}
          onContextMenu={(e) => handleSessionRightClick(e, session)}
          // The full title leads, so a preview too long for the current width is
          // still readable on hover.
          title={`${labels.title}\n\n${isActive
            ? 'Click to open · double-click to rename · right-click for actions'
            : 'Click to open · right-click for actions'}`}
          className={clsx(
            'flex w-full items-center gap-2 rounded px-2 py-1.5 pr-7 text-left text-sm transition-colors',
            nested && 'pl-2',
            isActive
              ? 'bg-card text-primary'
              : 'hover:bg-highlight text-muted hover:text-secondary'
          )}
        >
          <Clock size={12} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate">{labels.title}</div>
            {/* The title is now the session's name or first message, so the time it
                displaced moves here. Recent rows are already grouped by workspace,
                which makes the project name the less useful of the two subtitles —
                the home screen, which is not grouped, shows the project instead.
                The engine leads the line only when both engines are present. */}
            <div className="truncate text-[11px] text-faint">
              {engineLabel && `${engineLabel} · `}
              {formatRelativeTime(session.lastModified, Date.now())}
            </div>
          </div>
          {runtime && <SessionRuntimeIndicator runtime={runtime} />}
        </button>
        {/* Sibling (not child) of the row button, so no nested interactive
            elements: the row's click/double-click/context-menu never fire for
            this icon. Shows an empty filtered state when the session has no runs. */}
        <button
          type="button"
          onClick={() => openWorkflowRunsForSession(workflowSessionId)}
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-faint opacity-0 transition-opacity hover:bg-highlight hover:text-accent-fg focus-visible:opacity-100 group-hover:opacity-100"
          title="Workflow runs for this session"
          aria-label="Workflow runs for this session"
        >
          <WorkflowIcon size={12} />
        </button>
      </div>
    )
  }

  const renderRecentGroup = (group: RecentSessionGroup): React.JSX.Element => {
    const expanded = isGroupExpanded(group.projectPath)
    const isCurrentFolder =
      !!activeWorkspace?.path && pathsEqual(activeWorkspace.path, group.projectPath)
    const count = group.sessions.length

    return (
      <div key={pathGroupKey(group.projectPath)} className="mb-1">
        {/* Folder header — primary grouping unit */}
        <button
          type="button"
          onClick={() => toggleGroup(group.projectPath)}
          title={group.projectPath}
          aria-expanded={expanded}
          className={clsx(
            'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors',
            isCurrentFolder
              ? 'bg-accent-bg/40 text-primary'
              : 'text-secondary hover:bg-highlight hover:text-primary'
          )}
        >
          <ChevronDown
            size={12}
            className={clsx(
              'shrink-0 text-dim transition-transform',
              !expanded && '-rotate-90'
            )}
          />
          <FolderOpen
            size={12}
            className={clsx('shrink-0', isCurrentFolder ? 'text-accent-fg' : 'text-dim')}
          />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {group.projectName}
          </span>
          <span className="shrink-0 text-[10px] text-faint">
            {count}
          </span>
        </button>

        {expanded && (
          <div className="mt-0.5 space-y-0.5 border-l border-border/70 ml-3 pl-1">
            {group.sessions.map((session) =>
              renderSessionRow(session, { nested: true })
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <>
    <aside
      className="flex shrink-0 flex-col border-r border-border bg-app"
      style={{ width: sidebarWidth }}
    >
      {/* Header */}
      <div className="flex h-12 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <StatusPopover />
          {/* Compact Home replaces the duplicate Pi-activity popover: workspace
              activity already lives in the switcher row, tab icons, and switcher
              dropdown, so the header keeps only system status + Home. */}
          <button
            type="button"
            onClick={() => setCurrentView('home')}
            className={clsx(
              'rounded p-1.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus',
              currentView === 'home'
                ? 'bg-card text-accent-fg'
                : 'text-muted hover:bg-surface-hover hover:text-primary'
            )}
            title="Home (Esc to launcher)"
            aria-label="Home"
          >
            <Home size={16} />
          </button>
          <span className="text-sm font-medium text-primary">Pi Desktop</span>
        </div>
        <button
          onClick={toggleSidebar}
          className="rounded p-1 text-muted hover:bg-surface-hover hover:text-primary"
          title="Close sidebar"
          aria-label="Close sidebar"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* No Project header, no New session button, no Current Session card.
          The folder a chat runs in is chosen in the composer now, each open
          chat is a tab, and the tab plus the composer already say which
          session and folder are live — three headers restating that is the
          chrome this fork keeps removing. */}
      {/* Navigation.
          One entry. Everything that used to live here — All chats, New task,
          Mission Control, Workflows, Timeline — was a second way to reach
          something already reachable: open chats are tabs, and the history is
          the list directly below. A nav that mostly navigates to other navs is
          the layer this fork exists to remove, so recents sit under Chat
          separated by a rule rather than behind a section of their own. */}
      <nav className="px-2 py-3">
        <SidebarItem
          icon={<MessageSquare size={14} />}
          label="Chat"
          active={currentView === 'chat'}
          onClick={() => setCurrentView('chat')}
        />
      </nav>

      {/* Recent chats in the current folder, directly under Chat. The rule
          above is the only separation the list gets — a heading naming the
          folder would repeat what every row already says. */}
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-2 py-3">
        {activeWorkspace ? (
          recentSessionsForWorkspace.length === 0 ? (
            <div className="mx-2 mt-2 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-faint">
              No sessions in this project yet.
              <button
                type="button"
                onClick={() => void startNewSession()}
                className="mt-1 block w-full text-accent-fg transition-colors hover:text-accent"
              >
                Start one now
              </button>
            </div>
          ) : (
            <div className="space-y-0.5">
              {recentSessionsForWorkspace.map((session) => renderSessionRow(session))}
            </div>
          )
        ) : recentGroups.length === 0 ? (
          <div className="mx-2 mt-2 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-faint">
            Open a project to see its sessions.
          </div>
        ) : (
          recentGroups.map(renderRecentGroup)
        )}
      </div>

      {/* Archived sessions (collapsible) */}
      {archivedList.length > 0 && (
        <div className="shrink-0 border-t border-border px-2 py-1">
          <button
            onClick={() => setArchivedOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium uppercase tracking-wider text-dim hover:text-secondary transition-colors"
            title={archivedOpen ? 'Collapse archived sessions' : 'Expand archived sessions'}
          >
            <ChevronDown
              size={12}
              className={clsx('shrink-0 transition-transform', !archivedOpen && '-rotate-90')}
            />
            <Archive size={12} className="shrink-0" />
            <span>Archived ({archivedList.length})</span>
          </button>
          {archivedOpen && (
            <div className="max-h-48 overflow-y-auto pb-1">
              {archivedList.map((session) => renderSessionRow(session))}
            </div>
          )}
        </div>
      )}

      {/* Secondary tools stay available without competing with project/session work. */}
      <div className="shrink-0 border-t border-border px-2 py-2">
        <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Tools</div>
        <div className="grid grid-cols-2 gap-0.5">
          <SidebarItem
            compact
            icon={<Package size={13} />}
            label="Packages"
            active={toolViewShowing('packages')}
            onClick={() => openToolView('packages')}
          />
          <SidebarItem
            compact
            icon={<Sparkles size={13} />}
            label="Skills"
            active={toolViewShowing('skills')}
            onClick={() => openToolView('skills')}
          />
          <SidebarItem
            compact
            icon={<Stethoscope size={13} />}
            label="Diagnostics"
            active={toolViewShowing('diagnostics')}
            onClick={() => openToolView('diagnostics')}
          />
          <SidebarItem
            compact
            icon={<HardDriveDownload size={13} />}
            label="Stack"
            active={toolViewShowing('stack')}
            onClick={() => openToolView('stack')}
          />
          <SidebarItem
            compact
            icon={<Settings size={13} />}
            label="Settings"
            active={toolViewShowing('settings')}
            onClick={() => openToolView('settings')}
          />
        </div>
      </div>
      {SessionMenu}
    </aside>
    <ResizeHandle
      onResize={applyResizeDelta}
      onResizeEnd={() => void saveSidebarWidth(widthRef.current)}
    />
    </>
  )
}

// ─── Sidebar Item ────────────────────────────────────────────────────────────

function SidebarItem({
  icon,
  label,
  active,
  onClick,
  compact = false,
  title,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
  compact?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus',
        compact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm',
        active
          ? 'bg-card text-primary'
          : 'text-muted hover:bg-highlight hover:text-secondary'
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}
