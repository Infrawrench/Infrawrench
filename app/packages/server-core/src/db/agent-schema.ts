import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { accounts, organizations } from "./core-schema.js";

export const agentSettings = pgTable("agent_settings", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id").notNull(),
  resourceTypeId: text("resource_type_id").notNull(),
  tool: text("tool").notNull().default("codex"),
  // How the session is driven: "terminal" (the tool's CLI in an SSH tab) or
  // "t3-code" (the T3 Code server drives the tool, and is used from T3
  // Code's own client). Orthogonal to `tool` — T3 Code is a control
  // surface, not an agent, so a t3-code session still installs codex/claude.
  surface: text("surface").notNull().default("terminal"),
  fieldsJson: jsonb("fields_json").$type<Record<string, string>>().notNull().default({}),
  // Accounts whose plugin installs a service on the VM over SSH after setup
  // (`sshInstall` plugins, e.g. Tailscale). Not FKs: a deleted account just
  // stops being offered, it doesn't take the defaults row with it.
  serviceAccountIds: jsonb("service_account_ids").$type<string[]>().notNull().default([]),
  // T3 Code only: "t3-connect" (hosted relay) or "tailscale" (Tailscale
  // Serve on the tailnet; needs a Tailscale service account attached).
  t3Access: text("t3_access").notNull().default("t3-connect"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    projectName: text("project_name").notNull(),
    workspaceName: text("workspace_name").notNull(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    resourceTypeId: text("resource_type_id").notNull(),
    tool: text("tool").notNull().default("codex"),
    /** See `agentSettings.surface`. */
    surface: text("surface").notNull().default("terminal"),
    /** See `agentSettings.serviceAccountIds`. */
    serviceAccountIds: jsonb("service_account_ids").$type<string[]>().notNull().default([]),
    /** See `agentSettings.t3Access`. */
    t3Access: text("t3_access").notNull().default("t3-connect"),
    // What each attached service's plugin reported after installing on the
    // VM, including its opaque `ref` (e.g. a tailnet device id) so deleting
    // the session can undo it. `ref` never leaves the server.
    serviceInstallsJson: jsonb("service_installs_json")
      .$type<
        Array<{
          accountId: string;
          pluginId: string;
          message: string;
          address?: string;
          ref?: string;
        }>
      >()
      .notNull()
      .default([]),
    branchName: text("branch_name").notNull(),
    status: text("status").notNull().default("pending"),
    vmResourceId: text("vm_resource_id"),
    logs: jsonb("logs").$type<string[]>().notNull().default([]),
    // Serialized AgentSetupPlan (text to mirror the desktop app's local
    // schema); consumed by the server-side VM setup pipeline.
    setupPlanJson: text("setup_plan_json").notNull().default("{}"),
    // Cross-replica lease for the VM setup pipeline. The web deployment runs
    // two replicas and the in-process in-flight map only guards one heap, so
    // without this both pods run setup for the same session against the same
    // VM. Same lease protocol the poller uses for accounts (claim.ts): a
    // conditional UPDATE hands the row to exactly one claimer, and an
    // expired lease makes it claimable again if a pod dies mid-setup.
    // NULL means "not being set up".
    setupLeaseUntil: timestamp("setup_lease_until"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("agent_sessions_org_idx").on(t.organizationId),
    statusIdx: index("agent_sessions_status_idx").on(t.status),
  }),
);
