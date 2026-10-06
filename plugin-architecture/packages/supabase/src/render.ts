import type {
  ActionNode,
  DetailViewSchema,
  DetailViewTab,
  KVItem,
  ResourceInstance,
  SectionNode,
  SidebarItemSchema,
  TableNode,
} from "@infrawrench/plugin-base";
import {
  formatBytes,
  joinSubtitle,
  labeledFieldItems,
  withMetricsCapability,
} from "@infrawrench/plugin-base";
import { projectHealth, statusLabel } from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./observability.js";
import { resourceTypes } from "./resource-types.js";
import type {
  SbAddons,
  SbCustomHostname,
  SbDiskAutoscale,
  SbDiskConfig,
  SbDiskUtil,
  SbHealth,
  SbLint,
  SbMember,
  SbReadonly,
  SbUpgradeEligibility,
  SbVanity,
} from "./types.js";

/**
 * Detail views. Expensive per-view data (advisors, health, disk, add-on
 * prices, upgrade eligibility, domains, members) is fetched by `enrichDetail`
 * and stashed on the instance as JSON strings under `_`-prefixed field keys,
 * which no resource type declares, so they never reach the edit form or the
 * synced inventory.
 */
export const ENRICH = {
  health: "_health",
  advisors: "_advisors",
  disk: "_disk",
  diskUtil: "_diskUtil",
  autoscale: "_autoscale",
  addons: "_addons",
  upgrade: "_upgrade",
  customHostname: "_customHostname",
  vanity: "_vanity",
  readonly: "_readonly",
  members: "_members",
} as const;

export function readJson<T>(resource: ResourceInstance, key: string): T | undefined {
  const raw = resource.fields[key];
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function str(resource: ResourceInstance, key: string): string {
  const v = resource.fields[key];
  return v === undefined || v === null ? "" : String(v);
}

function yesNo(value: unknown): string {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return "";
}

function kv(items: Array<[string, string | undefined]>, copyable: string[] = []): KVItem[] {
  return items
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([key, value]) => ({
      key,
      value: value!,
      ...(copyable.includes(key) ? { copyable: true } : {}),
    }));
}

function section(title: string, items: KVItem[]): SectionNode | null {
  if (items.length === 0) return null;
  return { kind: "section", title, children: [{ kind: "key-value-list", items }] };
}

function action(
  label: string,
  actionId: string,
  opts: {
    confirm?: string;
    success?: string;
    destructive?: boolean;
    variant?: ActionNode["variant"];
  } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.success ? { successMessage: opts.success } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
    ...(opts.variant ? { variant: opts.variant } : {}),
  };
}

function link(label: string, url: string): ActionNode {
  return { kind: "action", label, action: { type: "open-url", url }, variant: "ghost" };
}

const REFRESH: ActionNode = {
  kind: "action",
  label: "Refresh",
  action: { type: "refresh-resource" },
};

function dashboardUrl(ref: string, path = ""): string {
  return `https://supabase.com/dashboard/project/${ref}${path}`;
}

function compact(sections: Array<SectionNode | null>): SectionNode[] {
  return sections.filter((s): s is SectionNode => s !== null);
}

function money(amount: number, interval: string): string {
  return `$${amount.toFixed(amount < 1 ? 4 : 2)} / ${interval === "hourly" ? "hour" : "month"}`;
}

export function renderDetail(resource: ResourceInstance): DetailViewSchema {
  const schema = renderInner(resource);
  return withMetricsCapability(
    schema,
    resourceTypes,
    resource.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

function renderInner(resource: ResourceInstance): DetailViewSchema {
  switch (resource.resourceTypeId) {
    case "supabase-organization":
      return renderOrganization(resource);
    case "supabase-project":
      return renderProject(resource);
    case "supabase-branch":
      return renderBranch(resource);
    case "supabase-function":
      return renderFunction(resource);
    case "supabase-bucket":
      return renderBucket(resource);
    case "supabase-auth":
      return renderAuth(resource);
    case "supabase-signing-key":
      return renderSigningKey(resource);
    default:
      return renderGeneric(resource);
  }
}

function typeName(typeId: string): string {
  return resourceTypes.find((t) => t.id === typeId)?.displayName ?? typeId;
}

function renderGeneric(resource: ResourceInstance): DetailViewSchema {
  const items = labeledFieldItems(
    Object.fromEntries(Object.entries(resource.fields).filter(([k]) => !k.startsWith("_"))),
    resourceTypes,
    resource.resourceTypeId,
  );
  const ref = str(resource, "projectRef");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(typeName(resource.resourceTypeId), ref),
    status: { kind: "status-dot", status: "info" },
    sections: compact([section("Details", items)]),
    headerActions: [REFRESH],
  };
}

function renderOrganization(resource: ResourceInstance): DetailViewSchema {
  const slug = str(resource, "slug");
  const members = readJson<SbMember[]>(resource, ENRICH.members) ?? [];
  const sections = compact([
    section(
      "Organization",
      kv(
        [
          ["Slug", slug],
          ["Plan", str(resource, "plan")],
          ["Projects", str(resource, "projectCount")],
          ["Members", str(resource, "memberCount")],
          ["Members without MFA", str(resource, "membersWithoutMfa")],
        ],
        ["Slug"],
      ),
    ),
  ]);
  if (members.length > 0) {
    const table: TableNode = {
      kind: "table",
      columns: [
        { key: "name", label: "Member" },
        { key: "email", label: "Email" },
        { key: "role", label: "Role" },
        { key: "mfa", label: "MFA", width: "narrow" },
      ],
      rows: members.map((m) => ({
        cells: {
          name: m.user_name,
          email: m.email ?? "",
          role: m.role_name ?? "",
          mfa: m.mfa_enabled ? "Yes" : "No",
        },
      })),
      emphasizeFirstColumn: true,
    };
    sections.push({ kind: "section", title: "Members", children: [table] });
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Organization", str(resource, "plan")),
    status: { kind: "status-dot", status: "info" },
    sections,
    headerActions: [
      REFRESH,
      link("Open in Supabase", `https://supabase.com/dashboard/org/${slug}`),
      link("Billing & usage", `https://supabase.com/dashboard/org/${slug}/usage`),
    ],
  };
}

function lintTable(lints: SbLint[]): TableNode {
  const order = { ERROR: 0, WARN: 1, INFO: 2 } as const;
  return {
    kind: "table",
    columns: [
      { key: "level", label: "Level", width: "narrow" },
      { key: "title", label: "Finding" },
      { key: "entity", label: "Object", mono: true },
      { key: "detail", label: "Detail", width: "wide" },
      { key: "fix", label: "", width: "narrow" },
    ],
    rows: [...lints]
      .sort((a, b) => order[a.level] - order[b.level])
      .map((l) => ({
        cells: {
          level: l.level,
          title: l.title,
          entity: l.metadata?.entity ?? l.metadata?.name ?? "",
          detail: l.detail,
          fix: l.remediation
            ? {
                kind: "action",
                label: "Fix guide",
                action: { type: "open-url", url: l.remediation },
                variant: "ghost",
              }
            : "",
        },
      })),
  };
}

function renderProject(resource: ResourceInstance): DetailViewSchema {
  const ref = str(resource, "ref") || resource.externalId || "";
  const status = str(resource, "status");
  const paused = status === "INACTIVE";
  const health = readJson<SbHealth[]>(resource, ENRICH.health) ?? [];
  const advisors = readJson<{ security: SbLint[]; performance: SbLint[] }>(
    resource,
    ENRICH.advisors,
  );
  const disk = readJson<SbDiskConfig>(resource, ENRICH.disk);
  const util = readJson<SbDiskUtil>(resource, ENRICH.diskUtil);
  const autoscale = readJson<SbDiskAutoscale>(resource, ENRICH.autoscale);
  const addons = readJson<SbAddons>(resource, ENRICH.addons);
  const upgrade = readJson<SbUpgradeEligibility>(resource, ENRICH.upgrade);
  const hostname = readJson<SbCustomHostname>(resource, ENRICH.customHostname);
  const vanity = readJson<SbVanity>(resource, ENRICH.vanity);
  const readonly = readJson<SbReadonly>(resource, ENRICH.readonly);

  const usedPct =
    util && util.metrics.fs_size_bytes > 0
      ? `${((util.metrics.fs_used_bytes / util.metrics.fs_size_bytes) * 100).toFixed(1)}% (${formatBytes(util.metrics.fs_used_bytes)} of ${formatBytes(util.metrics.fs_size_bytes)})`
      : undefined;

  const sections = compact([
    section(
      "Overview",
      kv(
        [
          ["Project ref", ref],
          ["Organization", str(resource, "organizationSlug")],
          ["Region", str(resource, "region")],
          ["Status", statusLabel(status)],
          [
            "Postgres",
            joinSubtitle(str(resource, "postgresVersion"), str(resource, "releaseChannel")),
          ],
          ["Compute", str(resource, "computeSize")],
          ["Read replicas", str(resource, "readReplicaCount")],
          ["Created", str(resource, "createdAt")],
        ],
        ["Project ref"],
      ),
    ),
    section(
      "Connect",
      kv(
        [
          ["API URL", str(resource, "apiUrl")],
          ["Database host", str(resource, "dbHost")],
          ["Pooler mode", str(resource, "poolMode")],
          ["Pooler pool size", str(resource, "poolSize")],
          ["Dedicated IPv4", yesNo(resource.fields["ipv4"])],
        ],
        ["API URL", "Database host"],
      ),
    ),
    section(
      "Security",
      kv([
        ["SSL enforced", yesNo(resource.fields["sslEnforced"])],
        [
          "Allowed IPv4",
          str(resource, "allowedCidrs") || (resource.fields["networkOpen"] ? "All addresses" : ""),
        ],
        ["Allowed IPv6", str(resource, "allowedCidrsV6")],
        ["Legacy anon/service_role keys", yesNo(resource.fields["legacyApiKeysEnabled"])],
        [
          "Read-only mode",
          readonly
            ? readonly.enabled
              ? readonly.override_enabled
                ? `On (overridden until ${readonly.override_active_until})`
                : "On (disk nearly full)"
              : "Off"
            : undefined,
        ],
      ]),
    ),
    section(
      "Backups",
      kv([
        ["Daily backups", yesNo(resource.fields["automatedBackups"])],
        [
          "Point-in-time recovery",
          resource.fields["pitrEnabled"] === true
            ? `${str(resource, "pitrDays") || "?"} days`
            : yesNo(resource.fields["pitrEnabled"]),
        ],
      ]),
    ),
    section(
      "Disk",
      kv([
        [
          "Size",
          disk
            ? `${disk.attributes.size_gb} GB`
            : str(resource, "diskSizeGb")
              ? `${str(resource, "diskSizeGb")} GB`
              : "",
        ],
        ["Type", disk?.attributes.type ?? str(resource, "diskType")],
        ["IOPS", disk ? String(disk.attributes.iops) : ""],
        [
          "Throughput",
          disk?.attributes.throughput_mibps ? `${disk.attributes.throughput_mibps} MiB/s` : "",
        ],
        ["Used", usedPct],
        [
          "Autoscale limit",
          autoscale
            ? `${autoscale.max_size_gb} GB (+${autoscale.growth_percent}%, min ${autoscale.min_increment_gb} GB)`
            : "",
        ],
      ]),
    ),
    section(
      "Postgres upgrade",
      upgrade
        ? kv([
            ["Eligible", yesNo(upgrade.eligible)],
            ["Current", upgrade.current_app_version],
            ["Latest", upgrade.latest_app_version],
            [
              "Targets",
              upgrade.target_upgrade_versions
                .map((t) => `${t.postgres_version} (${t.app_version})`)
                .join(", "),
            ],
            [
              "Estimated downtime",
              upgrade.duration_estimate_hours ? `${upgrade.duration_estimate_hours} h` : "",
            ],
          ])
        : [],
    ),
    section(
      "Domains",
      kv([
        [
          "Custom domain",
          hostname?.custom_hostname
            ? `${hostname.custom_hostname} (${hostname.status.replace(/^\d_/, "").replace(/_/g, " ")})`
            : "",
        ],
        [
          "Verification TXT",
          hostname?.data?.result?.ownership_verification?.name
            ? `${hostname.data.result.ownership_verification.name} = ${hostname.data.result.ownership_verification.value ?? ""}`
            : "",
        ],
        ["Vanity subdomain", vanity?.status === "active" ? (vanity.custom_domain ?? "") : ""],
      ]),
    ),
  ]);

  if (addons && addons.selected_addons.length > 0) {
    sections.push({
      kind: "section",
      title: "Add-ons",
      children: [
        {
          kind: "table",
          columns: [
            { key: "type", label: "Add-on" },
            { key: "variant", label: "Selection" },
            { key: "price", label: "List price" },
          ],
          rows: addons.selected_addons.map((a) => ({
            cells: {
              type: a.type.replace(/_/g, " "),
              variant: a.variant.name,
              price: a.variant.price ? money(a.variant.price.amount, a.variant.price.interval) : "",
            },
          })),
          emphasizeFirstColumn: true,
        },
      ],
    });
  }

  const tabs: DetailViewTab[] = [];
  if (advisors) {
    const lints = [...advisors.security, ...advisors.performance];
    tabs.push({
      id: "advisors",
      label: `Advisors${lints.length ? ` (${lints.length})` : ""}`,
      sections: [
        {
          kind: "section",
          title: "Security",
          children: advisors.security.length
            ? [lintTable(advisors.security)]
            : [{ kind: "text", content: "No security findings.", variant: "muted" }],
        },
        {
          kind: "section",
          title: "Performance",
          children: advisors.performance.length
            ? [lintTable(advisors.performance)]
            : [{ kind: "text", content: "No performance findings.", variant: "muted" }],
        },
      ],
    });
  }
  if (health.length > 0) {
    tabs.push({
      id: "health",
      label: "Services",
      sections: [
        {
          kind: "section",
          title: "Service health",
          children: [
            {
              kind: "table",
              columns: [
                { key: "service", label: "Service" },
                { key: "status", label: "Status" },
                { key: "version", label: "Version" },
                { key: "error", label: "Error", width: "wide" },
              ],
              rows: health.map((h) => ({
                cells: {
                  service: h.name,
                  status: statusLabel(h.status),
                  version: h.info?.version ?? "",
                  error: h.error ?? "",
                },
              })),
              emphasizeFirstColumn: true,
            },
          ],
        },
      ],
    });
  }
  tabs.push({
    id: "auth-and-keys",
    label: "Auth & Keys",
    childResourceTypeIds: [
      "supabase-auth",
      "supabase-api-key",
      "supabase-signing-key",
      "supabase-sso-provider",
      "supabase-third-party-auth",
    ],
  });
  tabs.push({
    id: "functions",
    label: "Edge Functions",
    childResourceTypeIds: ["supabase-function", "supabase-secret"],
  });

  const headerActions: ActionNode[] = [REFRESH, link("Open in Supabase", dashboardUrl(ref))];
  if (paused) {
    headerActions.push(
      action("Restore", "restore", { success: "Restoring the project. This takes a few minutes." }),
    );
  } else {
    headerActions.push(
      action("Restart", "restart", {
        confirm: "Restart every service of this project? Connections drop for a minute or two.",
        success: "Restarting.",
      }),
      action("Pause", "pause", {
        confirm:
          "Pause this project? Its API and database stop answering until it is restored. Pausing is available on the Free plan only.",
        success: "Pausing.",
      }),
      action("Reset database password", "reset-db-password", {
        confirm:
          "Set a new random password for the postgres role? Anything using the old password stops connecting.",
        success: "Password reset; connection strings now use the new one.",
      }),
    );
  }
  if (upgrade?.eligible && upgrade.target_upgrade_versions.length > 0) {
    const target = upgrade.target_upgrade_versions[upgrade.target_upgrade_versions.length - 1]!;
    headerActions.push(
      action(`Upgrade to Postgres ${target.postgres_version}`, "upgrade-postgres", {
        confirm: `Upgrade Postgres in place to ${target.postgres_version}? The project is offline for roughly ${upgrade.duration_estimate_hours || 1} hour(s).`,
        success: "Upgrade started.",
      }),
    );
  }
  if (readonly?.enabled && !readonly.override_enabled) {
    headerActions.push(
      action("Allow writes for 15 minutes", "disable-readonly", {
        confirm: "Turn read-only mode off for 15 minutes so you can free disk space?",
      }),
    );
  }
  if (hostname?.custom_hostname && hostname.status !== "5_services_reconfigured") {
    headerActions.push(
      action("Re-verify custom domain", "reverify-custom-hostname"),
      action("Activate custom domain", "activate-custom-hostname", {
        confirm:
          "Switch the project's API to the custom domain? Clients using the supabase.co URL keep working.",
      }),
    );
  }
  headerActions.push(
    action("Unban all IPs", "unban-all", {
      confirm:
        "Lift every network ban Supabase's brute-force protection has placed on this database?",
      success: "Bans removed.",
    }),
  );

  const health0 = projectHealth(status);
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Project", str(resource, "region"), statusLabel(status)),
    status: { kind: "status-dot", status: health0, label: statusLabel(status) },
    sections,
    customTabs: tabs,
    headerActions,
    ...(paused
      ? {}
      : {
          settingsEditor: {
            tabLabel: "Configuration",
            description:
              "Postgres, connection pooler, Data API, Storage and Realtime settings. Postgres changes may restart the database.",
          },
          sqlEditor: {
            connectionStringOutputKey: "__supabase__",
            defaultQuery:
              "select table_schema, table_name from information_schema.tables where table_schema = 'public' limit 50;",
          },
          logs: { defaultTailLines: 200 },
        }),
  };
}

function renderBranch(resource: ResourceInstance): DetailViewSchema {
  const branchRef = str(resource, "branchRef");
  const isDefault = resource.fields["isDefault"] === true;
  const status = str(resource, "projectStatus") || str(resource, "status");
  const headerActions: ActionNode[] = [REFRESH, link("Open in Supabase", dashboardUrl(branchRef))];
  if (!isDefault) {
    headerActions.push(
      action("Push migrations", "push", { success: "Pushing the branch's migrations." }),
      action("Merge into production", "merge", {
        confirm: "Merge this branch's migrations and functions into the production branch?",
        success: "Merge started.",
      }),
      action("Reset", "reset", {
        confirm: "Reset this branch to the production branch's schema? Data on the branch is lost.",
        destructive: true,
      }),
    );
    if (str(resource, "deletionScheduledAt")) {
      headerActions.push(action("Cancel scheduled deletion", "restore-branch"));
    }
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle(isDefault ? "Production branch" : "Branch", str(resource, "gitBranch")),
    status: { kind: "status-dot", status: projectHealth(status), label: statusLabel(status) },
    sections: compact([
      section(
        "Branch",
        kv(
          [
            ["Branch ref", branchRef],
            ["Parent project", str(resource, "parentRef")],
            ["Git branch", str(resource, "gitBranch")],
            ["Pull request", str(resource, "prNumber")],
            ["Persistent", yesNo(resource.fields["persistent"])],
            ["Seeded with data", yesNo(resource.fields["withData"])],
            ["Workflow status", statusLabel(str(resource, "status"))],
            [
              "Project status",
              str(resource, "projectStatus") ? statusLabel(str(resource, "projectStatus")) : "",
            ],
            ["Deletion scheduled", str(resource, "deletionScheduledAt")],
            ["Created", str(resource, "createdAt")],
          ],
          ["Branch ref"],
        ),
      ),
    ]),
    headerActions,
  };
}

function renderFunction(resource: ResourceInstance): DetailViewSchema {
  const ref = str(resource, "projectRef");
  const slug = str(resource, "slug");
  const status = str(resource, "status");
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Edge Function", `v${str(resource, "version")}`),
    status: {
      kind: "status-dot",
      status: status === "ACTIVE" ? "healthy" : status === "THROTTLED" ? "degraded" : "info",
      label: status,
    },
    sections: compact([
      section(
        "Function",
        kv(
          [
            ["URL", str(resource, "url")],
            ["Slug", slug],
            ["Version", str(resource, "version")],
            ["Verify JWT", yesNo(resource.fields["verifyJwt"])],
            ["Entrypoint", str(resource, "entrypointPath")],
            ["Updated", str(resource, "updatedAt")],
          ],
          ["URL"],
        ),
      ),
    ]),
    headerActions: [REFRESH, link("Open in Supabase", dashboardUrl(ref, `/functions/${slug}`))],
    logs: { defaultTailLines: 200 },
  };
}

function renderBucket(resource: ResourceInstance): DetailViewSchema {
  const ref = str(resource, "projectRef");
  const name = str(resource, "name");
  const isPublic = resource.fields["public"] === true;
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("Storage Bucket", isPublic ? "Public" : "Private"),
    status: {
      kind: "status-dot",
      status: isPublic ? "degraded" : "healthy",
      label: isPublic ? "Public" : "Private",
    },
    sections: compact([
      section(
        "Bucket",
        kv([
          ["Access", isPublic ? "Public" : "Private"],
          [
            "File size limit",
            typeof resource.fields["fileSizeLimit"] === "number"
              ? formatBytes(resource.fields["fileSizeLimit"] as number)
              : "Project default",
          ],
          ["Allowed MIME types", str(resource, "allowedMimeTypes") || "Any"],
          ["Created", str(resource, "createdAt")],
        ]),
      ),
    ]),
    headerActions: [
      REFRESH,
      link("Open in Supabase", dashboardUrl(ref, `/storage/buckets/${encodeURIComponent(name)}`)),
      action("Empty bucket", "empty", {
        confirm: `Delete every object in "${name}"? This cannot be undone.`,
        destructive: true,
        success: "Bucket emptied.",
      }),
    ],
    storageBrowser: {
      bucketName: `${ref}/${resource.externalId?.split("/").slice(1).join("/") || name}`,
    },
  };
}

function renderAuth(resource: ResourceInstance): DetailViewSchema {
  const ref = str(resource, "projectRef");
  return {
    title: resource.displayName,
    subtitle: "Supabase Auth",
    status: { kind: "status-dot", status: "info" },
    sections: compact([
      section(
        "Auth",
        kv([
          ["Site URL", str(resource, "siteUrl")],
          ["Sign-ups", resource.fields["disableSignup"] === true ? "Disabled" : "Open"],
          ["Providers", str(resource, "enabledProviders")],
          ["Minimum password length", str(resource, "passwordMinLength")],
          ["Leaked password protection", yesNo(resource.fields["leakedPasswordProtection"])],
          ["TOTP MFA", yesNo(resource.fields["mfaTotp"])],
          ["Custom SMTP", yesNo(resource.fields["customSmtp"])],
          [
            "Access token lifetime",
            str(resource, "jwtExpirySeconds") ? `${str(resource, "jwtExpirySeconds")} s` : "",
          ],
        ]),
      ),
    ]),
    headerActions: [REFRESH, link("Open in Supabase", dashboardUrl(ref, "/auth/providers"))],
    settingsEditor: {
      tabLabel: "Auth Settings",
      description:
        "Sign-in providers, sessions, passwords, MFA, email and rate limits. Provider client secrets and the SMTP password are write-only, so set those in the Supabase dashboard.",
    },
  };
}

function renderSigningKey(resource: ResourceInstance): DetailViewSchema {
  const status = str(resource, "status");
  const actions: ActionNode[] = [REFRESH];
  if (status === "standby") {
    actions.push(
      action("Start signing with this key", "rotate-in", {
        confirm:
          "Make this the key that signs new access tokens? The current key moves to previously used and keeps verifying existing tokens.",
      }),
    );
  }
  if (status === "previously_used") {
    actions.push(
      action("Revoke", "revoke", {
        confirm: "Revoke this key? Tokens it signed stop verifying immediately.",
        destructive: true,
      }),
    );
  }
  return {
    title: resource.displayName,
    subtitle: joinSubtitle("JWT Signing Key", str(resource, "algorithm")),
    status: {
      kind: "status-dot",
      status: status === "in_use" ? "healthy" : status === "revoked" ? "error" : "info",
      label: status.replace(/_/g, " "),
    },
    sections: compact([
      section(
        "Key",
        kv(
          [
            ["Algorithm", str(resource, "algorithm")],
            ["Status", status.replace(/_/g, " ")],
            ["Public JWK", str(resource, "publicJwk")],
            ["Created", str(resource, "createdAt")],
          ],
          ["Public JWK"],
        ),
      ),
    ]),
    headerActions: actions,
  };
}

export function renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
  switch (resource.resourceTypeId) {
    case "supabase-project": {
      const status = str(resource, "status");
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: projectHealth(status), label: statusLabel(status) },
      };
    }
    case "supabase-branch": {
      const status = str(resource, "projectStatus") || str(resource, "status");
      return {
        id: resource.id,
        label: `${resource.displayName}${resource.fields["isDefault"] === true ? " (production)" : ""}`,
        status: { kind: "status-dot", status: projectHealth(status) },
      };
    }
    case "supabase-function":
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: str(resource, "status") === "ACTIVE" ? "healthy" : "degraded",
        },
      };
    case "supabase-bucket":
      return {
        id: resource.id,
        label: resource.displayName,
        status: {
          kind: "status-dot",
          status: resource.fields["public"] === true ? "degraded" : "healthy",
          label: resource.fields["public"] === true ? "Public" : "Private",
        },
      };
    default:
      return {
        id: resource.id,
        label: resource.displayName,
        status: { kind: "status-dot", status: "info" },
      };
  }
}
