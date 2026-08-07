import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, resources, secretFieldStates } from "../db/schema";
import { loadPlugins, getPlugin } from "../plugins/loader";
import {
  getClientForAccount,
  getClientForResource,
  filterVisiblePeerIntegrations,
} from "../services/plugin-clients";
import { setLiteralSecretState } from "@infrawrench/server-core/secret-states";
import { getOrgStatusIncidents } from "@infrawrench/server-core/status/match";
import { listExpiring } from "@infrawrench/server-core/expiry/feed";
import { listPosture } from "@infrawrench/server-core/posture/feed";
import {
  dismissPostureFinding,
  restorePostureFinding,
} from "@infrawrench/server-core/posture/dismissals";
import { upsertCreatedResource } from "@infrawrench/server-core/created-resource";
import { resolveStoredSshPublicKey } from "./ssh-key-lookup";
import { logAudit } from "../services/audit";
import {
  checkChangeFreezeForTool,
  getActiveChangeFreeze,
  isActionDestructive,
} from "../services/change-freezes";
import {
  evaluatePeerIntegrationUnreachable,
  normalizeResourceCreateResult,
} from "@infrawrench/plugin-base";
import { ok, okText, err, type ToolDefinition } from "./types";

const parentResourceIdField = z
  .string()
  .optional()
  .describe(
    "For sidecar (peer plugin) targets only: the id of the parent resource (managed cluster / " +
      "database) whose outputs provide the sidecar's credentials. See list_resource_sidecars.",
  );

const resourceTargetSchema = {
  pluginId: z.string(),
  accountId: z.string(),
  resourceTypeId: z.string(),
  resourceId: z.string(),
  parentResourceId: parentResourceIdField,
};

export function genericTools(): ToolDefinition[] {
  return [
    {
      name: "list_plugins",
      title: "List plugins",
      description:
        "List all installed Infrawrench plugins (cloud providers, databases, etc.) and their credential field schemas.",
      inputSchema: {},
      risk: "read",
      permission: null,
      handler: async () => {
        const plugins = await loadPlugins();
        return ok(
          plugins.map((p) => ({
            id: p.plugin.manifest.id,
            displayName: p.plugin.manifest.displayName,
            description: p.plugin.manifest.description,
            credentialFields: p.plugin.manifest.credentialFields.map((f) => ({
              key: f.key,
              label: f.label,
              sensitive: f.sensitive,
            })),
          })),
        );
      },
    },

    {
      name: "list_resource_types",
      title: "List resource types",
      description:
        "List the resource types defined by a plugin, including their fields, outputs, and capability flags (supportsCreate, supportsDelete, supportsMetrics).",
      inputSchema: {
        pluginId: z.string().describe("Plugin id, e.g. 'digitalocean', 'postgres'"),
      },
      risk: "read",
      permission: null,
      handler: async (input) => {
        const pluginId = input["pluginId"] as string;
        const loaded = await getPlugin(pluginId);
        if (!loaded) return err(`Plugin not found: ${pluginId}`);
        return ok(
          loaded.plugin.resourceTypes.map((t) => ({
            id: t.id,
            displayName: t.displayName,
            pluralDisplayName: t.pluralDisplayName,
            description: t.description,
            parentTypeId: t.parentTypeId ?? null,
            supportsCreate: !!t.supportsCreate,
            supportsDelete: t.supportsDelete !== false,
            supportsMetrics: !!t.supportsMetrics,
            fields: t.fields.map((f) => ({
              key: f.key,
              label: f.label,
              kind: f.kind,
              required: f.required,
              description: f.description,
              enumValues: f.enumValues,
            })),
            outputs: t.outputs.map((o) => ({
              key: o.key,
              label: o.label,
              sensitive: o.sensitive,
              description: o.description,
            })),
          })),
        );
      },
    },

    {
      name: "list_accounts",
      title: "List accounts",
      description: "List all connected accounts (credential sets) in the caller's organization.",
      inputSchema: {},
      risk: "read",
      permission: "accounts:read",
      handler: async (_input, auth) => {
        const rows = await db
          .select({
            id: accounts.id,
            pluginId: accounts.pluginId,
            displayName: accounts.displayName,
            createdAt: accounts.createdAt,
          })
          .from(accounts)
          .where(and(eq(accounts.organizationId, auth.organizationId), isNull(accounts.deletedAt)));
        return ok(rows);
      },
    },

    {
      name: "list_provider_incidents",
      title: "List provider incidents affecting you",
      description:
        "Provider status-page incidents overlapping the organization's resources — \"is it me " +
        "or is it them?\". The poller watches each provider plugin's public status feed and " +
        "this correlates active incidents (plus those resolved in the last 24h) against the " +
        "resources the org holds, by region, resource type, or provider-wide scope. Each " +
        "incident includes how many of your resources it overlaps and how many change-timeline " +
        "events were recorded during its window. Check this before debugging a sudden failure " +
        "or unexplained drift.",
      inputSchema: {},
      risk: "read",
      // Mirrors `GET /status-incidents` — correlation reads the org's resource set.
      permission: "resources:read",
      handler: async (_input, auth) => {
        return ok(await getOrgStatusIncidents(auth.organizationId));
      },
    },

    {
      name: "list_expiring",
      title: "List expiring resources",
      description:
        "The expiry radar: every deadline plugins declared on the organization's synced " +
        "resources — TLS certificate expiries, domain registrations, API token expirations, " +
        "access keys past their rotation budget, kubeconfig/SSH key ages — soonest first, " +
        "bucketed by severity against the org's lead time (expired, critical <7d, warning " +
        "<30d, upcoming within lead, ok beyond it). Purely a read over already-synced state; " +
        "no provider API calls. Check this before certificates lapse or tokens rotate out.",
      inputSchema: {
        severity: z
          .enum(["expired", "critical", "warning", "upcoming", "ok"])
          .optional()
          .describe("Only return deadlines in this severity bucket."),
        kind: z
          .enum([
            "tls-cert",
            "domain",
            "api-token",
            "access-key",
            "k8s-cert",
            "ssh-key",
            "secret-version",
            "other",
          ])
          .optional()
          .describe("Only return deadlines of this kind."),
      },
      risk: "read",
      // Mirrors `GET /expiring` — the feed is computed over the org's resource set.
      permission: "resources:read",
      handler: async (input, auth) => {
        const severity = input["severity"] as string | undefined;
        const kind = input["kind"] as string | undefined;
        const feed = await listExpiring(auth.organizationId);
        const items = feed.items.filter(
          (i) => (!severity || i.severity === severity) && (!kind || i.kind === kind),
        );
        // Counts always describe the whole feed so a filtered view still shows
        // what else is on the radar. matchedCount is the filtered length.
        return ok({
          items,
          matchedCount: items.length,
          totalCount: feed.items.length,
          counts: feed.counts,
          leadDays: feed.leadDays,
          generatedAt: feed.generatedAt,
        });
      },
    },

    {
      name: "list_posture_findings",
      title: "List security posture findings",
      description:
        "Plugin-declared security checks evaluated over the organization's synced resources — " +
        "public buckets, security groups and firewall rules open to 0.0.0.0/0, unencrypted " +
        "disks and databases, publicly reachable database endpoints, stale credentials, " +
        "missing backup/deletion protection — ranked by severity (critical, high, medium, " +
        "low). Purely a read over already-synced state; no provider API calls. Check this " +
        "when auditing an account's exposure or before opening something to the internet. " +
        "Findings the organization has dismissed as accepted risks are excluded unless you " +
        "ask for them.",
      inputSchema: {
        severity: z
          .enum(["critical", "high", "medium", "low"])
          .optional()
          .describe("Only return findings of this severity."),
        category: z
          .enum(["public-exposure", "encryption", "credential-age", "data-protection", "other"])
          .optional()
          .describe("Only return findings in this category."),
        includeDismissed: z
          .boolean()
          .optional()
          .describe(
            "Also return the findings the organization has dismissed, each with who accepted " +
              "it, when, and why. They stay out of `findings` either way.",
          ),
      },
      risk: "read",
      // Mirrors `GET /posture` — the findings are computed over the org's resource set.
      permission: "resources:read",
      handler: async (input, auth) => {
        const severity = input["severity"] as string | undefined;
        const category = input["category"] as string | undefined;
        const includeDismissed = input["includeDismissed"] === true;
        const feed = await listPosture(auth.organizationId);
        const matches = (f: { severity: string; category: string }) =>
          (!severity || f.severity === severity) && (!category || f.category === category);
        const findings = feed.findings.filter(matches);
        // Counts always describe the whole feed so a filtered view still shows
        // the overall picture. matchedCount is the filtered length.
        return ok({
          findings,
          matchedCount: findings.length,
          totalCount: feed.findings.length,
          counts: feed.counts,
          // Always reported as a number so a reader can tell "clean" from
          // "quiet because somebody silenced it"; the rows are opt-in.
          dismissedCount: feed.dismissedCount,
          ...(includeDismissed ? { dismissed: feed.dismissed.filter(matches) } : {}),
          generatedAt: feed.generatedAt,
        });
      },
    },

    {
      name: "dismiss_posture_finding",
      title: "Dismiss a posture finding",
      description:
        "Accept a security finding as a known, intentional risk: it leaves the posture list " +
        "and stops feeding the daily posture alerts. Use only when the user has said the " +
        "exposure is deliberate — this silences a security warning. The rule keeps being " +
        "evaluated and the dismissal is reversible with restore_posture_finding, so nothing " +
        "is destroyed. Identify the finding by the resourceId and ruleId that " +
        "list_posture_findings returns.",
      inputSchema: {
        resourceId: z.string().describe("Infrawrench resource id the finding is on."),
        ruleId: z.string().describe("The matched rule's id, as returned on the finding."),
        reason: z
          .string()
          .max(500)
          .optional()
          .describe("Why this exposure is acceptable — recorded with the dismissal."),
      },
      risk: "write",
      // Mirrors `POST /posture/dismissals`: a statement about one resource,
      // the same trust level as changing it.
      permission: "resources:write",
      handler: async (input, auth) => {
        const dismissal = await dismissPostureFinding(auth.organizationId, {
          resourceId: input["resourceId"] as string,
          ruleId: input["ruleId"] as string,
          reason: (input["reason"] as string | undefined) ?? null,
          userId: auth.userId,
        });
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "posture.finding.dismissed",
          entityType: "resource",
          entityId: dismissal.resourceId,
          metadata: { ruleId: dismissal.ruleId, reason: dismissal.reason, source: auth.source },
        });
        return ok({ dismissed: dismissal });
      },
    },

    {
      name: "restore_posture_finding",
      title: "Restore a dismissed posture finding",
      description:
        "Undo a dismissal — the finding returns to the posture list and to the daily alerts. " +
        "Use when an accepted risk is no longer acceptable, or when a finding was dismissed " +
        "by mistake.",
      inputSchema: {
        resourceId: z.string().describe("Infrawrench resource id the finding is on."),
        ruleId: z.string().describe("The matched rule's id."),
      },
      risk: "write",
      permission: "resources:write",
      handler: async (input, auth) => {
        const resourceId = input["resourceId"] as string;
        const ruleId = input["ruleId"] as string;
        const restored = await restorePostureFinding(auth.organizationId, resourceId, ruleId);
        if (!restored) return err("That finding is not dismissed.");
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "posture.finding.restored",
          entityType: "resource",
          entityId: resourceId,
          metadata: { ruleId, source: auth.source },
        });
        return ok({ restored: { resourceId, ruleId } });
      },
    },

    {
      name: "search_resources",
      title: "Search resources",
      description:
        "Substring-match resources across every connected account. Matches against resource display name, account name, plugin name, and resource-type label. Returns up to 50 results.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Substring to match. Leave empty to list everything (capped at 50)."),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const orgId = auth.organizationId;
        const q = ((input["query"] as string | undefined) ?? "").toLowerCase().trim();

        const allResources = await db
          .select({
            id: resources.id,
            pluginId: resources.pluginId,
            resourceTypeId: resources.resourceTypeId,
            accountId: resources.accountId,
            displayName: resources.displayName,
          })
          .from(resources)
          .where(and(eq(resources.organizationId, orgId), isNull(resources.deletedAt)));

        const allAccounts = await db
          .select({
            id: accounts.id,
            displayName: accounts.displayName,
            pluginId: accounts.pluginId,
          })
          .from(accounts)
          .where(and(eq(accounts.organizationId, orgId), isNull(accounts.deletedAt)));
        const accountMap = new Map(allAccounts.map((a) => [a.id, a]));

        const pluginCache = new Map<
          string,
          { displayName: string; resourceTypes: Map<string, string> }
        >();

        const results: Array<{
          id: string;
          pluginId: string;
          pluginDisplayName: string;
          resourceTypeId: string;
          resourceTypeLabel: string;
          accountId: string;
          accountName: string;
          displayName: string;
        }> = [];
        for (const r of allResources) {
          let meta = pluginCache.get(r.pluginId);
          if (!meta) {
            const loaded = await getPlugin(r.pluginId);
            if (loaded) {
              meta = {
                displayName: loaded.plugin.manifest.displayName,
                resourceTypes: new Map(
                  loaded.plugin.resourceTypes.map((rt) => [rt.id, rt.displayName]),
                ),
              };
            } else {
              meta = { displayName: r.pluginId, resourceTypes: new Map() };
            }
            pluginCache.set(r.pluginId, meta);
          }
          const account = accountMap.get(r.accountId);
          const accountName = account?.displayName ?? "";
          const resourceTypeLabel = meta.resourceTypes.get(r.resourceTypeId) ?? r.resourceTypeId;

          if (q) {
            const hay =
              `${r.displayName} ${accountName} ${meta.displayName} ${resourceTypeLabel}`.toLowerCase();
            if (!hay.includes(q)) continue;
          }

          results.push({
            id: r.id,
            pluginId: r.pluginId,
            pluginDisplayName: meta.displayName,
            resourceTypeId: r.resourceTypeId,
            resourceTypeLabel,
            accountId: r.accountId,
            accountName,
            displayName: r.displayName,
          });

          if (results.length >= 50) break;
        }
        return ok(results);
      },
    },

    {
      name: "list_resource_sidecars",
      title: "List resource sidecars",
      description:
        "Discover the sidecar (peer plugin) integrations a resource exposes. Managed Kubernetes " +
        "clusters (DOKS, EKS, GKE, AKS, Kapsule, …) expose the 'kubernetes' plugin via their " +
        "kubeconfig; managed databases expose 'postgres' / 'mysql' / 'redis' / 'mongodb' via " +
        "their connection string. Returns each sidecar's pluginId and resource types. To operate " +
        'inside a sidecar ("what is running in my cluster?"), call list_resources / ' +
        "get_resource / describe_resource / invoke_action with pluginId = the sidecar's " +
        "pluginId, the same accountId, and parentResourceId = this resource's id.",
      inputSchema: {
        accountId: z.string(),
        resourceId: z.string().describe("The parent resource id (the cluster / database)"),
        resourceTypeId: z
          .string()
          .optional()
          .describe("The parent's resource type id, if known — skips a lookup"),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const { accountId, resourceId } = input as { accountId: string; resourceId: string };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");

        // Resolve the parent's resource type: explicit input → synced row →
        // live probe across the plugin's peer-declaring types.
        let resourceTypeId = input["resourceTypeId"] as string | undefined;
        let storedFields: Record<string, unknown> | undefined;
        if (!resourceTypeId) {
          const [row] = await db
            .select({ resourceTypeId: resources.resourceTypeId, fieldsJson: resources.fieldsJson })
            .from(resources)
            .where(
              and(
                eq(resources.id, resourceId),
                eq(resources.organizationId, auth.organizationId),
                isNull(resources.deletedAt),
              ),
            )
            .limit(1);
          resourceTypeId = row?.resourceTypeId;
          storedFields = (row?.fieldsJson as Record<string, unknown> | null) ?? undefined;
        }

        let inst: Awaited<ReturnType<typeof ctx.client.getResource>> | null = null;
        if (resourceTypeId) {
          inst = await ctx.client
            .getResource(resourceTypeId, resourceId, accountId)
            .catch(() => null);
        } else {
          for (const typeDef of ctx.plugin.resourceTypes) {
            if (!typeDef.peerIntegrations?.length) continue;
            inst = await ctx.client
              .getResource(typeDef.id, resourceId, accountId)
              .catch(() => null);
            if (inst) {
              resourceTypeId = typeDef.id;
              break;
            }
          }
        }
        if (!resourceTypeId) {
          return err(
            "Could not resolve the resource's type — pass resourceTypeId explicitly (see list_resources / search_resources)",
          );
        }
        const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
        if (!typeDef) return err(`Unknown resource type: ${resourceTypeId}`);

        const integrations = typeDef.peerIntegrations ?? [];
        if (integrations.length === 0) {
          return ok({
            resourceId,
            resourceTypeId,
            sidecars: [],
            note: `Resource type ${resourceTypeId} declares no sidecar integrations.`,
          });
        }

        const fields = inst?.fields ?? storedFields;
        const visible = filterVisiblePeerIntegrations(integrations, fields);
        const sidecars = await Promise.all(
          visible.map(async (integration) => {
            const unreachable = evaluatePeerIntegrationUnreachable(integration, fields);
            const peer = await getPlugin(integration.pluginId);
            return {
              pluginId: integration.pluginId,
              pluginDisplayName: peer?.plugin.manifest.displayName ?? integration.pluginId,
              tabLabel: integration.tabLabel,
              ...(unreachable ? { unreachable } : {}),
              resourceTypes:
                peer?.plugin.resourceTypes.map((rt) => ({
                  id: rt.id,
                  displayName: rt.displayName,
                  supportsCreate: !!rt.supportsCreate,
                })) ?? [],
            };
          }),
        );

        return ok({
          resourceId,
          resourceTypeId,
          sidecars,
          usage:
            "Call list_resources { pluginId: <sidecar pluginId>, accountId, resourceTypeId: " +
            `<sidecar resource type>, parentResourceId: "${resourceId}" }. The same ` +
            "parentResourceId pattern works for get_resource, describe_resource, invoke_action, " +
            "apply_manifest, and the per-plugin create tools.",
        });
      },
    },

    {
      name: "list_resources",
      title: "List resources",
      description:
        "List live resources of a given type for an account. Also works inside sidecars: to see " +
        "what's running in a managed Kubernetes cluster (DOKS, EKS, GKE, …), pass pluginId " +
        "'kubernetes', the cluster's accountId, a kubernetes resourceTypeId (e.g. " +
        "'k8s-deployment', 'k8s-pod' — see list_resource_types), and parentResourceId = the " +
        "cluster's resource id. Same pattern for managed databases (postgres/mysql/redis/mongodb).",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        parentResourceId: parentResourceIdField,
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        const list = await ctx.client.listResources(resourceTypeId, accountId);
        return ok(
          list.map((r) => ({
            id: r.id,
            displayName: r.displayName,
            resourceTypeId: r.resourceTypeId,
            pluginId: r.pluginId,
            accountId: r.accountId,
            externalId: r.externalId,
            fields: r.fields,
          })),
        );
      },
    },

    {
      name: "get_resource",
      title: "Get resource",
      description:
        "Fetch a single resource's full state: non-secret fields and resolved outputs. Use get_resource_outputs to fetch sensitive outputs explicitly.",
      inputSchema: resourceTargetSchema,
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        try {
          const inst = await ctx.client.getResource(resourceTypeId, resourceId, accountId);
          return ok({
            id: inst.id,
            displayName: inst.displayName,
            resourceTypeId: inst.resourceTypeId,
            pluginId: inst.pluginId,
            accountId: inst.accountId,
            externalId: inst.externalId,
            parentResourceId: inst.parentResourceId,
            fields: inst.fields,
            resolvedOutputs: inst.resolvedOutputs,
            createdAt: inst.createdAt,
            updatedAt: inst.updatedAt,
          });
        } catch (e) {
          return err(e instanceof Error ? e.message : "Failed to fetch resource");
        }
      },
    },

    {
      name: "get_resource_outputs",
      title: "Get resource outputs",
      description:
        "Resolve a list of output keys for a resource (e.g. connectionString, ipv4). Outputs marked sensitive are returned in plaintext — handle with care.",
      inputSchema: {
        ...resourceTargetSchema,
        outputKeys: z
          .array(z.string())
          .optional()
          .describe("Output keys to resolve. Defaults to every output declared on the type."),
      },
      risk: "read",
      permission: "secrets:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId, outputKeys } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            parentResourceId?: string;
            outputKeys?: string[];
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
        if (!typeDef) return err(`Resource type not found: ${resourceTypeId}`);
        const keys = outputKeys ?? typeDef.outputs.map((o) => o.key);
        const out: Record<string, string | { error: string }> = {};
        for (const key of keys) {
          try {
            out[key] = await ctx.client.resolveOutput(resourceTypeId, resourceId, key, accountId);
          } catch (e) {
            out[key] = { error: e instanceof Error ? e.message : "resolveOutput failed" };
          }
        }
        return ok(out);
      },
    },

    {
      name: "get_resource_inputs",
      title: "Get resource inputs",
      description:
        "Return the resource's user-supplied inputs: non-secret fields plus the secret-field bindings (literal vs output-ref) — secret values are NOT included.",
      inputSchema: {
        resourceId: z.string(),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const resourceId = input["resourceId"] as string;
        const [row] = await db
          .select()
          .from(resources)
          .where(
            and(
              eq(resources.id, resourceId),
              eq(resources.organizationId, auth.organizationId),
              isNull(resources.deletedAt),
            ),
          )
          .limit(1);
        if (!row) return err("Resource not found");

        const secretRows = await db
          .select({
            fieldKey: secretFieldStates.fieldKey,
            resolutionKind: secretFieldStates.resolutionKind,
            sourcePluginId: secretFieldStates.sourcePluginId,
            sourceResourceTypeId: secretFieldStates.sourceResourceTypeId,
            sourceResourceId: secretFieldStates.sourceResourceId,
            sourceAccountId: secretFieldStates.sourceAccountId,
            sourceOutputKey: secretFieldStates.sourceOutputKey,
          })
          .from(secretFieldStates)
          .where(eq(secretFieldStates.resourceId, resourceId));

        return ok({
          id: row.id,
          displayName: row.displayName,
          pluginId: row.pluginId,
          resourceTypeId: row.resourceTypeId,
          accountId: row.accountId,
          fields: row.fieldsJson ?? {},
          secretBindings: secretRows.map((s) => ({
            fieldKey: s.fieldKey,
            kind: s.resolutionKind,
            ...(s.resolutionKind === "output-ref" && {
              sourcePluginId: s.sourcePluginId,
              sourceResourceTypeId: s.sourceResourceTypeId,
              sourceResourceId: s.sourceResourceId,
              sourceAccountId: s.sourceAccountId,
              sourceOutputKey: s.sourceOutputKey,
            }),
          })),
        });
      },
    },

    {
      name: "get_resource_stats",
      title: "Get resource stats",
      description: "Fetch dashboard-style key/value stats for a resource (when supported).",
      inputSchema: resourceTargetSchema,
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.fetchDashboardStats) return err("Plugin does not support dashboard stats");
        try {
          const stats = await ctx.client.fetchDashboardStats(resourceTypeId, resourceId, accountId);
          return ok(stats);
        } catch (e) {
          return err(e instanceof Error ? e.message : "Failed to fetch stats");
        }
      },
    },

    {
      name: "get_resource_metrics",
      title: "Get resource metrics",
      description:
        "Fetch time-series metrics (CPU, memory, request rate, etc.) for a resource. Provide startMs/endMs to scope the range; otherwise the plugin picks a default window.",
      inputSchema: {
        ...resourceTargetSchema,
        startMs: z.number().int().optional(),
        endMs: z.number().int().optional(),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const {
          pluginId,
          accountId,
          resourceTypeId,
          resourceId,
          parentResourceId,
          startMs,
          endMs,
        } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
          startMs?: number;
          endMs?: number;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.fetchMetricSeries) return err("Plugin does not support metrics");
        const range = startMs != null && endMs != null ? { startMs, endMs } : undefined;
        try {
          const series = await ctx.client.fetchMetricSeries(
            resourceTypeId,
            resourceId,
            accountId,
            range,
          );
          return ok({ series });
        } catch (e) {
          return err(e instanceof Error ? e.message : "Failed to fetch metrics");
        }
      },
    },

    {
      name: "describe_resource",
      title: "Describe resource",
      description:
        "Plain-text describe summary for a resource (status, events, related objects), kubectl-describe style. Only available for plugins that implement it.",
      inputSchema: resourceTargetSchema,
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.describeResource) return err("Plugin does not support describe");
        const text = await ctx.client.describeResource(resourceTypeId, resourceId, accountId);
        return okText(text);
      },
    },

    {
      name: "create_resource",
      title: "Create resource",
      description:
        "Generic resource creation. Use list_resource_types to see required `fields` for a given (pluginId, resourceTypeId). Audit-logged.",
      inputSchema: {
        pluginId: z.string(),
        accountId: z.string(),
        resourceTypeId: z.string(),
        fields: z
          .record(z.string(), z.string())
          .describe("Form-style key/value pairs matching the type's field definitions."),
        parentResourceId: parentResourceIdField,
        sshKeyId: z
          .string()
          .optional()
          .describe(
            "Stored org SSH key id (see list_ssh_keys) to install for SSH access. Only for " +
              "resource types that accept an SSH key at create time (VM types) — its public " +
              "key is injected into the type's SSH-key field.",
          ),
      },
      risk: "write",
      permission: "resources:write",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, parentResourceId, sshKeyId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          fields: Record<string, string>;
          parentResourceId?: string;
          sshKeyId?: string;
        };
        let fields = (input["fields"] as Record<string, string> | undefined) ?? {};
        const orgId = auth.organizationId;
        const ctx = await getClientForResource(pluginId, accountId, orgId, parentResourceId);
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.createResource) return err("Plugin does not support creation");

        if (sshKeyId) {
          const typeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
          const sshKeyFieldKey = typeDef?.agentVm?.sshKeyFieldKey;
          if (!sshKeyFieldKey) {
            return err(`Resource type ${resourceTypeId} does not accept an SSH key at create time`);
          }
          if (fields[sshKeyFieldKey]) {
            return err(`Pass either sshKeyId or fields.${sshKeyFieldKey}, not both`);
          }
          const publicKey = await resolveStoredSshPublicKey(orgId, sshKeyId);
          if (!publicKey) return err("SSH key not found (see list_ssh_keys)");
          fields = { ...fields, [sshKeyFieldKey]: publicKey };
        }

        let createReturn;
        try {
          createReturn = await ctx.client.createResource(
            resourceTypeId,
            accountId,
            fields,
            parentResourceId,
          );
        } catch (e) {
          return err(e instanceof Error ? e.message : "Resource creation failed");
        }

        const { resource: created, warnings } = normalizeResourceCreateResult(createReturn);

        if (ctx.account.pluginId === pluginId) {
          try {
            await upsertCreatedResource({
              organizationId: orgId,
              pluginId,
              resourceTypeId,
              accountId,
              resource: created,
            });
            for (const state of created.secretStates ?? []) {
              if (state.resolution.kind !== "plaintext") continue;
              await setLiteralSecretState(created.id, state.fieldKey, state.resolution.value);
            }
          } catch (persistErr) {
            console.error("[tools/generic] Failed to persist resource:", persistErr);
          }
        }

        void logAudit({
          organizationId: orgId,
          userId: auth.userId,
          action: "resource.create",
          entityType: "resource",
          entityId: created.id,
          metadata: {
            pluginId,
            resourceTypeId,
            source: auth.source,
            ...(sshKeyId ? { sshKeyId } : {}),
          },
        });

        return ok({ id: created.id, displayName: created.displayName, warnings });
      },
    },

    {
      name: "delete_resource",
      title: "Delete resource",
      description:
        "Permanently delete a resource. Audit-logged. The chat surface confirms with the user before invoking.",
      inputSchema: resourceTargetSchema,
      risk: "destructive",
      permission: "resources:delete",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceTypeId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.deleteResource) return err("Plugin does not support deletion");
        const frozen = await checkChangeFreezeForTool(auth.organizationId, auth.userId, {
          action: "resource.delete",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, source: auth.source },
        });
        if (frozen) return err(frozen);
        try {
          await ctx.client.deleteResource(resourceTypeId, resourceId, accountId);
        } catch (e) {
          return err(e instanceof Error ? e.message : "Deletion failed");
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "resource.delete",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, source: auth.source },
        });
        return ok({ ok: true });
      },
    },

    {
      name: "invoke_action",
      title: "Invoke resource action",
      description:
        "Run a plugin-defined action against a resource (start/stop/restart/etc.). actionId is plugin-specific — discover via the resource's detail schema.",
      inputSchema: {
        ...resourceTargetSchema,
        actionId: z.string(),
      },
      risk: "destructive",
      permission: "resources:write",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId, actionId } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            parentResourceId?: string;
            actionId: string;
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.invokeAction) return err("Plugin does not support actions");
        // Freeze gate — only actions the plugin flags `destructive: true` in
        // its detail schema are blocked; the schema walk only runs while a
        // freeze is in effect.
        if (
          (await getActiveChangeFreeze(auth.organizationId)) &&
          (await isActionDestructive(ctx.client, resourceTypeId, resourceId, accountId, actionId))
        ) {
          const frozen = await checkChangeFreezeForTool(auth.organizationId, auth.userId, {
            action: "resource.invoke_action",
            entityType: "resource",
            entityId: resourceId,
            metadata: { pluginId, resourceTypeId, actionId, source: auth.source },
          });
          if (frozen) return err(frozen);
        }
        try {
          await ctx.client.invokeAction(resourceTypeId, resourceId, actionId, accountId);
        } catch (e) {
          return err(e instanceof Error ? e.message : "Action failed");
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "resource.invoke_action",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, actionId, source: auth.source },
        });
        return ok({ ok: true });
      },
    },

    {
      name: "get_manifest",
      title: "Get resource manifest",
      description:
        "Read the full manifest (YAML/JSON) for a resource. Edits go through apply_manifest.",
      inputSchema: resourceTargetSchema,
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceId, parentResourceId } = input as {
          pluginId: string;
          accountId: string;
          resourceId: string;
          parentResourceId?: string;
        };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.getManifest) return err("Plugin does not support manifest viewing");
        const manifest = await ctx.client.getManifest(resourceId, accountId);
        return okText(manifest);
      },
    },

    {
      name: "apply_manifest",
      title: "Apply resource manifest",
      description:
        "Apply an updated manifest (YAML/JSON) to a resource — primary edit path for k8s, postgres, and similar plugins. Audit-logged.",
      inputSchema: {
        ...resourceTargetSchema,
        manifest: z.string(),
      },
      risk: "destructive",
      permission: "resources:write",
      handler: async (input, auth) => {
        const { pluginId, accountId, resourceTypeId, resourceId, parentResourceId, manifest } =
          input as {
            pluginId: string;
            accountId: string;
            resourceTypeId: string;
            resourceId: string;
            parentResourceId?: string;
            manifest: string;
          };
        const ctx = await getClientForResource(
          pluginId,
          accountId,
          auth.organizationId,
          parentResourceId,
        );
        if (!ctx) return err("Account or peer resource not found");
        if (!ctx.client.applyManifest) return err("Plugin does not support manifest editing");
        try {
          await ctx.client.applyManifest(resourceId, accountId, manifest);
        } catch (e) {
          return err(e instanceof Error ? e.message : "applyManifest failed");
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "resource.apply_manifest",
          entityType: "resource",
          entityId: resourceId,
          metadata: { pluginId, resourceTypeId, source: auth.source },
        });
        return ok({ ok: true });
      },
    },

    {
      name: "attach_resource",
      title: "Attach resource",
      description:
        "Attach a source resource to a target resource (e.g. disk → VM). Both must be in the same account. Plugin-specific semantics; see resource type's attachTargets.",
      inputSchema: {
        sourceTypeId: z.string(),
        sourceResourceId: z.string(),
        targetTypeId: z.string(),
        targetResourceId: z.string(),
        accountId: z.string(),
        pluginId: z.string(),
      },
      risk: "destructive",
      permission: "resources:write",
      handler: async (input, auth) => {
        const {
          pluginId,
          accountId,
          sourceTypeId,
          sourceResourceId,
          targetTypeId,
          targetResourceId,
        } = input as {
          pluginId: string;
          accountId: string;
          sourceTypeId: string;
          sourceResourceId: string;
          targetTypeId: string;
          targetResourceId: string;
        };
        const ctx = await getClientForAccount(accountId, auth.organizationId);
        if (!ctx) return err("Account not found");
        if (ctx.account.pluginId !== pluginId) return err("Account/plugin mismatch");
        if (!ctx.client.attachResource) return err("Plugin does not support attach");
        try {
          await ctx.client.attachResource(
            sourceTypeId,
            sourceResourceId,
            targetTypeId,
            targetResourceId,
            accountId,
          );
        } catch (e) {
          return err(e instanceof Error ? e.message : "attach failed");
        }
        void logAudit({
          organizationId: auth.organizationId,
          userId: auth.userId,
          action: "resource.attach",
          entityType: "resource",
          entityId: targetResourceId,
          metadata: {
            pluginId,
            sourceTypeId,
            sourceResourceId,
            targetTypeId,
            source: auth.source,
          },
        });
        return ok({ ok: true });
      },
    },
  ];
}
