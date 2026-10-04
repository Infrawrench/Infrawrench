import type {
  CostFetchRange,
  CostFetchResult,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type {
  ConsumptionDay,
  DevinAutomation,
  DevinContext,
  DevinNote,
  DevinOrg,
  DevinPlaybook,
  DevinSecret,
  DevinSelf,
  DevinSession,
  DevinUser,
  UsageMetrics,
} from "./api.js";
import {
  addDays,
  billingDay,
  devinFetch,
  fetchConsumption,
  isPermissionError,
  orgPath,
  paginate,
  resolveOrgs,
} from "./api.js";
import { fetchDevinCostData, splitDay } from "./cost-data.js";
import type { SessionLookups } from "./mappers.js";
import {
  SUMMARY_KEY,
  mapAutomation,
  mapMember,
  mapNote,
  mapOrganization,
  mapPlaybook,
  mapSecret,
  mapSession,
  parseScopedId,
} from "./mappers.js";
import { consumptionAt, orgSeries, playbookSeries, rangeOrDefault } from "./metrics.js";
import { PRODUCT_KEYS, PRODUCT_LABELS, parseAcuPrice, roundMoney } from "./pricing.js";
import type { OrgSummary } from "./render.js";
import { renderDevinDetail, renderDevinSidebar } from "./render.js";

/** Sessions listed per organization: the most recent, newest first. */
export const MAX_SESSIONS = 1000;
const MACRO_PATTERN = /^![A-Za-z0-9_-]+$/;
const SECRET_TYPES = ["key-value", "cookie", "totp"];

const v3beta1Org = (orgId: string, rest = "") =>
  `/v3beta1/organizations/${encodeURIComponent(orgId)}${rest}`;

function sumDays(days: ConsumptionDay[]): number {
  return days.reduce((a, d) => a + (Number.isFinite(d.acus) ? d.acus : 0), 0);
}

const today = () => billingDay(Date.now() / 1000);

/** Fields arrive as strings from the edit and create forms. */
const trimmed = (v: string | undefined) => (v ?? "").trim();
const truthy = (v: string | undefined) =>
  ["true", "yes", "1", "on"].includes(trimmed(v).toLowerCase());

function parseTags(raw: string | undefined): string[] {
  return [
    ...new Set(
      trimmed(raw)
        .split(/[,\n]/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

function parseSchema(raw: string | undefined): Record<string, unknown> | null {
  const text = trimmed(raw);
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Devin plugin: the structured output schema is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Devin plugin: the structured output schema must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function checkMacro(raw: string | undefined): string | null {
  const macro = trimmed(raw);
  if (!macro) return null;
  if (!MACRO_PATTERN.test(macro)) {
    throw new Error(
      `Devin plugin: a macro starts with ! followed by letters, digits, underscores or hyphens (for example !deploy), got "${macro}".`,
    );
  }
  return macro;
}

export class DevinClient implements PluginClient {
  private readonly ctx: DevinContext;
  private readonly acuPrice: number;
  private orgCache: Promise<{ self: DevinSelf; orgs: DevinOrg[] }> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = trimmed(credentials["apiKey"]);
    if (!token) throw new Error("Devin plugin: missing apiKey credential");
    const caCert = credentials["caCert"] ?? "";
    this.ctx = {
      token,
      ...(caCert ? { caCert } : {}),
      ...(services?.http ? { http: services.http } : {}),
    };
    this.acuPrice = parseAcuPrice(credentials);
  }

  private resolved(): Promise<{ self: DevinSelf; orgs: DevinOrg[] }> {
    this.orgCache ??= resolveOrgs(this.ctx).catch((err: unknown) => {
      this.orgCache = undefined;
      throw err;
    });
    return this.orgCache;
  }

  private async orgs(): Promise<DevinOrg[]> {
    return (await this.resolved()).orgs;
  }

  private async org(orgId: string): Promise<DevinOrg> {
    const found = (await this.orgs().catch(() => [] as DevinOrg[])).find((o) => o.org_id === orgId);
    return found ?? { org_id: orgId, name: orgId };
  }

  /** Load `fn` for every org; an org the key cannot read lists empty. */
  private async perOrg<T>(fn: (org: DevinOrg) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (const org of await this.orgs()) {
      try {
        out.push(...(await fn(org)));
      } catch (err) {
        if (!isPermissionError(err)) throw err;
      }
    }
    return out;
  }

  private async lookups(org: DevinOrg): Promise<SessionLookups> {
    const [users, playbooks] = await Promise.all([
      paginate<DevinUser>(this.ctx, v3beta1Org(org.org_id, "/members/users")).catch(() => []),
      paginate<DevinPlaybook>(this.ctx, orgPath(org.org_id, "/playbooks")).catch(() => []),
    ]);
    return {
      users: new Map(users.map((u) => [u.user_id, u])),
      playbooks: new Map(playbooks.map((p) => [p.playbook_id, p])),
    };
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return (await this.orgs()).map((o) => mapOrganization(accountId, o));
      case "session":
        return this.perOrg(async (org) => {
          const [sessions, lookups] = await Promise.all([
            paginate<DevinSession>(this.ctx, orgPath(org.org_id, "/sessions"), {}, MAX_SESSIONS),
            this.lookups(org),
          ]);
          return sessions.map((s) => mapSession(accountId, org, s, this.acuPrice, lookups));
        });
      case "playbook":
        return this.perOrg(async (org) =>
          (await paginate<DevinPlaybook>(this.ctx, orgPath(org.org_id, "/playbooks"))).map((p) =>
            mapPlaybook(accountId, org, p),
          ),
        );
      case "knowledge-note":
        return this.perOrg(async (org) =>
          (await paginate<DevinNote>(this.ctx, orgPath(org.org_id, "/knowledge/notes"))).map((n) =>
            mapNote(accountId, org, n),
          ),
        );
      case "secret":
        return this.perOrg(async (org) =>
          (await paginate<DevinSecret>(this.ctx, orgPath(org.org_id, "/secrets"))).map((s) =>
            mapSecret(accountId, org, s),
          ),
        );
      case "member":
        return this.perOrg(async (org) =>
          (await paginate<DevinUser>(this.ctx, v3beta1Org(org.org_id, "/members/users"))).map((u) =>
            mapMember(accountId, org, u),
          ),
        );
      case "automation":
        return this.perOrg(async (org) =>
          (await paginate<DevinAutomation>(this.ctx, orgPath(org.org_id, "/automations"))).map(
            (a) => mapAutomation(accountId, org, a),
          ),
        );
      default:
        throw new Error(`Devin plugin: unknown resource type "${typeId}"`);
    }
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === "organization") return this.getOrganization(accountId, externalId);
    const { orgId, id } = parseScopedId(externalId);
    const org = await this.org(orgId);
    const enc = encodeURIComponent(id);
    switch (typeId) {
      case "session": {
        const [s, lookups] = await Promise.all([
          devinFetch<DevinSession>(this.ctx, orgPath(orgId, `/sessions/${enc}`)),
          this.lookups(org),
        ]);
        return mapSession(accountId, org, s, this.acuPrice, lookups);
      }
      case "playbook": {
        const p = await devinFetch<DevinPlaybook>(this.ctx, orgPath(orgId, `/playbooks/${enc}`));
        const r = mapPlaybook(accountId, org, p);
        const stats = await this.playbookStats(orgId, id).catch(() => undefined);
        return stats
          ? {
              ...r,
              resolvedOutputs: { ...r.resolvedOutputs, [SUMMARY_KEY]: JSON.stringify(stats) },
            }
          : r;
      }
      case "knowledge-note":
        return mapNote(
          accountId,
          org,
          await devinFetch<DevinNote>(this.ctx, orgPath(orgId, `/knowledge/notes/${enc}`)),
        );
      case "secret": {
        const all = await paginate<DevinSecret>(this.ctx, orgPath(orgId, "/secrets"));
        const s = all.find((x) => x.secret_id === id);
        if (!s) throw new Error(`Devin plugin: secret ${id} not found`);
        return mapSecret(accountId, org, s);
      }
      case "member": {
        const u = await devinFetch<DevinUser>(this.ctx, v3beta1Org(orgId, `/members/users/${enc}`));
        const to = today();
        const days = await fetchConsumption(
          this.ctx,
          orgPath(orgId, `/consumption/daily/users/${enc}`),
          addDays(to, -29),
          to,
        ).catch(() => undefined);
        const acus = days ? sumDays(days) : undefined;
        return mapMember(
          accountId,
          org,
          u,
          acus !== undefined ? { acus, cost: roundMoney(acus * this.acuPrice) } : undefined,
        );
      }
      case "automation":
        return mapAutomation(
          accountId,
          org,
          await devinFetch<DevinAutomation>(this.ctx, orgPath(orgId, `/automations/${enc}`)),
        );
      default:
        throw new Error(`Devin plugin: unknown resource type "${typeId}"`);
    }
  }

  private async getOrganization(accountId: string, orgId: string): Promise<ResourceInstance> {
    const org = await this.org(orgId);
    const to = today();
    const from = `${to.slice(0, 7)}-01`;
    const [days, usage] = await Promise.all([
      fetchConsumption(this.ctx, orgPath(orgId, "/consumption/daily"), from, to).catch(
        () => undefined,
      ),
      devinFetch<UsageMetrics>(this.ctx, orgPath(orgId, "/metrics/usage"), {
        query: {
          time_after: Math.floor(Date.parse(`${from}T08:00:00Z`) / 1000),
          time_before: Math.ceil(Date.now() / 1000),
        },
      }).catch(() => undefined),
    ]);
    if (!days) return mapOrganization(accountId, org);
    const totals = Object.fromEntries(PRODUCT_KEYS.map((k) => [k, 0])) as Record<string, number>;
    for (const d of days) {
      const split = splitDay(d);
      for (const k of PRODUCT_KEYS) totals[k]! += split[k];
    }
    const totalAcus = sumDays(days);
    const summary: OrgSummary = {
      month: from.slice(0, 7),
      totalAcus,
      totalCost: roundMoney(totalAcus * this.acuPrice),
      byProduct: PRODUCT_KEYS.filter((k) => (totals[k] ?? 0) > 0).map((k) => ({
        product: PRODUCT_LABELS[k],
        acus: totals[k]!,
        cost: roundMoney(totals[k]! * this.acuPrice),
      })),
      ...(usage
        ? {
            usage: {
              sessions: usage.sessions_count,
              prs_created: usage.prs_created_count,
              prs_merged: usage.prs_merged_count,
              searches: usage.searches_count,
            },
          }
        : {}),
    };
    const r = mapOrganization(accountId, org, { acus: totalAcus, cost: summary.totalCost });
    return {
      ...r,
      resolvedOutputs: { ...r.resolvedOutputs, [SUMMARY_KEY]: JSON.stringify(summary) },
    };
  }

  private async playbookStats(orgId: string, playbookId: string) {
    const query = {
      playbook_id: playbookId,
      time_after: Math.floor(Date.now() / 1000) - 30 * 86_400,
      time_before: Math.ceil(Date.now() / 1000),
    };
    const [sessions, prs] = await Promise.all([
      devinFetch<{ sessions_created_count?: number }>(
        this.ctx,
        orgPath(orgId, "/metrics/sessions"),
        {
          query,
        },
      ),
      devinFetch<{ prs_merged_count?: number }>(this.ctx, orgPath(orgId, "/metrics/prs"), {
        query,
      }),
    ]);
    return { sessions: sessions?.sessions_created_count, prsMerged: prs?.prs_merged_count };
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Devin plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics and costs
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (
      resourceTypeId !== "organization" &&
      resourceTypeId !== "session" &&
      resourceTypeId !== "member"
    ) {
      return [];
    }
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const money = (v: unknown) =>
      typeof v === "number" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—";
    const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
    if (resourceTypeId === "organization") {
      return [
        { label: "ACUs this month", value: num(f["monthAcus"]) },
        { label: "Estimated this month", value: money(f["monthCost"]) },
      ];
    }
    if (resourceTypeId === "member") {
      return [
        { label: "ACUs (30 days)", value: num(f["acus30d"]) },
        { label: "Estimated (30 days)", value: money(f["cost30d"]) },
      ];
    }
    const status = String(f["status"] ?? "");
    return [
      {
        label: "Status",
        value: status || "—",
        variant:
          status === "running" ? "status-healthy" : status === "error" ? "status-error" : "default",
      },
      { label: "ACUs", value: num(f["acus"]) },
      { label: "Estimated", value: money(f["estimatedCost"]) },
      { label: "PRs", value: num(f["pullRequests"]) },
    ];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const externalId = externalIdOf(resourceId);
    const range = rangeOrDefault(timeRange);
    if (resourceTypeId === "organization") {
      return orgSeries(this.ctx, externalId, this.acuPrice, range);
    }
    const { orgId, id } = parseScopedId(externalId);
    const enc = encodeURIComponent(id);
    switch (resourceTypeId) {
      case "session":
        return consumptionAt(
          this.ctx,
          orgPath(orgId, `/consumption/daily/sessions/${enc}`),
          this.acuPrice,
          range,
        );
      case "member":
        return consumptionAt(
          this.ctx,
          orgPath(orgId, `/consumption/daily/users/${enc}`),
          this.acuPrice,
          range,
        );
      case "playbook":
        return playbookSeries(this.ctx, orgId, id, range);
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostFetchResult> {
    const { self, orgs } = await this.resolved();
    return fetchDevinCostData(this.ctx, orgs, self, this.acuPrice, range);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async orgField(): Promise<CreateResourceConfig["fields"]> {
    const orgs = await this.orgs().catch(() => [] as DevinOrg[]);
    if (orgs.length <= 1) return [];
    return [
      {
        key: "orgId",
        label: "Organization",
        kind: "select",
        required: true,
        defaultValue: orgs[0]!.org_id,
        options: orgs.map((o) => ({
          id: o.org_id,
          label: o.name || o.org_id,
          description: o.org_id,
        })),
      },
    ];
  }

  private async targetOrg(fields: Record<string, string>): Promise<DevinOrg> {
    const orgs = await this.orgs();
    const wanted = trimmed(fields["orgId"]);
    const org = wanted ? orgs.find((o) => o.org_id === wanted) : orgs[0];
    if (!org) throw new Error("Devin plugin: pick an organization");
    return org;
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    const orgField = await this.orgField();
    switch (typeId) {
      case "playbook":
        return {
          fields: [
            ...orgField,
            {
              key: "title",
              label: "Title",
              kind: "text",
              required: true,
              placeholder: "Upgrade a dependency",
            },
            {
              key: "macro",
              label: "Macro",
              kind: "text",
              required: false,
              placeholder: "!upgrade",
              description: "Typed in a prompt to invoke the playbook. Starts with !.",
            },
            {
              key: "body",
              label: "Instructions",
              kind: "text",
              multiline: true,
              required: true,
              description: "What Devin should do when it runs this playbook, in Markdown.",
            },
            {
              key: "structuredOutputSchema",
              label: "Structured output schema",
              kind: "json-schema",
              required: false,
              description:
                "Optional. The shape of the structured output sessions running this playbook produce.",
            },
          ],
        };
      case "knowledge-note":
        return {
          fields: [
            ...orgField,
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "trigger",
              label: "Trigger",
              kind: "text",
              required: true,
              placeholder: "When working on the billing service",
              description: "When Devin should recall this note, in plain language.",
            },
            { key: "body", label: "Content", kind: "text", multiline: true, required: true },
            {
              key: "pinnedRepo",
              label: "Pinned repository",
              kind: "text",
              required: false,
              placeholder: "owner/repo",
              description: "Only recall this note in one repository. Leave blank for all.",
            },
          ],
        };
      case "secret":
        return {
          fields: [
            ...orgField,
            {
              key: "secretType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "key-value",
              options: [
                {
                  id: "key-value",
                  label: "Key and value",
                  description: "An API key, token or password",
                },
                {
                  id: "cookie",
                  label: "Site cookie",
                  description: "A browser cookie Devin signs in with",
                },
                { id: "totp", label: "TOTP seed", description: "Generates one-time codes for 2FA" },
              ],
            },
            {
              key: "key",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "STRIPE_API_KEY",
            },
            { key: "value", label: "Value", kind: "password", required: true },
            { key: "note", label: "Note", kind: "text", required: false },
            {
              key: "sensitive",
              label: "Sensitive",
              kind: "select",
              required: true,
              defaultValue: "true",
              description: "Sensitive secrets are redacted from Devin's session output.",
              options: [
                { id: "true", label: "Yes" },
                { id: "false", label: "No" },
              ],
            },
          ],
        };
      default:
        throw new Error(`Devin plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const org = await this.targetOrg(fields);
    switch (typeId) {
      case "playbook": {
        const title = trimmed(fields["title"]);
        const body = fields["body"] ?? "";
        if (!title || !body.trim())
          throw new Error("Devin plugin: a playbook needs a title and instructions");
        const p = await devinFetch<DevinPlaybook>(this.ctx, orgPath(org.org_id, "/playbooks"), {
          method: "POST",
          body: {
            title,
            body,
            macro: checkMacro(fields["macro"]),
            structured_output_schema: parseSchema(fields["structuredOutputSchema"]),
          },
        });
        return mapPlaybook(accountId, org, p);
      }
      case "knowledge-note": {
        const name = trimmed(fields["name"]);
        const trigger = trimmed(fields["trigger"]);
        const body = fields["body"] ?? "";
        if (!name || !trigger || !body.trim()) {
          throw new Error("Devin plugin: a note needs a name, a trigger and content");
        }
        const n = await devinFetch<DevinNote>(this.ctx, orgPath(org.org_id, "/knowledge/notes"), {
          method: "POST",
          body: { name, trigger, body, pinned_repo: trimmed(fields["pinnedRepo"]) || null },
        });
        return mapNote(accountId, org, n);
      }
      case "secret": {
        const key = trimmed(fields["key"]);
        const value = fields["value"] ?? "";
        const type = SECRET_TYPES.includes(trimmed(fields["secretType"]))
          ? trimmed(fields["secretType"])
          : "key-value";
        if (!key || !value) throw new Error("Devin plugin: a secret needs a name and a value");
        const s = await devinFetch<DevinSecret>(this.ctx, orgPath(org.org_id, "/secrets"), {
          method: "POST",
          body: {
            type,
            key,
            value,
            is_sensitive: fields["sensitive"] === undefined ? true : truthy(fields["sensitive"]),
            note: trimmed(fields["note"]) || null,
          },
        });
        return mapSecret(accountId, org, s);
      }
      default:
        throw new Error(`Devin plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const { orgId, id } = parseScopedId(externalIdOf(resourceId));
    const enc = encodeURIComponent(id);
    switch (typeId) {
      case "session": {
        if ("tags" in fields) {
          await devinFetch(this.ctx, orgPath(orgId, `/sessions/${enc}/tags`), {
            method: "PUT",
            body: { tags: parseTags(fields["tags"]) },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "playbook": {
        // PUT replaces the playbook, so unchanged fields are sent back as they are.
        const current = await devinFetch<DevinPlaybook>(
          this.ctx,
          orgPath(orgId, `/playbooks/${enc}`),
        );
        const title = "title" in fields ? trimmed(fields["title"]) : (current.title ?? "");
        const body = "body" in fields ? (fields["body"] ?? "") : (current.body ?? "");
        if (!title || !body.trim())
          throw new Error("Devin plugin: a playbook needs a title and instructions");
        await devinFetch(this.ctx, orgPath(orgId, `/playbooks/${enc}`), {
          method: "PUT",
          body: {
            title,
            body,
            macro: "macro" in fields ? checkMacro(fields["macro"]) : (current.macro ?? null),
            structured_output_schema:
              "structuredOutputSchema" in fields
                ? parseSchema(fields["structuredOutputSchema"])
                : (current.structured_output_schema ?? null),
          },
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      case "knowledge-note": {
        const current = await devinFetch<DevinNote>(
          this.ctx,
          orgPath(orgId, `/knowledge/notes/${enc}`),
        );
        await this.putNote(orgId, id, current, {
          ...("name" in fields ? { name: trimmed(fields["name"]) } : {}),
          ...("trigger" in fields ? { trigger: trimmed(fields["trigger"]) } : {}),
          ...("body" in fields ? { body: fields["body"] ?? "" } : {}),
          ...("enabled" in fields ? { is_enabled: truthy(fields["enabled"]) } : {}),
          ...("pinnedRepo" in fields ? { pinned_repo: trimmed(fields["pinnedRepo"]) || null } : {}),
        });
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Devin plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
  }

  /** PUT a note back with `changes` applied; the endpoint replaces the whole note. */
  private async putNote(
    orgId: string,
    noteId: string,
    current: DevinNote,
    changes: Partial<DevinNote>,
  ) {
    const next = { ...current, ...changes };
    if (!next.name || !next.trigger || !(next.body ?? "").trim()) {
      throw new Error("Devin plugin: a note needs a name, a trigger and content");
    }
    await devinFetch(this.ctx, orgPath(orgId, `/knowledge/notes/${encodeURIComponent(noteId)}`), {
      method: "PUT",
      body: {
        name: next.name,
        trigger: next.trigger,
        body: next.body,
        pinned_repo: next.pinned_repo ?? null,
        folder_id: next.folder_id ?? null,
        is_enabled: next.is_enabled ?? true,
      },
    });
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const { orgId, id } = parseScopedId(externalIdOf(resourceId));
    const enc = encodeURIComponent(id);
    const paths: Record<string, string> = {
      playbook: `/playbooks/${enc}`,
      "knowledge-note": `/knowledge/notes/${enc}`,
      secret: `/secrets/${enc}`,
      automation: `/automations/${enc}`,
    };
    const path = paths[typeId];
    if (!path) throw new Error(`Devin plugin: "${typeId}" cannot be deleted from Infrawrench`);
    await devinFetch(this.ctx, orgPath(orgId, path), { method: "DELETE" });
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const { orgId, id } = parseScopedId(externalIdOf(resourceId));
    const enc = encodeURIComponent(id);
    if (typeId === "session") {
      if (actionId === "terminate") {
        await devinFetch(this.ctx, orgPath(orgId, `/sessions/${enc}`), { method: "DELETE" });
        return;
      }
      if (actionId === "archive" || actionId === "unarchive") {
        await devinFetch(this.ctx, orgPath(orgId, `/sessions/${enc}/${actionId}`), {
          method: "POST",
        });
        return;
      }
    }
    if (typeId === "automation" && (actionId === "enable" || actionId === "disable")) {
      await devinFetch(this.ctx, orgPath(orgId, `/automations/${enc}`), {
        method: "PATCH",
        body: { enabled: actionId === "enable" },
      });
      return;
    }
    if (typeId === "knowledge-note" && (actionId === "enable" || actionId === "disable")) {
      const current = await devinFetch<DevinNote>(
        this.ctx,
        orgPath(orgId, `/knowledge/notes/${enc}`),
      );
      await this.putNote(orgId, id, current, { is_enabled: actionId === "enable" });
      return;
    }
    throw new Error(`Devin plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderDevinDetail(resource, this.acuPrice);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderDevinSidebar(resource);
  }
}
