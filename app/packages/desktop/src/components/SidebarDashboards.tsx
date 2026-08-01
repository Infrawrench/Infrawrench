import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { getDb } from "../db/client";
import { createDashboard } from "../lib/pins";
import {
  CHAT_CONVERSATIONS_CHANGED_EVENT,
  DEFAULT_CHAT_MODEL,
  ChangesIcon,
  DeployIcon,
  ExpiryIcon,
  GraphIcon,
  DroppableDashboardItem,
  emitChatConversationsChanged,
  SidebarNavGrid,
  useUIStore,
  type ConversationSummary,
  type SidebarNavTileDef,
} from "@infrawrench/ui";
import { WorkflowIcon } from "@infrawrench/ui/workflows";
import { CostsIcon } from "@infrawrench/ui/cost";
import {
  agentsTabTarget,
  costsTabTarget,
  graphTabTarget,
  chatTabTarget,
  dashboardTabTarget,
  deploymentsTabTarget,
  workflowsTabTarget,
  navigateToWorkspaceTarget,
} from "../lib/workspace-tabs";
import { listCloudDashboards, createCloudDashboard, deleteCloudDashboard } from "../lib/cloud-api";
import { getDesktopChatClient } from "./CloudChatPanel";

interface DashboardRow {
  id: string;
  name: string;
  is_default: number;
}

export function SidebarDashboards() {
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState("");
  const newInputRef = useRef<HTMLInputElement>(null);
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const [chatSessions, setChatSessions] = useState<ConversationSummary[]>([]);

  // Chat sessions — cloud-mode only (the chat agent runs in the web backend).
  const loadChats = useCallback(async () => {
    if (!activeCloudOrgId) {
      setChatSessions([]);
      return;
    }
    try {
      const sessions = await getDesktopChatClient(activeCloudOrgId).listConversations();
      setChatSessions(sessions);
      // Keep chat workspace tab titles in sync with conversation titles —
      // conversations auto-rename after the first message, and restored tabs
      // carry whatever title they had when the app last closed.
      const titleById = new Map(sessions.map((c) => [c.id, c.title]));
      const { workspaceTabs, setWorkspaceTabTitle } = useUIStore.getState();
      for (const tab of workspaceTabs) {
        if (tab.target.kind !== "chat" || !tab.target.conversationId) continue;
        const title = titleById.get(tab.target.conversationId);
        if (title && title !== tab.title) setWorkspaceTabTitle(tab.id, title);
      }
    } catch (err) {
      console.error("[sidebar-chat] Failed to load chat sessions:", err);
      setChatSessions([]);
    }
  }, [activeCloudOrgId]);

  useEffect(() => {
    void loadChats();
    const handler = () => void loadChats();
    window.addEventListener(CHAT_CONVERSATIONS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CHAT_CONVERSATIONS_CHANGED_EVENT, handler);
  }, [loadChats]);

  async function handleNewChat() {
    if (!activeCloudOrgId) return;
    try {
      // Name the model rather than relying on the server's fallback: this
      // button has no picker, so whatever it asks for is what the user gets.
      const created =
        await getDesktopChatClient(activeCloudOrgId).createConversation(DEFAULT_CHAT_MODEL);
      emitChatConversationsChanged();
      void navigateToWorkspaceTarget(navigate, chatTabTarget(created.id), { label: "New chat" });
    } catch (err) {
      console.error("[sidebar-chat] Failed to create chat:", err);
    }
  }

  async function handleArchiveChat(id: string) {
    if (!activeCloudOrgId) return;
    try {
      await getDesktopChatClient(activeCloudOrgId).archiveConversation(id);
      setChatSessions((prev) => prev.filter((c) => c.id !== id));
      emitChatConversationsChanged();
      useUIStore
        .getState()
        .removeWorkspaceTabs(
          useUIStore
            .getState()
            .workspaceTabs.flatMap((tab) =>
              tab.target.kind === "chat" && tab.target.conversationId === id ? [tab.id] : [],
            ),
        );
    } catch (err) {
      console.error("[sidebar-chat] Failed to archive chat:", err);
    }
  }

  async function load() {
    try {
      if (activeCloudOrgId) {
        const cloud = await listCloudDashboards(activeCloudOrgId);
        setDashboards(
          cloud.map((d) => ({ id: d.id, name: d.name, is_default: d.isDefault ? 1 : 0 })),
        );
      } else {
        const db = await getDb();
        const rows = await db.select<DashboardRow[]>(
          "SELECT id, name, is_default FROM dashboards ORDER BY is_default DESC, created_at ASC",
        );
        setDashboards(rows);
      }
    } catch (err) {
      console.error("[sidebar-dashboards] Failed to load dashboards:", err);
      setDashboards([]);
    }
  }

  useEffect(() => {
    void load();
  }, [dashboardPinsVersion, activeCloudOrgId]);

  useEffect(() => {
    if (addingNew) {
      newInputRef.current?.focus();
    }
  }, [addingNew]);

  async function handleCreateDashboard() {
    const name = newName.trim();
    if (!name) {
      setAddingNew(false);
      setNewName("");
      return;
    }
    try {
      if (activeCloudOrgId) {
        await createCloudDashboard(activeCloudOrgId, name);
      } else {
        const db = await getDb();
        await createDashboard(name, db);
      }
      setNewName("");
      setAddingNew(false);
      await load();
    } catch (err) {
      console.error("[sidebar-dashboards] Failed to create dashboard:", err);
    }
  }

  // Deploy is here in both modes: with an org it is the full deploy screen,
  // and without one it is the history of what `infrawrench deploy` did on this
  // machine. Costs and Changes have no local half — spend is collected
  // server-side, change events are recorded by the cloud poller — so the grid
  // is four tiles locally and six with an org; SidebarNavGrid squares off an
  // odd count itself.
  const navTiles: SidebarNavTileDef[] = [
    {
      key: "agents",
      label: "Agents",
      icon: <span className="font-mono text-[11px]">&gt;_</span>,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, agentsTabTarget(), { label: "Agents" }),
    },
    {
      key: "workflows",
      label: "Workflows",
      icon: <WorkflowIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, workflowsTabTarget(), { label: "Workflows" }),
    },
    {
      key: "deploy",
      label: "Deploy",
      icon: <DeployIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, deploymentsTabTarget(), { label: "Deploy" }),
    },
    ...(activeCloudOrgId
      ? [
          {
            key: "costs",
            label: "Costs",
            icon: <CostsIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, costsTabTarget(), { label: "Costs" }),
          },
          // Cloud-only for the same reason as Costs: change events are recorded
          // by the cloud poller, and there is no poller in local-only mode.
          // Not a workspace tab — same as web, a plain route.
          {
            key: "changes",
            label: "Changes",
            icon: <ChangesIcon />,
            onClick: () => void navigate({ to: "/changes" }),
          },
        ]
      : []),
    // Graph has a local half — output references live in the local SQLite —
    // so unlike Costs the tile shows in both modes.
    {
      key: "graph",
      label: "Graph",
      icon: <GraphIcon />,
      onClick: () => void navigateToWorkspaceTarget(navigate, graphTabTarget(), { label: "Graph" }),
    },
    // Expiring also has a local half — the feed is computed from stored state
    // and the locally loaded plugins' expiry declarations. Not a workspace
    // tab — same as web and Changes, a plain route.
    {
      key: "expiring",
      label: "Expiring",
      icon: <ExpiryIcon />,
      onClick: () => void navigate({ to: "/expiring" }),
    },
  ];

  return (
    <div className="mb-2">
      <SidebarNavGrid tiles={navTiles} />

      {/* Section header */}
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wide">
          Dashboards
        </span>
        <button
          type="button"
          onClick={() => setAddingNew(true)}
          title="New dashboard"
          aria-label="Create new dashboard"
          className="text-on-surface-faint hover:text-on-surface-secondary text-sm leading-none size-5 flex items-center justify-center rounded hover:bg-surface-overlay transition-colors"
        >
          +
        </button>
      </div>

      {dashboards.map((dash) => (
        <DroppableDashboardItem
          key={dash.id}
          dashboardId={dash.id}
          name={dash.name}
          isActive={pathname === `/dashboard/${dash.id}`}
          isDefault={dash.is_default === 1}
          draggable
          extraDragData={{ workspaceTabTarget: dashboardTabTarget(dash.id) }}
          onClick={() =>
            void navigateToWorkspaceTarget(navigate, dashboardTabTarget(dash.id), {
              label: dash.name,
            })
          }
          onDelete={
            dash.is_default !== 1
              ? () => {
                  void (async () => {
                    try {
                      if (activeCloudOrgId) {
                        await deleteCloudDashboard(activeCloudOrgId, dash.id);
                      } else {
                        const db = await getDb();
                        await db.execute("DELETE FROM dashboard_pins WHERE dashboard_id = $1", [
                          dash.id,
                        ]);
                        await db.execute("DELETE FROM dashboards WHERE id = $1", [dash.id]);
                      }
                      removeWorkspaceTabs(
                        useUIStore
                          .getState()
                          .workspaceTabs.flatMap((tab) =>
                            tab.target.kind === "dashboard" && tab.target.dashboardId === dash.id
                              ? [tab.id]
                              : [],
                          ),
                      );
                      setDashboards((prev) => prev.filter((d) => d.id !== dash.id));
                      // Navigate home if we just deleted the active dashboard
                      void navigate({ to: "/" });
                    } catch (err) {
                      console.error("[sidebar-dashboards] Failed to delete dashboard:", err);
                    }
                  })();
                }
              : undefined
          }
        />
      ))}

      {/* New dashboard inline input */}
      {addingNew && (
        <div className="mx-2 px-3 py-1.5">
          <input
            ref={newInputRef}
            aria-label="New dashboard name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Dashboard name…"
            onBlur={() => void handleCreateDashboard()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateDashboard();
              if (e.key === "Escape") {
                setAddingNew(false);
                setNewName("");
              }
            }}
            className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
          />
        </div>
      )}

      {/* Chat sessions — only when signed in to cloud with an active org */}
      {activeCloudOrgId && (
        <div className="mb-2">
          <div className="flex items-center justify-between px-3 py-1">
            <button
              type="button"
              onClick={() =>
                void navigateToWorkspaceTarget(navigate, chatTabTarget(), { label: "Chat" })
              }
              className="text-xs font-medium text-on-surface-muted uppercase tracking-wide hover:text-on-surface-secondary transition-colors"
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => void handleNewChat()}
              title="New chat"
              aria-label="Start new chat"
              className="text-on-surface-faint hover:text-on-surface-secondary text-sm leading-none size-5 flex items-center justify-center rounded hover:bg-surface-overlay transition-colors"
            >
              +
            </button>
          </div>

          {chatSessions.slice(0, 8).map((chat) => {
            const isActive =
              pathname === "/chat" &&
              new URLSearchParams(searchStr ?? "").get("conversation") === chat.id;
            return (
              <div
                key={chat.id}
                className={`group mx-2 flex items-center rounded-lg transition-colors ${
                  isActive
                    ? "bg-surface-overlay text-on-surface"
                    : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
                }`}
              >
                <button
                  type="button"
                  onClick={() =>
                    void navigateToWorkspaceTarget(navigate, chatTabTarget(chat.id), {
                      label: chat.title,
                    })
                  }
                  className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs"
                >
                  <span className="block truncate">{chat.title}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleArchiveChat(chat.id)}
                  title="Archive chat"
                  aria-label="Archive chat"
                  className="opacity-0 group-hover:opacity-100 text-on-surface-faint hover:text-red-500 text-xs px-2 py-1.5 transition-opacity"
                >
                  ×
                </button>
              </div>
            );
          })}

          {chatSessions.length > 8 && (
            <button
              type="button"
              onClick={() =>
                void navigateToWorkspaceTarget(navigate, chatTabTarget(), { label: "Chat" })
              }
              className="mx-2 px-3 py-1 text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
            >
              All chats…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
