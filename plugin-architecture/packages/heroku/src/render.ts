import type {
  ActionNode,
  CreateFieldConfig,
  DetailViewSchema,
  ResourceInstance,
  ResourceStatus,
  ResourceTypeDefinition,
  SectionNode,
  SidebarItemSchema,
  TableColumn,
} from "@infrawrench/plugin-base";
import {
  joinSubtitle,
  labeledOutputItems,
  resourceTypeDisplayName,
} from "@infrawrench/plugin-base";
import { fieldItems, parseJson, pluginAction } from "./kit.js";

/** Detail-only data from `enrichDetail`, as JSON strings in `__` fields. */
export const ENRICH = {
  releases: "__releases",
  sizes: "__sizes",
  plans: "__plans",
  couplings: "__couplings",
  reviewConfig: "__reviewConfig",
  members: "__members",
  formation: "__formation",
} as const;

export function resourceStatus(resource: ResourceInstance): ResourceStatus {
  const f = resource.fields;
  const s = String(f["status"] ?? f["state"] ?? "");
  switch (resource.resourceTypeId) {
    case "app":
      return f["maintenance"] === true ? "degraded" : "healthy";
    case "formation":
      return f["running"] === true ? "healthy" : "info";
    case "dyno":
      if (s === "up" || s === "idle") return "healthy";
      if (s === "starting") return "provisioning";
      if (s === "crashed") return "error";
      return "degraded";
    case "release":
      if (s === "succeeded") return f["current"] === true ? "healthy" : "info";
      if (s === "pending") return "provisioning";
      if (s === "failed") return "error";
      return "info";
    case "add-on":
      if (s === "provisioned") return "healthy";
      if (s === "provisioning") return "provisioning";
      return "degraded";
    case "domain": {
      const acm = String(f["acmStatus"] ?? "");
      if (acm === "failed") return "error";
      if (s === "succeeded" || s === "none" || acm === "cert issued") return "healthy";
      return "provisioning";
    }
    case "review-app":
      if (s === "created") return "healthy";
      if (s === "errored") return "error";
      if (s === "deleted" || s === "deleting") return "degraded";
      return "provisioning";
    case "space":
      return s === "allocated" ? "healthy" : "provisioning";
    default:
      return "info";
  }
}

function prompt(
  label: string,
  command: string,
  description: string,
  fields: CreateFieldConfig[],
  submitLabel: string,
  danger = false,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "prompt-nosql-command",
      command,
      title: label,
      description,
      fields,
      submitLabel,
      ...(danger ? { danger: true } : {}),
    },
    ...(danger ? { variant: "danger" as const } : {}),
  };
}

interface ReleaseLite {
  id: string;
  version: number;
  description?: string;
  current?: boolean;
  eligible_for_rollback?: boolean;
  status?: string;
  created_at?: string;
}

function appActions(f: ResourceInstance["fields"]): ActionNode[] {
  const sizes = parseJson<Array<{ name: string }>>(f[ENRICH.sizes], []);
  const releases = parseJson<ReleaseLite[]>(f[ENRICH.releases], []).filter(
    (r) => r.eligible_for_rollback && !r.current,
  );
  const actions: ActionNode[] = [
    pluginAction("Restart All Dynos", "restart-all", {
      confirm: "Restart every dyno of this app?",
      success: "Restart requested.",
    }),
    prompt(
      "Run One-Off Dyno",
      "runDyno",
      "Runs a command in a detached one-off dyno with the app's config. Its output goes to the app's logs.",
      [
        {
          key: "command",
          label: "Command",
          kind: "text",
          required: true,
          placeholder: "rake db:migrate",
        },
        ...(sizes.length
          ? [
              {
                key: "size",
                label: "Dyno size",
                kind: "select" as const,
                required: false,
                defaultValue: "",
                options: [
                  { id: "", label: "Default for the app" },
                  ...sizes.map((s) => ({ id: s.name, label: s.name })),
                ],
              },
            ]
          : []),
      ],
      "Run",
    ),
    pluginAction("Clear Build Cache", "clear-cache", {
      confirm: "Clear the build cache? The next build starts from scratch.",
      success: "Build cache cleared.",
    }),
  ];
  if (releases.length) {
    actions.push(
      prompt(
        "Roll Back",
        "rollback",
        "Creates a new release with the chosen release's slug and config vars. Add-ons are not changed.",
        [
          {
            key: "release",
            label: "Roll back to",
            kind: "select",
            required: true,
            defaultValue: releases[0]!.id,
            options: releases.map((r) => ({
              id: r.id,
              label: `v${r.version}`,
              ...(r.description ? { description: r.description } : {}),
            })),
          },
        ],
        "Roll Back",
      ),
    );
  }
  if (f["acm"] === true) {
    actions.push(
      pluginAction("Refresh Certificates", "refresh-acm", {
        success: "Automated Certificate Management refresh requested.",
      }),
    );
  }
  return actions;
}

function pipelineActions(f: ResourceInstance["fields"]): ActionNode[] {
  const couplings = parseJson<Array<{ appId: string; appName: string; stage: string }>>(
    f[ENRICH.couplings],
    [],
  );
  const actions: ActionNode[] = [];
  const order = ["development", "staging", "production"];
  const sources = couplings.filter((c) => c.stage === "development" || c.stage === "staging");
  if (sources.length) {
    actions.push(
      prompt(
        "Promote",
        "promote",
        "Copies the source app's current slug to every app in the next stage. Config vars stay per app.",
        [
          {
            key: "source",
            label: "Promote from",
            kind: "select",
            required: true,
            defaultValue: sources[0]!.appId,
            options: sources.map((c) => {
              const next = order[order.indexOf(c.stage) + 1] ?? "";
              const targets = couplings.filter((t) => t.stage === next).map((t) => t.appName);
              return {
                id: c.appId,
                label: `${c.appName} (${c.stage})`,
                description: targets.length
                  ? `to ${targets.join(", ")}`
                  : "no apps in the next stage",
              };
            }),
          },
        ],
        "Promote",
      ),
    );
  }
  const review = parseJson<{
    automatic_review_apps?: boolean;
    destroy_stale_apps?: boolean;
    stale_days?: number;
    wait_for_ci?: boolean;
  } | null>(f[ENRICH.reviewConfig], null);
  if (review) {
    actions.push(
      prompt(
        "Review App Settings",
        "reviewConfig",
        "How review apps are created and cleaned up for this pipeline.",
        [
          {
            key: "automatic",
            label: "Create a review app for every pull request",
            kind: "select",
            required: true,
            defaultValue: review.automatic_review_apps ? "true" : "false",
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No, only on request" },
            ],
          },
          {
            key: "waitForCi",
            label: "Wait for CI to pass first",
            kind: "select",
            required: true,
            defaultValue: review.wait_for_ci ? "true" : "false",
            options: [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ],
          },
          {
            key: "staleDays",
            label: "Delete stale review apps after (days)",
            kind: "number",
            required: false,
            minValue: 1,
            maxValue: 30,
            defaultValue:
              review.destroy_stale_apps && review.stale_days ? String(review.stale_days) : "",
            description: "Blank keeps them until the pull request closes.",
          },
        ],
        "Save",
      ),
    );
  }
  return actions;
}

function headerActions(resource: ResourceInstance): ActionNode[] {
  const f = resource.fields;
  let actions: ActionNode[] = [];
  switch (resource.resourceTypeId) {
    case "app":
      actions = appActions(f);
      break;
    case "formation":
      actions.push(
        pluginAction("Restart", "restart", { success: "Restart requested." }),
        f["running"] === true
          ? pluginAction("Stop", "stop", {
              confirm: "Scale this process type to zero dynos?",
              success: "Process type stopped.",
              danger: true,
            })
          : pluginAction("Start", "start", { success: "Scaled to one dyno." }),
      );
      break;
    case "dyno":
      actions.push(
        pluginAction("Restart", "restart", { success: "Dyno restarting." }),
        pluginAction("Stop", "stop", {
          confirm: "Stop this dyno? The formation starts a replacement unless it is a one-off.",
          success: "Dyno stopped.",
          danger: true,
        }),
      );
      break;
    case "release":
      if (f["eligibleForRollback"] === true && f["current"] !== true) {
        actions.push(
          pluginAction("Roll Back to This Release", "rollback", {
            confirm: "Create a new release with this release's code and config vars?",
            success: "Rollback release created.",
          }),
        );
      }
      break;
    case "add-on": {
      const plans = parseJson<
        Array<{ name: string; human_name?: string; price?: { cents?: number; unit?: string } }>
      >(f[ENRICH.plans], []);
      if (plans.length > 1) {
        actions.push(
          prompt(
            "Change Plan",
            "changePlan",
            "Moves the add-on to another plan of the same service. Some services migrate data and briefly go read-only.",
            [
              {
                key: "plan",
                label: "Plan",
                kind: "select",
                required: true,
                defaultValue: String(f["plan"] ?? ""),
                options: plans.map((p) => ({
                  id: p.name,
                  label: p.human_name || p.name,
                  ...(p.price?.cents !== undefined
                    ? {
                        description: `$${(p.price.cents / 100).toFixed(2)} / ${p.price.unit ?? "month"}`,
                      }
                    : {}),
                })),
              },
            ],
            "Change",
          ),
        );
      }
      break;
    }
    case "pipeline":
      actions = pipelineActions(f);
      break;
  }
  const url = consoleUrl(resource);
  if (url)
    actions.push({ kind: "action", label: "Open in Heroku", action: { type: "open-url", url } });
  if (resource.resourceTypeId === "app" && f["webUrl"]) {
    actions.push({
      kind: "action",
      label: "Open App",
      action: { type: "open-url", url: String(f["webUrl"]) },
    });
  }
  actions.push({ kind: "action", label: "Refresh", action: { type: "refresh-resource" } });
  return actions;
}

export function consoleUrl(resource: ResourceInstance): string | null {
  const f = resource.fields;
  const app = String(f["appName"] ?? (resource.resourceTypeId === "app" ? f["name"] : "") ?? "");
  switch (resource.resourceTypeId) {
    case "pipeline":
      return `https://dashboard.heroku.com/pipelines/${resource.externalId}`;
    case "space":
      return `https://dashboard.heroku.com/spaces/${encodeURIComponent(String(f["name"] ?? ""))}`;
    case "team":
      return `https://dashboard.heroku.com/teams/${encodeURIComponent(String(f["name"] ?? ""))}`;
    case "add-on":
      return f["webUrl"] ? String(f["webUrl"]) : null;
    default:
      return app ? `https://dashboard.heroku.com/apps/${encodeURIComponent(app)}` : null;
  }
}

function table(
  title: string,
  columns: TableColumn[],
  rows: Array<Record<string, string>>,
): SectionNode | null {
  if (rows.length === 0) return null;
  return {
    kind: "section",
    title,
    children: [{ kind: "table", columns, rows: rows.map((cells) => ({ cells })) }],
  };
}

function enrichedSections(resource: ResourceInstance): SectionNode[] {
  const f = resource.fields;
  const out: Array<SectionNode | null> = [];
  if (resource.resourceTypeId === "app") {
    const formation = parseJson<
      Array<{ type: string; quantity: number; size?: string; command?: string }>
    >(f[ENRICH.formation], []);
    out.push(
      table(
        "Formation",
        [
          { key: "type", label: "Process" },
          { key: "quantity", label: "Dynos" },
          { key: "size", label: "Size" },
          { key: "command", label: "Command", mono: true, width: "wide" },
        ],
        formation.map((p) => ({
          type: p.type,
          quantity: String(p.quantity),
          size: p.size ?? "",
          command: p.command ?? "",
        })),
      ),
    );
    const releases = parseJson<ReleaseLite[]>(f[ENRICH.releases], []);
    out.push(
      table(
        "Recent Releases",
        [
          { key: "version", label: "Version", width: "narrow" },
          { key: "description", label: "Description", width: "wide" },
          { key: "status", label: "Status" },
          { key: "created", label: "Created" },
        ],
        releases.slice(0, 10).map((r) => ({
          version: `v${r.version}${r.current ? " (current)" : ""}`,
          description: r.description ?? "",
          status: r.status ?? "",
          created: r.created_at ?? "",
        })),
      ),
    );
  }
  const couplings = parseJson<Array<{ appName: string; stage: string }>>(f[ENRICH.couplings], []);
  out.push(
    table(
      "Stages",
      [
        { key: "stage", label: "Stage" },
        { key: "app", label: "App" },
      ],
      couplings.map((c) => ({ stage: c.stage, app: c.appName })),
    ),
  );
  const members = parseJson<
    Array<{
      email: string;
      role?: string | null;
      two_factor_authentication?: boolean;
      user?: { name?: string | null };
    }>
  >(f[ENRICH.members], []);
  out.push(
    table(
      "Members",
      [
        { key: "email", label: "Email" },
        { key: "name", label: "Name" },
        { key: "role", label: "Role" },
        { key: "mfa", label: "2FA" },
      ],
      members.map((m) => ({
        email: m.email,
        name: m.user?.name ?? "",
        role: m.role ?? "",
        mfa: m.two_factor_authentication ? "On" : "Off",
      })),
    ),
  );
  return out.filter((s): s is SectionNode => s !== null);
}

const LOG_TYPES = new Set(["app", "dyno", "formation"]);

export function renderHerokuDetail(
  resource: ResourceInstance,
  resourceTypes: ResourceTypeDefinition[],
): DetailViewSchema {
  const f = resource.fields;
  const sections: SectionNode[] = [
    {
      kind: "section",
      title: "Details",
      children: [{ kind: "key-value-list", items: fieldItems(resource, resourceTypes, ["token"]) }],
    },
  ];
  const outputs = labeledOutputItems(
    resource.resolvedOutputs,
    resourceTypes,
    resource.resourceTypeId,
  ).filter((i) => i.value !== "");
  if (outputs.length > 0) {
    sections.push({
      kind: "section",
      title: "Endpoints",
      children: [{ kind: "key-value-list", items: outputs.map((i) => ({ ...i, copyable: true })) }],
    });
  }
  sections.push(...enrichedSections(resource));
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(
      resourceTypeDisplayName(resourceTypes, resource.resourceTypeId),
      f["appName"],
      f["region"],
      f["team"],
    ),
    status: {
      kind: "status-dot",
      status: resourceStatus(resource),
      ...(f["status"] || f["state"] ? { label: String(f["status"] || f["state"]) } : {}),
    },
    sections,
    headerActions: headerActions(resource),
    ...(LOG_TYPES.has(resource.resourceTypeId) ? { logs: { defaultTailLines: 200 } } : {}),
  };
}

export function renderHerokuSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  return {
    id: resource.id,
    label: resource.displayName || resource.id,
    status: { kind: "status-dot", status: resourceStatus(resource) },
  };
}
