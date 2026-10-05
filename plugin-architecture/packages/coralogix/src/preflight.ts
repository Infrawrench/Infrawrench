/**
 * Credential preflight for Coralogix.
 *
 * A Coralogix API key (personal or team, created under Settings, API Keys)
 * carries a set of permissions, usually attached as *presets* that Coralogix
 * keeps up to date (DataUsage, Alerts, TCOPolicies...). That is the
 * least-privilege story: every capability lists the presets and the exact
 * permission names behind it, taken from the `Requires the following
 * permissions` notes in the published OpenAPI document and the permissions
 * list (https://coralogix.com/docs/user-guides/aaa/access-control/permissions/permissions-list/,
 * 2026-10). The template is the list to tick when creating the key.
 *
 * Probes are three-way, as everywhere else: ok only on a 2xx, missing on a
 * 403, unknown on anything else. A 401 on every probe means the key is wrong
 * or belongs to another region, which no permission can fix.
 */

import type {
  PolicyTemplate,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightDeclaration,
  PreflightResult,
} from "@infrawrench/plugin-base";
import type { CoralogixContext } from "./api.js";
import { cxFetch, statusOf } from "./api.js";
import { nextDayIso } from "./usage.js";

interface CapabilityProbe {
  capability: PreflightCapability;
  /** Presets that grant the capability, for the template. */
  presets: string[];
  run: (ctx: CoralogixContext) => Promise<unknown>;
}

const perm = (id: string, label: string) => ({ id, label });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const PROBES: CapabilityProbe[] = [
  {
    capability: {
      id: "costs",
      label: "Data usage and cost",
      description:
        "Daily units and GB by pillar and TCO priority, priced into estimated cost, and the team's daily quota usage.",
      requiredPermissions: [
        perm("data-usage:Read", "View Data Usage Metrics"),
        perm("data-usage:Manage", "Enable and disable Data Usage Metrics"),
      ],
    },
    presets: ["DataUsage"],
    run: (ctx) =>
      cxFetch(ctx, "/dataplans/data-usage/v2/daily/units", {
        method: "POST",
        version: 4,
        body: { dateRange: { fromDate: `${today()}T00:00:00.000Z`, toDate: nextDayIso(today()) } },
      }),
  },
  {
    capability: {
      id: "alerts",
      label: "Alerts",
      description:
        "List alert definitions and their trigger history; edit, enable and disable them.",
      requiredPermissions: [
        perm("alerts:ReadConfig", "View alert settings"),
        perm("alerts:UpdateConfig", "Manage alert settings"),
      ],
    },
    presets: ["Alerts"],
    run: (ctx) => cxFetch(ctx, "/alerts/alerts/v3", { query: { "pagination.pageSize": 1 } }),
  },
  {
    capability: {
      id: "dashboards",
      label: "Dashboards",
      requiredPermissions: [
        perm("team-dashboards:Read", "View public Custom Dashboards"),
        perm("team-dashboards:Update", "Manage public Custom Dashboards"),
      ],
    },
    presets: ["Dashboards"],
    run: (ctx) => cxFetch(ctx, "/dashboards/dashboards/v1/catalog/list"),
  },
  {
    capability: {
      id: "tco",
      label: "TCO policies",
      description: "List TCO policies, change their priority and chart the volume they match.",
      requiredPermissions: [
        perm("logs.tco:ReadPolicies", "View log TCO policies"),
        perm("logs.tco:UpdatePolicies", "Manage log TCO policies"),
        perm("spans.tco:ReadPolicies", "View tracing TCO policies"),
        perm("spans.tco:UpdatePolicies", "Manage tracing TCO policies"),
      ],
    },
    presets: ["TCOPolicies"],
    run: (ctx) => cxFetch(ctx, "/dataplans/policies/v1"),
  },
  {
    capability: {
      id: "parsing",
      label: "Parsing rules",
      requiredPermissions: [
        perm("parsing-rules:ReadConfig", "View parsing rules"),
        perm("parsing-rules:UpdateConfig", "Manage parsing rules"),
      ],
    },
    presets: ["ParsingRules"],
    run: (ctx) => cxFetch(ctx, "/parsing-rules/rule-groups/v1"),
  },
  {
    capability: {
      id: "enrichments",
      label: "Enrichments",
      requiredPermissions: [
        perm("geo-enrichment:ReadConfig", "View Geo Enrichment"),
        perm("geo-enrichment:UpdateConfig", "Manage Geo Enrichment"),
        perm("security-enrichment:ReadConfig", "View threat intelligence enrichment"),
        perm("team-custom-enrichment:ReadConfig", "View Custom Enrichment"),
        perm("team-custom-enrichment:UpdateConfig", "Manage Custom Enrichment"),
        perm("cloud-metadata-enrichment:ReadConfig", "View AWS Enrichment"),
      ],
    },
    presets: ["Enrichments"],
    run: (ctx) => cxFetch(ctx, "/enrichment-rules/enrichment-rules/v1"),
  },
  {
    capability: {
      id: "webhooks",
      label: "Outbound webhooks",
      requiredPermissions: [
        perm("outbound-webhooks:ReadConfig", "View outbound webhooks"),
        perm("outbound-webhooks:UpdateConfig", "Manage outbound webhooks"),
      ],
    },
    presets: ["OutboundWebhooks"],
    run: (ctx) => cxFetch(ctx, "/integrations/webhooks/v1"),
  },
  {
    capability: {
      id: "quota",
      label: "Quota rules",
      description: "How the daily quota is shared between entity types, and editing it.",
      requiredPermissions: [
        perm("team-quota-rules:Read", "View team quota rules"),
        perm("team-quota-rules:Manage", "Manage team quota rules"),
      ],
    },
    presets: [],
    run: (ctx) => cxFetch(ctx, "/dataplan/quota-rules/v1"),
  },
  {
    capability: {
      id: "events2metrics",
      label: "Events2Metrics",
      requiredPermissions: [
        perm("logs.events2metrics:ReadConfig", "View Events2Metrics for logs"),
        perm("logs.events2metrics:UpdateConfig", "Manage Events2Metrics for logs"),
        perm("spans.events2metrics:ReadConfig", "View Events2Metrics for spans"),
      ],
    },
    presets: ["Events2Metrics"],
    run: (ctx) => cxFetch(ctx, "/events2metrics/events2metrics/v2"),
  },
];

export const CORALOGIX_PREFLIGHT: PreflightDeclaration = {
  capabilities: PROBES.map((p) => p.capability),
  templateFormat: { label: "API key presets and permissions", language: "text" },
};

const KEYS_HELP = {
  label: "Coralogix API keys",
  url: "https://coralogix.com/docs/user-guides/account-management/api-keys/api-keys/",
};

export async function verifyCoralogixCredentials(ctx: CoralogixContext): Promise<PreflightResult> {
  const results = await Promise.all(
    PROBES.map(async (probe) => {
      try {
        await probe.run(ctx);
        return { probe, status: 200 };
      } catch (err) {
        return { probe, status: statusOf(err), err };
      }
    }),
  );
  if (results.every((r) => r.status === 401)) {
    const message = `Coralogix rejected the API key in ${ctx.region.label}. Check the key, and that the account's region matches the address you sign in at (${ctx.region.teamHostSuffix}).`;
    return {
      checks: results.map((r) => ({
        capabilityId: r.probe.capability.id,
        status: "unknown",
        message,
      })),
    };
  }
  const checks = results.map(({ probe, status, err }): PreflightCapabilityCheck => {
    const capabilityId = probe.capability.id;
    if (status >= 200 && status < 300) return { capabilityId, status: "ok" };
    if (status === 403) {
      return {
        capabilityId,
        status: "missing",
        missingPermissions: probe.capability.requiredPermissions,
        message:
          probe.presets.length > 0
            ? `The API key lacks this. Attach the ${probe.presets.join(", ")} preset to the key.`
            : "The API key lacks these permissions. Add them to the key under Advanced.",
        helpLink: KEYS_HELP,
      };
    }
    return {
      capabilityId,
      status: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  });
  return { checks };
}

export function coralogixPolicyTemplate(capabilityIds: string[]): PolicyTemplate {
  const selected = PROBES.filter(
    (p) => capabilityIds.length === 0 || capabilityIds.includes(p.capability.id),
  );
  const presets = [...new Set(selected.flatMap((p) => p.presets))].sort();
  const permissions = [
    ...new Set(selected.flatMap((p) => p.capability.requiredPermissions.map((x) => x.id))),
  ].sort();
  const lines = [
    ...(presets.length > 0 ? ["# Presets", ...presets, ""] : []),
    "# Permissions (the presets above include these)",
    ...permissions,
  ];
  return {
    formatLabel: "API key presets and permissions",
    language: "text",
    document: lines.join("\n"),
    instructions:
      "In Coralogix, open Settings, then API Keys, and create a Team key (or a Personal key for testing). Pick the presets listed here under Role Presets. For anything without a preset, open Advanced and tick the permissions by name. Update, Manage and UpdateConfig are only needed for the matching actions.",
    helpLink: KEYS_HELP,
  };
}
