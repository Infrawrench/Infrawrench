import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, labeledFieldItems, withMetricsCapability } from "@infrawrench/plugin-base";
import type {
  AccessPermissionResource,
  JfrogBuildInfo,
  JfrogRepoStorage,
  XrayPolicy,
} from "./mappers.js";
import { reindexPath } from "./reindex.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `getResource` stashes extra detail for the renderer. */
export const REPO_STORAGE_KEY = "__repoStorage__";
export const POLICY_RULES_KEY = "__rules__";
export const PERMISSION_KEY = "__permission__";
export const BUILD_MODULES_KEY = "__modules__";

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function openUrl(label: string, url: string | undefined): ActionNode[] {
  return url ? [{ kind: "action", label, action: { type: "open-url", url } }] : [];
}

function pluginAction(
  label: string,
  actionId: string,
  successMessage: string,
  opts: { confirm?: string; destructive?: boolean; variant?: ActionNode["variant"] } = {},
): ActionNode {
  return {
    kind: "action",
    label,
    ...(opts.variant ? { variant: opts.variant } : {}),
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(opts.confirm ? { confirmMessage: opts.confirm } : {}),
      ...(opts.destructive ? { destructive: true } : {}),
    },
  };
}

/** Everything the type declares, labelled, minus what the renderer shows elsewhere. */
function allFields(r: ResourceInstance, skip: string[] = []): SchemaNode {
  const fields = Object.fromEntries(
    Object.entries(r.fields).filter(([k]) => !skip.includes(k)),
  ) as Record<string, string | number | boolean>;
  const items = labeledFieldItems(fields, RESOURCE_TYPES, r.resourceTypeId).map((item) =>
    item.value === "true"
      ? { ...item, value: "Yes" }
      : item.value === "false"
        ? { ...item, value: "No" }
        : item,
  );
  return { kind: "key-value-list", items };
}

function severityStatus(severity: string): ResourceStatus {
  const s = severity.toLowerCase();
  if (s === "critical" || s === "high") return "error";
  if (s === "medium") return "degraded";
  return "info";
}

const fmt = (n: number) => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------

function renderPlatform(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  const f = r.fields;
  const repos = parseJson<JfrogRepoStorage[]>(r.resolvedOutputs[REPO_STORAGE_KEY]) ?? [];
  const sections: SectionNode[] = [
    section("Platform", [
      kv([
        ["URL", f["baseUrl"], true],
        ["Artifactory version", f["version"]],
        ["Revision", f["revision"]],
        ["License", f["license"]],
        ["Add-ons", f["addons"]],
      ]),
    ]),
    section("Storage", [
      kv([
        ["Repositories", f["repositories"]],
        ["Artifacts", typeof f["artifactsCount"] === "number" ? fmt(f["artifactsCount"]) : ""],
        ["Artifacts size", f["artifactsSize"]],
        ["Binaries", typeof f["binariesCount"] === "number" ? fmt(f["binariesCount"]) : ""],
        ["Binaries size", f["binariesSize"]],
        ["Deduplication savings", f["optimization"]],
        ["File store", f["storageType"]],
        ["Capacity", f["totalSpace"]],
        ["Used", f["usedSpace"]],
        ["Free", f["freeSpace"]],
      ]),
      {
        kind: "text",
        variant: "muted",
        content:
          "Artifactory recalculates this summary periodically. Use Refresh storage summary to schedule a recalculation now; the new figures appear a few minutes later.",
      },
    ]),
  ];
  if (repos.length > 0) {
    sections.push(
      section("Largest repositories", [
        {
          kind: "table",
          columns: [
            { key: "repo", label: "Repository", width: "wide", mono: true },
            { key: "type", label: "Class" },
            { key: "pkg", label: "Package type" },
            { key: "files", label: "Files" },
            { key: "used", label: "Used space" },
            { key: "share", label: "Share" },
          ],
          rows: repos.map<TableRow>((row) => ({
            cells: {
              repo: row.repoKey,
              type: str(row.repoType).toLowerCase(),
              pkg: str(row.packageType),
              files: row.filesCount !== undefined ? fmt(row.filesCount) : "",
              used: str(row.usedSpace),
              share: str(row.percentage),
            },
          })),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle(
      "JFrog Platform",
      f["version"] ? `Artifactory ${str(f["version"])}` : "",
    ),
    status: { kind: "status-dot", status: "healthy", label: str(f["license"]) || "Connected" },
    sections,
    headerActions: [
      ...openUrl("Open in JFrog", `${baseUrl}/ui/`),
      pluginAction("Refresh storage summary", "refresh-storage", "Storage recalculation scheduled"),
    ],
  };
}

function renderRepository(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  const f = r.fields;
  const key = str(f["key"]) || r.displayName;
  const rclass = str(f["rclass"]);
  const actions: ActionNode[] = [
    ...openUrl("Open in JFrog", `${baseUrl}/ui/repos/tree/General/${encodeURIComponent(key)}`),
  ];
  if (rclass === "remote") {
    actions.push(
      pluginAction("Zap cache", "zap-cache", "Cached metadata invalidated", {
        confirm: `Invalidate the cached metadata of ${key}? Artifactory refetches it from the upstream on the next request.`,
      }),
    );
  }
  if (reindexPath(str(f["packageType"]), key)) {
    actions.push(
      pluginAction("Recalculate index", "reindex", "Index recalculation scheduled", {
        confirm: `Recalculate the ${str(f["packageType"])} index of ${key}? Large repositories can take a while; clients keep resolving meanwhile.`,
      }),
    );
  }
  const usage = kv([
    ["Files", f["filesCount"]],
    ["Folders", f["foldersCount"]],
    ["Used space", f["usedSpace"]],
    ["Share of storage", f["storagePercentage"]],
  ]);
  return withMetricsCapability(
    {
      title: key,
      subtitle: joinSubtitle(`${rclass || "repository"}`, f["packageType"], f["projectKey"]),
      status: {
        kind: "status-dot",
        status: f["blackedOut"] === true ? "degraded" : f["offline"] === true ? "info" : "healthy",
        label:
          f["blackedOut"] === true ? "Blacked out" : f["offline"] === true ? "Offline" : "Active",
      },
      sections: [
        section("Repository", [
          allFields(r, [
            "filesCount",
            "foldersCount",
            "itemsCount",
            "usedSpace",
            "usedSpaceBytes",
            "storagePercentage",
          ]),
          kv([["URL", r.resolvedOutputs["url"], true]]),
        ]),
        section("Storage", [usage]),
      ],
      headerActions: actions,
      ...(rclass === "local" ||
      rclass === "federated" ||
      rclass === "remote" ||
      rclass === "virtual"
        ? { storageBrowser: { bucketName: key } }
        : {}),
    },
    RESOURCE_TYPES,
    r.resourceTypeId,
  );
}

function renderBuild(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  const name = str(r.fields["name"]) || r.displayName;
  return {
    title: name,
    subtitle: joinSubtitle(
      "Build",
      r.fields["runs"] !== undefined ? `${str(r.fields["runs"])} runs` : "",
    ),
    sections: [section("Build", [allFields(r)])],
    headerActions: openUrl("Open in JFrog", `${baseUrl}/ui/builds/${encodeURIComponent(name)}`),
  };
}

function renderBuildRun(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  const f = r.fields;
  const modules = parseJson<NonNullable<JfrogBuildInfo["buildInfo"]>["modules"]>(
    r.resolvedOutputs[BUILD_MODULES_KEY],
  );
  const sections: SectionNode[] = [section("Run", [allFields(r)])];
  if (modules && modules.length > 0) {
    sections.push(
      section("Modules", [
        {
          kind: "table",
          columns: [
            { key: "id", label: "Module", width: "wide", mono: true },
            { key: "type", label: "Type" },
            { key: "artifacts", label: "Artifacts" },
            { key: "dependencies", label: "Dependencies" },
          ],
          rows: modules.map<TableRow>((m) => ({
            cells: {
              id: str(m.id),
              type: str(m.type),
              artifacts: String(m.artifacts?.length ?? 0),
              dependencies: String(m.dependencies?.length ?? 0),
            },
          })),
        },
      ]),
    );
    const artifacts = modules.flatMap((m) => m.artifacts ?? []).slice(0, 50);
    if (artifacts.length > 0) {
      sections.push(
        section("Artifacts", [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Name", width: "wide", mono: true },
              { key: "type", label: "Type" },
              { key: "path", label: "Path", mono: true },
            ],
            rows: artifacts.map<TableRow>((a) => ({
              cells: { name: str(a.name), type: str(a.type), path: str(a.path) },
            })),
          },
        ]),
      );
    }
  }
  const name = str(f["buildName"]);
  const number = str(f["number"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Build run", f["vcsBranch"], f["started"]),
    sections,
    headerActions: [
      ...openUrl(
        "Open in JFrog",
        name && number
          ? `${baseUrl}/ui/builds/${encodeURIComponent(name)}/${encodeURIComponent(number)}`
          : undefined,
      ),
      ...openUrl("Open CI run", str(f["ciUrl"]) || undefined),
    ],
  };
}

function renderWatch(r: ResourceInstance): DetailViewSchema {
  const active = r.fields["active"] === true;
  return {
    title: r.displayName,
    subtitle: "Xray watch",
    status: {
      kind: "status-dot",
      status: active ? "healthy" : "degraded",
      label: active ? "Active" : "Disabled",
    },
    sections: [section("Watch", [allFields(r)])],
    headerActions: [
      active
        ? pluginAction("Disable", "disable", "Watch disabled", {
            confirm: "Disable this watch? Xray stops scanning its resources against its policies.",
          })
        : pluginAction("Enable", "enable", "Watch enabled"),
    ],
  };
}

function renderPolicy(r: ResourceInstance): DetailViewSchema {
  const rules =
    parseJson<NonNullable<XrayPolicy["rules"]>>(r.resolvedOutputs[POLICY_RULES_KEY]) ?? [];
  const sections: SectionNode[] = [section("Policy", [allFields(r)])];
  if (rules.length > 0) {
    sections.push(
      section("Rules", [
        {
          kind: "table",
          columns: [
            { key: "priority", label: "Priority", width: "narrow" },
            { key: "name", label: "Rule", width: "wide" },
            { key: "criteria", label: "Criteria" },
            { key: "actions", label: "Actions" },
          ],
          rows: rules.map<TableRow>((rule) => {
            const c = rule.criteria ?? {};
            const criteria = [
              c.min_severity ? `severity ≥ ${c.min_severity}` : "",
              c.cvss_range ? `CVSS ${str(c.cvss_range.from)}–${str(c.cvss_range.to)}` : "",
              Array.isArray(c["banned_licenses"])
                ? `banned: ${(c["banned_licenses"] as string[]).join(", ")}`
                : "",
              Array.isArray(c["allowed_licenses"])
                ? `allowed: ${(c["allowed_licenses"] as string[]).join(", ")}`
                : "",
            ]
              .filter(Boolean)
              .join("; ");
            const a = rule.actions ?? {};
            const actions = [
              a.block_download?.active ? "block download" : "",
              a.fail_build ? "fail build" : "",
              a.notify_deployer ? "notify deployer" : "",
              a.notify_watch_recipients ? "notify recipients" : "",
            ]
              .filter(Boolean)
              .join(", ");
            return {
              cells: {
                priority: str(rule.priority),
                name: str(rule.name),
                criteria: criteria || "any",
                actions: actions || "report only",
              },
            };
          }),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Xray policy", r.fields["type"]),
    sections,
  };
}

function renderViolation(r: ResourceInstance): DetailViewSchema {
  const severity = str(r.fields["severity"]);
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Xray violation", r.fields["type"], severity),
    status: { kind: "status-dot", status: severityStatus(severity), label: severity || "Unknown" },
    sections: [section("Violation", [allFields(r)])],
  };
}

function renderToken(r: ResourceInstance): DetailViewSchema {
  const expires = str(r.fields["expiresAt"]);
  const expired = expires !== "" && Date.parse(expires) < Date.now();
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Access token", r.fields["username"] ?? r.fields["subject"]),
    status: {
      kind: "status-dot",
      status: expired ? "error" : r.fields["neverExpires"] === true ? "degraded" : "healthy",
      label: expired ? "Expired" : r.fields["neverExpires"] === true ? "Never expires" : "Valid",
    },
    sections: [section("Token", [allFields(r)])],
    headerActions: [
      pluginAction("Revoke", "revoke", "Token revoked", {
        confirm: "Revoke this token? Anything using it stops authenticating immediately.",
        destructive: true,
        variant: "danger",
      }),
    ],
  };
}

function renderPermission(r: ResourceInstance): DetailViewSchema {
  const grants = parseJson<Record<string, AccessPermissionResource | undefined>>(
    r.resolvedOutputs[PERMISSION_KEY],
  );
  const sections: SectionNode[] = [section("Permission", [allFields(r)])];
  if (grants) {
    const rows: TableRow[] = [];
    const targetRows: TableRow[] = [];
    for (const [type, res] of Object.entries(grants)) {
      if (!res) continue;
      for (const [who, actions] of Object.entries(res.actions?.users ?? {})) {
        rows.push({
          cells: { resource: type, principal: `user: ${who}`, actions: actions.join(", ") },
        });
      }
      for (const [who, actions] of Object.entries(res.actions?.groups ?? {})) {
        rows.push({
          cells: { resource: type, principal: `group: ${who}`, actions: actions.join(", ") },
        });
      }
      for (const [target, p] of Object.entries(res.targets ?? {})) {
        targetRows.push({
          cells: {
            resource: type,
            target,
            include: (p.include_patterns ?? []).join(", "),
            exclude: (p.exclude_patterns ?? []).join(", "),
          },
        });
      }
    }
    if (targetRows.length > 0) {
      sections.push(
        section("Targets", [
          {
            kind: "table",
            columns: [
              { key: "resource", label: "Resource" },
              { key: "target", label: "Target", mono: true },
              { key: "include", label: "Include", mono: true },
              { key: "exclude", label: "Exclude", mono: true },
            ],
            rows: targetRows,
          },
        ]),
      );
    }
    if (rows.length > 0) {
      sections.push(
        section("Grants", [
          {
            kind: "table",
            columns: [
              { key: "resource", label: "Resource" },
              { key: "principal", label: "Who", width: "wide" },
              { key: "actions", label: "Actions", width: "wide" },
            ],
            rows,
          },
        ]),
      );
    }
  }
  return { title: r.displayName, subtitle: "Permission", sections };
}

function renderSimple(r: ResourceInstance, subtitle: string): DetailViewSchema {
  return { title: r.displayName, subtitle, sections: [section(subtitle, [allFields(r)])] };
}

export function renderJfrogDetail(r: ResourceInstance, baseUrl: string): DetailViewSchema {
  switch (r.resourceTypeId) {
    case "jfrog-platform":
      return withMetricsCapability(renderPlatform(r, baseUrl), RESOURCE_TYPES, r.resourceTypeId);
    case "jfrog-repository":
      return renderRepository(r, baseUrl);
    case "jfrog-build":
      return renderBuild(r, baseUrl);
    case "jfrog-build-run":
      return renderBuildRun(r, baseUrl);
    case "jfrog-xray-watch":
      return renderWatch(r);
    case "jfrog-xray-policy":
      return renderPolicy(r);
    case "jfrog-xray-violation":
      return renderViolation(r);
    case "jfrog-access-token":
      return renderToken(r);
    case "jfrog-permission":
      return renderPermission(r);
    case "jfrog-user": {
      const s = renderSimple(r, "User");
      return {
        ...s,
        subtitle: joinSubtitle(
          "User",
          r.fields["realm"],
          r.fields["admin"] === true ? "admin" : "",
        ),
      };
    }
    case "jfrog-group":
      return renderSimple(r, "Group");
    default:
      return renderSimple(r, "JFrog");
  }
}

export function renderJfrogSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  let status: ResourceStatus | undefined;
  switch (r.resourceTypeId) {
    case "jfrog-xray-watch":
      status = f["active"] === true ? "healthy" : "degraded";
      break;
    case "jfrog-xray-violation":
      status = severityStatus(str(f["severity"]));
      break;
    case "jfrog-repository":
      status = f["blackedOut"] === true ? "degraded" : undefined;
      break;
  }
  return {
    id: r.id,
    label: r.displayName || r.externalId || r.id,
    ...(status ? { status: { kind: "status-dot", status } } : {}),
  };
}
