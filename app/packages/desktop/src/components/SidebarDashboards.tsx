import { useState, useEffect, useRef, useCallback } from "react";
import { useGT } from "gt-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { getDb } from "../db/client";
import { createDashboard } from "../lib/pins";
import {
  CHAT_CONVERSATIONS_CHANGED_EVENT,
  DEFAULT_CHAT_MODEL,
  ChangesIcon,
  IacIcon,
  MetricAlertIcon,
  EnvironmentsIcon,
  ProbesIcon,
  StatusPagesIcon,
  QuotasIcon,
  IncidentsIcon,
  DeployIcon,
  ExpiryIcon,
  PostureIcon,
  AccessReviewIcon,
  BackupsIcon,
  DomainsIcon,
  EnvironmentDiffIcon,
  FanoutIcon,
  GraphIcon,
  LogsIcon,
  DroppableDashboardItem,
  emitChatConversationsChanged,
  SidebarToolsButton,
  useUIStore,
  type ConversationSummary,
  type SidebarToolDef,
} from "@infrawrench/ui";
import { WorkflowIcon } from "@infrawrench/ui/workflows";
import { CostsIcon } from "@infrawrench/ui/cost";
import { CostReportsIcon } from "@infrawrench/ui/cost-reports";
import { InvoicesIcon } from "@infrawrench/ui/invoices";
import {
  agentsTabTarget,
  costsTabTarget,
  costReportsTabTarget,
  invoicesTabTarget,
  environmentsTabTarget,
  graphTabTarget,
  logsTabTarget,
  chatTabTarget,
  dashboardTabTarget,
  deploymentsTabTarget,
  backupsTabTarget,
  dnsTabTarget,
  accessReviewTabTarget,
  iacTabTarget,
  environmentDiffTabTarget,
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
  const gt = useGT();
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
  // server-side, change events are recorded by the cloud poller — so the tool
  // count differs between local and org mode; the Tools launcher lists
  // whatever it gets.
  const navTools: SidebarToolDef[] = [
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
          // Cloud-only for the same reason as Costs: a report is an org row
          // over server-collected spend, so local mode has nothing to save or
          // draw. A workspace tab, like Costs.
          {
            key: "cost-reports",
            label: "Reports",
            icon: <CostReportsIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, costReportsTabTarget(), {
                label: "Reports",
              }),
          },
          // Cloud-only for the same reason as Costs: an invoice bills for
          // spend collected server-side, so local mode has neither the
          // customers nor the data. A workspace tab, like Costs and Reports.
          {
            key: "invoices",
            label: "Invoices",
            icon: <InvoicesIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, invoicesTabTarget(), {
                label: "Invoices",
              }),
          },
          // Cloud-only for the same reason as Costs: rules are evaluated by
          // the cloud poller against the cloud metric store. Not a workspace
          // tab — same as web, a plain route.
          {
            key: "metric-alerts",
            label: "Alerts",
            icon: <MetricAlertIcon />,
            onClick: () => void navigate({ to: "/metric-alerts" }),
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
          // Cloud-only, unlike Posture next to it: the review joins the org's
          // resource-ownership records and the shared dismissal store, neither
          // of which local mode has, and answering "unowned" for every
          // principal would describe the desktop app rather than the clouds.
          // A workspace-tab kind, so the strip stays in sync with the panel.
          {
            key: "access-review",
            label: "Access review",
            icon: <AccessReviewIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, accessReviewTabTarget(), {
                label: "Access review",
              }),
          },
          // Cloud-only: reconciliation classifies the org's *synced*
          // inventory against an uploaded Terraform state, and local-only mode
          // has no synced inventory.
          {
            key: "iac",
            label: "IaC",
            icon: <IacIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, iacTabTarget(), { label: "IaC" }),
          },
          // Cloud-only like Changes: probes run in the cloud poller through
          // the egress proxy, and results live in the cloud metric store.
          {
            key: "probes",
            label: "Probes",
            icon: <ProbesIcon />,
            onClick: () => void navigate({ to: "/probes" }),
          },
          {
            key: "status-pages",
            label: "Status pages",
            icon: <StatusPagesIcon />,
            onClick: () => void navigate({ to: "/status-pages" }),
          },
          // Cloud-only, and with no local half at all: a quota reading is a
          // live credentialed provider call on a schedule only the poller
          // runs, and the trend needs history only the cloud stores.
          {
            key: "quotas",
            label: "Quotas",
            icon: <QuotasIcon />,
            onClick: () => void navigate({ to: "/quotas" }),
          },
          // Cloud-only for the same reason as Probes: an incident is
          // org-scoped and declaring one composes cloud features.
          {
            key: "incidents",
            label: "Incidents",
            icon: <IncidentsIcon />,
            onClick: () => void navigate({ to: "/incidents" }),
          },
          // Cloud-only: an ephemeral environment is created against org
          // accounts, recorded in org tables and torn down by the cloud lease
          // pass. There is no local half to render.
          {
            key: "environments",
            label: "Environments",
            icon: <EnvironmentsIcon />,
            onClick: () =>
              void navigateToWorkspaceTarget(navigate, environmentsTabTarget(), {
                label: "Environments",
              }),
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
    // Posture also has a local half — findings are computed from stored state
    // and the locally loaded plugins' posture declarations. A plain route,
    // same as Expiring.
    {
      key: "posture",
      label: "Posture",
      icon: <PostureIcon />,
      onClick: () => void navigate({ to: "/posture" }),
    },
    // Backups is cloud only — the coverage could be computed locally, but the
    // recovery objectives it is judged against are org state with nowhere to
    // live in a single-machine workspace. A workspace-tab kind so the strip
    // stays in sync with the active panel.
    {
      key: "backups",
      label: "Backups",
      icon: <BackupsIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, backupsTabTarget(), { label: "Backups" }),
    },
    // Domains also has a local half — the inventory is computed from stored
    // state and the locally loaded plugins' DNS declarations. A workspace-tab
    // kind (same as Logs), so the strip stays in sync with the active panel.
    {
      key: "dns",
      label: "Domains",
      icon: <DomainsIcon />,
      onClick: () => void navigateToWorkspaceTarget(navigate, dnsTabTarget(), { label: "Domains" }),
    },
    // Env diff also has a local half — local mode enumerates both accounts
    // through the plugin, since the local workspace has no synced store to
    // read. Workspace-tab kind so a/b selection survives restart.
    {
      key: "environment-diff",
      label: "Env diff",
      icon: <EnvironmentDiffIcon />,
      onClick: () =>
        void navigateToWorkspaceTarget(navigate, environmentDiffTabTarget(), { label: "Env diff" }),
    },
    // Fan-out SSH has a local half — local SSH accounts exec through the
    // machine's own ssh machinery — so, like Graph, it shows in both modes.
    // A plain route, same as web.
    {
      key: "ssh-fanout",
      label: "Fan-out",
      icon: <FanoutIcon />,
      onClick: () => void navigate({ to: "/ssh-fanout" }),
    },
    // Logs also has a local half — the in-renderer plugin clients fetch tails
    // directly — so like Graph the tile shows in both modes (saved queries
    // and alerting are the cloud-only part, hidden by the panel locally).
    {
      key: "logs",
      label: "Logs",
      icon: <LogsIcon />,
      onClick: () => void navigateToWorkspaceTarget(navigate, logsTabTarget(), { label: "Logs" }),
    },
  ];

  return (
    <div className="mb-2">
      <SidebarToolsButton tools={navTools} />

      {/* Section header */}
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-xs font-medium text-on-surface-muted uppercase tracking-wide">
          {gt("Dashboards")}
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
              {gt("Chat")}
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
                  className="opacity-0 group-hover:opacity-100 text-on-surface-faint hover:text-danger text-xs px-2 py-1.5 transition-opacity"
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
