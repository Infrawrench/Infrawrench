import { useState, useEffect, useRef, useCallback } from "react";
import { useGT } from "gt-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { getDb } from "../db/client";
import { createDashboard } from "../lib/pins";
import {
  CHAT_CONVERSATIONS_CHANGED_EVENT,
  DEFAULT_CHAT_MODEL,
  DroppableDashboardItem,
  emitChatConversationsChanged,
  SidebarApps,
  SidebarHomeButton,
  SidebarRecentTools,
  SidebarToolsButton,
  useUIStore,
  type ConversationSummary,
  type SidebarToolDef,
  CloseIcon,
  usePaletteIntent,
} from "@infrawrench/ui";
import {
  chatTabTarget,
  homeTabTarget,
  dashboardTabTarget,
  navigateToWorkspaceTarget,
} from "../lib/workspace-tabs";
import { listCloudDashboards, createCloudDashboard, deleteCloudDashboard } from "../lib/cloud-api";
import { getDesktopChatClient } from "./CloudChatPanel";
import { useOrgTools } from "../lib/org-tools";
import { cloudClient } from "../lib/cloud-client";
import { runRpc } from "../lib/rpc/client";

interface DashboardRow {
  id: string;
  name: string;
  is_default: number;
}

export function SidebarDashboards() {
  const gt = useGT();
  const [dashboards, setDashboards] = useState<DashboardRow[]>([]);
  const [addingNew, setAddingNew] = useState(false);
  // "Create dashboard" from the command palette (which expands the sidebar first).
  usePaletteIntent(
    (intent) => intent.type === "create" && intent.kind === "dashboard",
    () => setAddingNew(true),
  );
  const [newName, setNewName] = useState("");
  const newInputRef = useRef<HTMLInputElement>(null);
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);
  const removeWorkspaceTabs = useUIStore((s) => s.removeWorkspaceTabs);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navTools = useOrgTools();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const [chatSessions, setChatSessions] = useState<ConversationSummary[]>([]);

  // Chat sessions: cloud-mode only (the chat agent runs in the web backend).
  const loadChats = useCallback(async () => {
    if (!activeCloudOrgId) {
      setChatSessions([]);
      return;
    }
    try {
      const sessions = await getDesktopChatClient(activeCloudOrgId).listConversations();
      setChatSessions(sessions);
      // Keep chat workspace tab titles in sync with conversation titles:
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
      void navigateToWorkspaceTarget(navigate, chatTabTarget(created.id), {
        label: gt("New chat"),
      });
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

  return (
    <div className="mb-2">
      <SidebarHomeButton
        active={pathname === "/home"}
        onClick={() => void navigateToWorkspaceTarget(navigate, homeTabTarget())}
      />
      <SidebarToolsButton tools={navTools} />
      <SidebarRecentTools tools={navTools} scope={activeCloudOrgId ?? "local"} />
      <SidebarApps tools={navTools} />

      {/* Section header */}
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wide">
          {gt("Dashboards")}
        </span>
        <button
          type="button"
          onClick={() => setAddingNew(true)}
          title={gt("New dashboard")}
          aria-label={gt("Create new dashboard")}
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
            aria-label={gt("New dashboard name")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={gt("Dashboard name…")}
            onBlur={() => void handleCreateDashboard()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreateDashboard();
              if (e.key === "Escape") {
                setAddingNew(false);
                setNewName("");
              }
            }}
            className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-accent-subtle"
          />
        </div>
      )}

      {/* Chat sessions, only when signed in to cloud with an active org */}
      {activeCloudOrgId && (
        <div className="mb-2">
          <div className="flex items-center justify-between px-3 py-1">
            <button
              type="button"
              onClick={() =>
                void navigateToWorkspaceTarget(navigate, chatTabTarget(), { label: gt("Chat") })
              }
              className="text-xs font-medium text-on-surface-muted uppercase tracking-wide hover:text-on-surface-secondary transition-colors"
            >
              {gt("Chat")}
            </button>
            <button
              type="button"
              onClick={() => void handleNewChat()}
              title={gt("New chat")}
              aria-label={gt("Start new chat")}
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
                  title={gt("Archive chat")}
                  aria-label={gt("Archive chat")}
                  className="opacity-0 group-hover:opacity-100 text-on-surface-faint hover:text-danger text-xs px-2 py-1.5 transition-opacity"
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            );
          })}

          {chatSessions.length > 8 && (
            <button
              type="button"
              onClick={() =>
                void navigateToWorkspaceTarget(navigate, chatTabTarget(), { label: gt("Chat") })
              }
              className="mx-2 px-3 py-1 text-xs text-on-surface-faint hover:text-on-surface-secondary transition-colors"
            >
              {gt("All chats…")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
