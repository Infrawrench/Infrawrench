import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  CreditBalance,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
  SelectOption,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { CreditAccessError } from "@infrawrench/plugin-base";
import { HerokuApi } from "./api.js";
import { fetchHerokuCostData } from "./cost-data.js";
import {
  cached,
  enc,
  externalOf,
  isStatus,
  mapLimit,
  parseFormArg,
  parseScopedId,
  str,
  type Cached,
} from "./kit.js";
import { fetchHerokuLogs } from "./logs.js";
import {
  mapAddon,
  mapApp,
  mapConfigVar,
  mapCoupling,
  mapDomain,
  mapDyno,
  mapFormation,
  mapLogDrain,
  mapPipeline,
  mapRelease,
  mapReviewApp,
  mapSniEndpoint,
  mapSpace,
  mapTeam,
} from "./mappers.js";
import { ENRICH, renderHerokuDetail, renderHerokuSidebarItem } from "./render.js";
import { REGIONS } from "./resource-types.js";
import type {
  HkAddon,
  HkApp,
  HkCoupling,
  HkCredit,
  HkDomain,
  HkDyno,
  HkDynoSize,
  HkFormation,
  HkLogDrain,
  HkPipeline,
  HkRegion,
  HkRelease,
  HkReviewApp,
  HkReviewAppConfig,
  HkSniEndpoint,
  HkSpace,
  HkStack,
  HkTeam,
} from "./types.js";

const LIST_TTL_MS = 60_000;
const FAN_OUT = 6;
const RELEASES_PER_APP = 10;

/** First-party add-on services offered with a plan picker on create. */
export const FEATURED_SERVICES = ["heroku-postgresql", "heroku-redis", "heroku-kafka", "scheduler"];

/**
 * Heroku plugin client. One per account (one API key, optionally narrowed to
 * a team). App children are listed per app with bounded fan-out; apps and
 * add-ons are cached for a minute so one sync pass lists them once.
 */
export class HerokuClient implements PluginClient {
  readonly api: HerokuApi;
  private readonly team: string;
  private readonly resourceTypes: ResourceTypeDefinition[];
  private appsCache: Cached<HkApp[]> | undefined;
  private addonsCache: Cached<HkAddon[]> | undefined;
  private teamsCache: Cached<HkTeam[]> | undefined;

  constructor(
    credentials: Record<string, string>,
    resourceTypes: ResourceTypeDefinition[],
    services?: HostServices,
  ) {
    const apiKey = str(credentials["apiKey"]);
    if (!apiKey) throw new Error("Heroku plugin: missing apiKey credential");
    this.team = str(credentials["team"]);
    this.api = new HerokuApi(apiKey, credentials["caCert"] ?? "", services);
    this.resourceTypes = resourceTypes;
  }

  // ── Discovery ────────────────────────────────────────────────────────

  apps(): Promise<HkApp[]> {
    this.appsCache = cached(this.appsCache, LIST_TTL_MS, () =>
      this.api.listAll<HkApp>(this.team ? `/teams/${enc(this.team)}/apps` : "/apps"),
    );
    return this.appsCache.value;
  }

  addons(): Promise<HkAddon[]> {
    this.addonsCache = cached(this.addonsCache, LIST_TTL_MS, () =>
      this.api.listAll<HkAddon>(this.team ? `/teams/${enc(this.team)}/addons` : "/addons"),
    );
    return this.addonsCache.value;
  }

  teams(): Promise<HkTeam[]> {
    this.teamsCache = cached(this.teamsCache, LIST_TTL_MS, async () => {
      const all = await this.api.listAll<HkTeam>("/teams");
      return this.team ? all.filter((t) => t.id === this.team || t.name === this.team) : all;
    });
    return this.teamsCache.value;
  }

  private invalidate(): void {
    this.appsCache = undefined;
    this.addonsCache = undefined;
  }

  private async appRef(appId: string): Promise<{ id: string; name: string }> {
    const known = (await this.apps().catch(() => [] as HkApp[])).find((a) => a.id === appId);
    if (known) return { id: known.id, name: known.name };
    const a = await this.api.request<HkApp>(`/apps/${enc(appId)}`);
    return { id: a.id, name: a.name };
  }

  private async perApp(
    load: (app: HkApp) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const lists = await mapLimit(await this.apps(), FAN_OUT, async (a) => {
      try {
        return await load(a);
      } catch (e) {
        if (isStatus(e, 403, 404)) return [];
        throw e;
      }
    });
    return lists.flat();
  }

  private async pipelines(): Promise<HkPipeline[]> {
    const all = await this.api.listAll<HkPipeline>("/pipelines");
    if (!this.team) return all;
    const teamIds = new Set((await this.teams()).map((t) => t.id));
    return all.filter((p) => p.owner?.type === "team" && teamIds.has(p.owner.id));
  }

  private async perPipeline(
    load: (p: HkPipeline) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const lists = await mapLimit(await this.pipelines(), FAN_OUT, async (p) => {
      try {
        return await load(p);
      } catch (e) {
        if (isStatus(e, 403, 404)) return [];
        throw e;
      }
    });
    return lists.flat();
  }

  // ── Listing ──────────────────────────────────────────────────────────

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "team":
        return (await this.teams()).map((t) => mapTeam(t, accountId));
      case "app":
        return (await this.apps()).map((a) => mapApp(a, accountId));
      case "formation":
        return this.perApp(async (a) =>
          (await this.api.listAll<HkFormation>(`/apps/${enc(a.id)}/formation`)).map((fm) =>
            mapFormation(fm, a, accountId),
          ),
        );
      case "dyno":
        return this.perApp(async (a) =>
          (await this.api.listAll<HkDyno>(`/apps/${enc(a.id)}/dynos`)).map((d) =>
            mapDyno(d, a, accountId),
          ),
        );
      case "release":
        return this.perApp(async (a) =>
          (await this.recentReleases(a.id, RELEASES_PER_APP)).map((r) =>
            mapRelease(r, a, accountId),
          ),
        );
      case "config-var": {
        const addons = await this.addons().catch(() => [] as HkAddon[]);
        return this.perApp(async (a) => {
          const vars = await this.api.request<Record<string, string | null>>(
            `/apps/${enc(a.id)}/config-vars`,
          );
          const fromAddon = new Map<string, string>();
          for (const ad of addons) {
            if (ad.app?.id !== a.id) continue;
            for (const v of ad.config_vars ?? []) fromAddon.set(v, ad.name);
          }
          return Object.keys(vars ?? {}).map((k) => mapConfigVar(k, a, fromAddon, accountId));
        });
      }
      case "add-on":
        return (await this.addons()).map((ad) => mapAddon(ad, accountId));
      case "domain":
        return this.perApp(async (a) =>
          (await this.api.listAll<HkDomain>(`/apps/${enc(a.id)}/domains`)).map((d) =>
            mapDomain(d, a, accountId),
          ),
        );
      case "sni-endpoint":
        return this.perApp(async (a) =>
          (await this.api.listAll<HkSniEndpoint>(`/apps/${enc(a.id)}/sni-endpoints`)).map((s) =>
            mapSniEndpoint(s, a, accountId),
          ),
        );
      case "log-drain":
        return this.perApp(async (a) =>
          (await this.api.listAll<HkLogDrain>(`/apps/${enc(a.id)}/log-drains`)).map((d) =>
            mapLogDrain(d, a, accountId),
          ),
        );
      case "pipeline":
        return this.perPipeline(async (p) => {
          const [couplings, review] = await Promise.all([
            this.api
              .listAll<HkCoupling>(`/pipelines/${enc(p.id)}/pipeline-couplings`)
              .catch(() => []),
            this.api
              .request<HkReviewAppConfig>(`/pipelines/${enc(p.id)}/review-app-config`)
              .catch(() => null),
          ]);
          return [
            mapPipeline(
              p,
              couplings.length,
              review ? review.automatic_review_apps === true : undefined,
              accountId,
            ),
          ];
        });
      case "pipeline-coupling": {
        const names = new Map(
          (await this.apps().catch(() => [] as HkApp[])).map((a) => [a.id, a.name]),
        );
        return this.perPipeline(async (p) =>
          (await this.api.listAll<HkCoupling>(`/pipelines/${enc(p.id)}/pipeline-couplings`)).map(
            (c) => mapCoupling(c, p, names, accountId),
          ),
        );
      }
      case "review-app":
        return this.perPipeline(async (p) =>
          (await this.api.listAll<HkReviewApp>(`/pipelines/${enc(p.id)}/review-apps`)).map((r) =>
            mapReviewApp(r, p.id, accountId),
          ),
        );
      case "space": {
        const spaces = await this.api.listAll<HkSpace>("/spaces");
        const teamIds = this.team ? new Set((await this.teams()).map((t) => t.id)) : null;
        return spaces
          .filter((s) => !teamIds || (s.team?.id && teamIds.has(s.team.id)))
          .map((s) => mapSpace(s, accountId));
      }
      default:
        throw new Error(`Heroku plugin: unknown resource type "${typeId}"`);
    }
  }

  /** Newest releases first: a descending Range on `version`. */
  private async recentReleases(appId: string, max: number): Promise<HkRelease[]> {
    const rows = await this.api.request<HkRelease[]>(`/apps/${enc(appId)}/releases`, {
      headers: { Range: `version ..; order=desc, max=${max};` },
    });
    return Array.isArray(rows) ? rows : [];
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    switch (typeId) {
      case "app":
        return mapApp(await this.api.request<HkApp>(`/apps/${enc(id)}`), accountId);
      case "add-on":
        return mapAddon(await this.api.request<HkAddon>(`/addons/${enc(id)}`), accountId);
      case "pipeline": {
        const p = await this.api.request<HkPipeline>(`/pipelines/${enc(id)}`);
        const couplings = await this.api
          .listAll<HkCoupling>(`/pipelines/${enc(id)}/pipeline-couplings`)
          .catch(() => []);
        return mapPipeline(p, couplings.length, undefined, accountId);
      }
      case "space":
        return mapSpace(await this.api.request<HkSpace>(`/spaces/${enc(id)}`), accountId);
      case "formation":
      case "dyno":
      case "release":
      case "domain":
      case "sni-endpoint": {
        const { scope: appId, id: childId } = parseScopedId(id);
        const app = await this.appRef(appId);
        const path = {
          formation: `formation/${enc(childId)}`,
          dyno: `dynos/${enc(childId)}`,
          release: `releases/${enc(childId)}`,
          domain: `domains/${enc(childId)}`,
          "sni-endpoint": `sni-endpoints/${enc(childId)}`,
        }[typeId];
        const body = await this.api.request<unknown>(`/apps/${enc(appId)}/${path}`);
        if (typeId === "formation") return mapFormation(body as HkFormation, app, accountId);
        if (typeId === "dyno") return mapDyno(body as HkDyno, app, accountId);
        if (typeId === "release") return mapRelease(body as HkRelease, app, accountId);
        if (typeId === "domain") return mapDomain(body as HkDomain, app, accountId);
        return mapSniEndpoint(body as HkSniEndpoint, app, accountId);
      }
      case "config-var": {
        const { scope: appId, id: key } = parseScopedId(id);
        const app = await this.appRef(appId);
        const vars = await this.api.request<Record<string, string | null>>(
          `/apps/${enc(appId)}/config-vars`,
        );
        if (!vars || !(key in vars))
          throw Object.assign(new Error(`Heroku plugin: config var ${key} not found`), {
            status: 404,
          });
        return mapConfigVar(key, app, new Map(), accountId);
      }
      default: {
        const all = await this.listResources(typeId, accountId);
        const found = all.find((r) => r.id === resourceId || r.externalId === id);
        if (!found)
          throw Object.assign(new Error(`Heroku plugin: ${typeId} ${id} not found`), {
            status: 404,
          });
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "config-var" && outputKey === "value") {
      const { scope: appId, id: key } = parseScopedId(externalOf(resourceId));
      const vars = await this.api.request<Record<string, string | null>>(
        `/apps/${enc(appId)}/config-vars`,
      );
      return vars?.[key] ?? "";
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    return r.resolvedOutputs[outputKey] ?? String(r.fields[outputKey] ?? "");
  }

  // ── Detail ───────────────────────────────────────────────────────────

  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = resource.externalId ?? externalOf(resource.id);
    const extra: Record<string, string> = {};
    const stash = async (key: string, load: () => Promise<unknown>) => {
      try {
        const v = await load();
        if (v !== undefined && v !== null) extra[key] = JSON.stringify(v);
      } catch {
        /* optional panel */
      }
    };
    switch (resource.resourceTypeId) {
      case "app":
        await Promise.all([
          stash(ENRICH.releases, () => this.recentReleases(id, 20)),
          stash(ENRICH.formation, async () =>
            (await this.api.listAll<HkFormation>(`/apps/${enc(id)}/formation`)).map((fm) => ({
              type: fm.type,
              quantity: fm.quantity,
              size: fm.dyno_size?.name ?? fm.size,
              command: fm.command,
            })),
          ),
          stash(ENRICH.sizes, async () =>
            (await this.api.listAll<HkDynoSize>(`/apps/${enc(id)}/available-dyno-sizes`)).map(
              (s) => ({ name: s.name }),
            ),
          ),
        ]);
        break;
      case "add-on": {
        const service = String(resource.fields["service"] ?? "");
        if (service) {
          await stash(ENRICH.plans, async () =>
            (
              await this.api.listAll<{
                name: string;
                human_name?: string;
                price?: unknown;
                visible?: boolean;
              }>(`/addon-services/${enc(service)}/plans`)
            )
              .filter((p) => p.visible !== false)
              .map((p) => ({ name: p.name, human_name: p.human_name, price: p.price })),
          );
        }
        break;
      }
      case "pipeline": {
        const names = new Map(
          (await this.apps().catch(() => [] as HkApp[])).map((a) => [a.id, a.name]),
        );
        await Promise.all([
          stash(ENRICH.couplings, async () =>
            (await this.api.listAll<HkCoupling>(`/pipelines/${enc(id)}/pipeline-couplings`)).map(
              (c) => ({
                appId: c.app.id,
                appName: names.get(c.app.id) ?? c.app.id,
                stage: c.stage,
              }),
            ),
          ),
          stash(ENRICH.reviewConfig, () =>
            this.api.request(`/pipelines/${enc(id)}/review-app-config`),
          ),
        ]);
        break;
      }
      case "team":
        await stash(ENRICH.members, () => this.api.listAll(`/teams/${enc(id)}/members`));
        break;
      default:
        return resource;
    }
    return { ...resource, fields: { ...resource.fields, ...extra } };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderHerokuDetail(resource, this.resourceTypes);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderHerokuSidebarItem(resource);
  }

  // ── Create ───────────────────────────────────────────────────────────

  private async appPicker(
    parentResourceId: string | undefined,
    label = "App",
  ): Promise<CreateFieldConfig[]> {
    if (parentResourceId?.includes(":app:")) return [];
    const options = (await this.apps().catch(() => [] as HkApp[])).map((a) => ({
      id: a.id,
      label: a.name,
      ...(a.team?.name ? { description: a.team.name } : {}),
    }));
    return [
      {
        key: "appId",
        label,
        kind: "select",
        required: true,
        options,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
      },
    ];
  }

  private appIdFrom(fields: Record<string, string>, parentResourceId?: string): string {
    const id =
      str(fields["appId"]) ||
      (parentResourceId?.includes(":app:") ? externalOf(parentResourceId) : "");
    if (!id) throw new Error("Heroku plugin: choose an app");
    return id;
  }

  private async regionOptions(privateOnly: boolean) {
    try {
      const regions = await this.api.listAll<HkRegion>("/regions");
      const list = regions
        .filter((r) =>
          privateOnly
            ? r.private_capable
            : !r.private_capable || r.name === "us" || r.name === "eu",
        )
        .map((r) => {
          const known = REGIONS.find((k) => k.id === r.name);
          return {
            id: r.name,
            label: known?.label ?? r.name,
            location: r.description ?? known?.location ?? "",
            ...(known ? { flag: known.flag } : {}),
          };
        });
      if (list.length) return list;
    } catch {
      /* fall back to the documented list */
    }
    return REGIONS.filter((r) =>
      privateOnly ? r.location === "Private Spaces" : r.location === "Common Runtime",
    );
  }

  private async teamOptions(withPersonal: boolean): Promise<SelectOption[]> {
    const teams = await this.teams().catch(() => [] as HkTeam[]);
    return [
      ...(withPersonal && !this.team ? [{ id: "", label: "Personal account" }] : []),
      ...teams.map((t) => ({ id: t.name, label: t.name })),
    ];
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "app": {
        const [regions, stacks, teams, spaces] = await Promise.all([
          this.regionOptions(false),
          this.api.listAll<HkStack>("/stacks").catch(() => [] as HkStack[]),
          this.teamOptions(true),
          this.api.listAll<HkSpace>("/spaces").catch(() => [] as HkSpace[]),
        ]);
        const liveStacks = stacks.filter((s) => s.state !== "deprecated" && s.state !== "retired");
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: false,
              description:
                "Lowercase letters, digits and dashes. Leave blank for a generated name.",
            },
            ...(teams.length > 1 || this.team
              ? [
                  {
                    key: "team",
                    label: "Owner",
                    kind: "select" as const,
                    required: false,
                    defaultValue: teams[0]?.id ?? "",
                    options: teams,
                  },
                ]
              : []),
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: false,
              defaultValue: "us",
              regions,
            },
            ...(spaces.length
              ? [
                  {
                    key: "space",
                    label: "Private Space",
                    kind: "select" as const,
                    required: false,
                    defaultValue: "",
                    description: "Run in a team's Private Space instead of the Common Runtime.",
                    options: [
                      { id: "", label: "Common Runtime" },
                      ...spaces.map((s) => ({
                        id: s.name,
                        label: s.name,
                        description: s.region?.name ?? "",
                      })),
                    ],
                  },
                ]
              : []),
            ...(liveStacks.length
              ? [
                  {
                    key: "stack",
                    label: "Stack",
                    kind: "select" as const,
                    required: false,
                    defaultValue: liveStacks.find((s) => s.default)?.name ?? "",
                    options: [
                      { id: "", label: "Default" },
                      ...liveStacks.map((s) => ({ id: s.name, label: s.name })),
                    ],
                  },
                ]
              : []),
          ],
        };
      }
      case "config-var":
        return {
          fields: [
            ...(await this.appPicker(parentResourceId)),
            { key: "key", label: "Key", kind: "text", required: true, placeholder: "DATABASE_URL" },
            { key: "value", label: "Value", kind: "password", required: true },
          ],
        };
      case "add-on": {
        const plans = (
          await Promise.all(
            FEATURED_SERVICES.map((svc) =>
              this.api
                .listAll<{
                  name: string;
                  human_name?: string;
                  price?: { cents?: number; unit?: string };
                  visible?: boolean;
                }>(`/addon-services/${enc(svc)}/plans`)
                .catch(() => []),
            ),
          )
        )
          .flat()
          .filter((p) => p.visible !== false);
        return {
          fields: [
            ...(await this.appPicker(undefined, "Attach To")),
            {
              key: "plan",
              label: "Plan",
              kind: "select",
              required: false,
              defaultValue: plans[0]?.name ?? "",
              options: [
                ...plans.map((p) => ({
                  id: p.name,
                  label: p.human_name ? `${p.name.split(":")[0]}: ${p.human_name}` : p.name,
                  ...(p.price?.cents !== undefined
                    ? {
                        description: `$${(p.price.cents / 100).toFixed(2)} / ${p.price.unit ?? "month"}`,
                      }
                    : {}),
                })),
                { id: "", label: "Another add-on…" },
              ],
            },
            {
              key: "otherPlan",
              label: "Add-on Plan",
              kind: "text",
              required: false,
              placeholder: "papertrail:choklad",
              description:
                "service:plan from the Elements Marketplace, used when Plan is Another add-on.",
              showWhen: { fieldKey: "plan", fieldValue: "" },
            },
            { key: "name", label: "Name", kind: "text", required: false },
          ],
        };
      }
      case "domain": {
        return {
          fields: [
            ...(await this.appPicker(parentResourceId)),
            {
              key: "hostname",
              label: "Hostname",
              kind: "text",
              required: true,
              placeholder: "www.example.com",
            },
          ],
        };
      }
      case "sni-endpoint":
        return {
          fields: [
            ...(await this.appPicker(parentResourceId)),
            {
              key: "certificateChain",
              label: "Certificate Chain (PEM)",
              kind: "text",
              multiline: true,
              required: true,
              placeholder: "-----BEGIN CERTIFICATE-----",
            },
            {
              key: "privateKey",
              label: "Private Key (PEM)",
              kind: "text",
              multiline: true,
              required: true,
              placeholder: "-----BEGIN PRIVATE KEY-----",
            },
          ],
        };
      case "log-drain":
        return {
          fields: [
            ...(await this.appPicker(parentResourceId)),
            {
              key: "url",
              label: "Drain URL",
              kind: "text",
              required: true,
              placeholder: "syslog+tls://logs.example.com:6514",
            },
          ],
        };
      case "pipeline": {
        const teams = await this.teamOptions(true);
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            ...(teams.length > 1 || this.team
              ? [
                  {
                    key: "team",
                    label: "Owner",
                    kind: "select" as const,
                    required: false,
                    defaultValue: teams[0]?.id ?? "",
                    options: teams,
                  },
                ]
              : []),
          ],
        };
      }
      case "pipeline-coupling": {
        const pipelineField: CreateFieldConfig[] = parentResourceId?.includes(":pipeline:")
          ? []
          : await this.pipelines().then((ps) => [
              {
                key: "pipelineId",
                label: "Pipeline",
                kind: "select" as const,
                required: true,
                options: ps.map((p) => ({ id: p.id, label: p.name })),
                ...(ps[0] ? { defaultValue: ps[0].id } : {}),
              },
            ]);
        return {
          fields: [
            ...pipelineField,
            ...(await this.appPicker(undefined)),
            {
              key: "stage",
              label: "Stage",
              kind: "select",
              required: true,
              defaultValue: "staging",
              options: [
                { id: "development", label: "Development" },
                { id: "staging", label: "Staging" },
                { id: "production", label: "Production" },
              ],
            },
          ],
        };
      }
      case "space": {
        const [teams, regions] = await Promise.all([
          this.teamOptions(false),
          this.regionOptions(true),
        ]);
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            {
              key: "team",
              label: "Team",
              kind: "select",
              required: true,
              options: teams,
              ...(teams[0] ? { defaultValue: teams[0].id } : {}),
            },
            {
              key: "region",
              label: "Region",
              kind: "region-picker",
              required: true,
              defaultValue: "virginia",
              regions,
            },
            {
              key: "shield",
              label: "Shield",
              kind: "select",
              required: false,
              defaultValue: "false",
              description:
                "Shield Private Spaces add compliance controls (HIPAA, PCI) at a higher price.",
              options: [
                { id: "false", label: "Standard" },
                { id: "true", label: "Shield" },
              ],
            },
          ],
        };
      }
      default:
        throw new Error(`Heroku plugin: cannot create "${typeId}"`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    switch (typeId) {
      case "app": {
        const team = str(fields["team"]) || this.team;
        const body: Record<string, unknown> = {};
        if (str(fields["name"])) body["name"] = str(fields["name"]);
        if (str(fields["stack"])) body["stack"] = str(fields["stack"]);
        if (str(fields["space"])) body["space"] = str(fields["space"]);
        else if (str(fields["region"])) body["region"] = str(fields["region"]);
        let app: HkApp;
        if (team) {
          app = await this.api.request<HkApp>("/teams/apps", {
            method: "POST",
            body: { ...body, team },
          });
        } else {
          app = await this.api.request<HkApp>("/apps", { method: "POST", body });
        }
        this.invalidate();
        return mapApp(app, accountId);
      }
      case "config-var": {
        const appId = this.appIdFrom(fields, parentResourceId);
        const key = str(fields["key"]);
        if (!key) throw new Error("Heroku plugin: enter a key");
        await this.api.request(`/apps/${enc(appId)}/config-vars`, {
          method: "PATCH",
          body: { [key]: fields["value"] ?? "" },
        });
        return mapConfigVar(key, await this.appRef(appId), new Map(), accountId);
      }
      case "add-on": {
        const appId = this.appIdFrom(fields, undefined);
        const plan = str(fields["plan"]) || str(fields["otherPlan"]);
        if (!plan) throw new Error("Heroku plugin: choose a plan");
        const ad = await this.api.request<HkAddon>(`/apps/${enc(appId)}/addons`, {
          method: "POST",
          body: { plan, ...(str(fields["name"]) ? { name: str(fields["name"]) } : {}) },
        });
        this.invalidate();
        return mapAddon(ad, accountId);
      }
      case "domain": {
        const appId = this.appIdFrom(fields, parentResourceId);
        const d = await this.api.request<HkDomain>(`/apps/${enc(appId)}/domains`, {
          method: "POST",
          body: { hostname: str(fields["hostname"]), sni_endpoint: null },
        });
        return mapDomain(d, await this.appRef(appId), accountId);
      }
      case "sni-endpoint": {
        const appId = this.appIdFrom(fields, parentResourceId);
        const s = await this.api.request<HkSniEndpoint>(`/apps/${enc(appId)}/sni-endpoints`, {
          method: "POST",
          body: {
            certificate_chain: fields["certificateChain"] ?? "",
            private_key: fields["privateKey"] ?? "",
          },
        });
        return mapSniEndpoint(s, await this.appRef(appId), accountId);
      }
      case "log-drain": {
        const appId = this.appIdFrom(fields, parentResourceId);
        const d = await this.api.request<HkLogDrain>(`/apps/${enc(appId)}/log-drains`, {
          method: "POST",
          body: { url: str(fields["url"]) },
        });
        return mapLogDrain(d, await this.appRef(appId), accountId);
      }
      case "pipeline": {
        const teamName = str(fields["team"]) || this.team;
        const team = teamName
          ? (await this.teams()).find((t) => t.name === teamName || t.id === teamName)
          : undefined;
        const p = await this.api.request<HkPipeline>("/pipelines", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            ...(team ? { owner: { id: team.id, type: "team" } } : {}),
          },
        });
        return mapPipeline(p, 0, undefined, accountId);
      }
      case "pipeline-coupling": {
        const pipelineId =
          str(fields["pipelineId"]) ||
          (parentResourceId?.includes(":pipeline:") ? externalOf(parentResourceId) : "");
        if (!pipelineId) throw new Error("Heroku plugin: choose a pipeline");
        const appId = this.appIdFrom(fields, undefined);
        const c = await this.api.request<HkCoupling>("/pipeline-couplings", {
          method: "POST",
          body: { app: appId, pipeline: pipelineId, stage: str(fields["stage"]) || "staging" },
        });
        const p = await this.api.request<HkPipeline>(`/pipelines/${enc(pipelineId)}`);
        const app = await this.appRef(appId);
        return mapCoupling(c, p, new Map([[app.id, app.name]]), accountId);
      }
      case "space": {
        const s = await this.api.request<HkSpace>("/spaces", {
          method: "POST",
          body: {
            name: str(fields["name"]),
            team: str(fields["team"]) || this.team,
            ...(str(fields["region"]) ? { region: str(fields["region"]) } : {}),
            shield: fields["shield"] === "true",
          },
        });
        return mapSpace(s, accountId);
      }
      default:
        throw new Error(`Heroku plugin: cannot create "${typeId}"`);
    }
  }

  // ── Update ───────────────────────────────────────────────────────────

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalOf(resourceId);
    const has = (k: string) => fields[k] !== undefined;
    switch (typeId) {
      case "team": {
        const body: Record<string, unknown> = {};
        if (str(fields["name"])) body["name"] = str(fields["name"]);
        if (has("default")) body["default"] = fields["default"] === "true";
        if (Object.keys(body).length)
          await this.api.request(`/teams/${enc(id)}`, { method: "PATCH", body });
        this.teamsCache = undefined;
        return this.getResource(typeId, resourceId, accountId);
      }
      case "app": {
        const body: Record<string, unknown> = {};
        if (str(fields["name"])) body["name"] = str(fields["name"]);
        if (has("maintenance")) body["maintenance"] = fields["maintenance"] === "true";
        if (str(fields["buildStack"])) body["build_stack"] = str(fields["buildStack"]);
        if (Object.keys(body).length)
          await this.api.request(`/apps/${enc(id)}`, { method: "PATCH", body });
        if (has("acm")) {
          await this.api.request(`/apps/${enc(id)}/acm`, {
            method: fields["acm"] === "true" ? "POST" : "DELETE",
          });
        }
        this.invalidate();
        return this.getResource(typeId, resourceId, accountId);
      }
      case "formation": {
        const { scope: appId, id: type } = parseScopedId(id);
        const body: Record<string, unknown> = {};
        if (str(fields["quantity"])) body["quantity"] = Number(fields["quantity"]);
        if (str(fields["size"])) body["dyno_size"] = { name: str(fields["size"]) };
        if (Object.keys(body).length) {
          await this.api.request(`/apps/${enc(appId)}/formation/${enc(type)}`, {
            method: "PATCH",
            body,
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "config-var": {
        const { scope: appId, id: key } = parseScopedId(id);
        if (fields["value"]) {
          await this.api.request(`/apps/${enc(appId)}/config-vars`, {
            method: "PATCH",
            body: { [key]: fields["value"] },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "add-on": {
        if (str(fields["name"])) {
          const current = await this.api.request<HkAddon>(`/addons/${enc(id)}`);
          await this.api.request(`/apps/${enc(current.app?.id ?? "")}/addons/${enc(id)}`, {
            method: "PATCH",
            body: { name: str(fields["name"]), plan: current.plan?.name ?? current.plan?.id },
          });
          this.invalidate();
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "domain": {
        if (has("sniEndpointId")) {
          const { scope: appId, id: domainId } = parseScopedId(id);
          await this.api.request(`/apps/${enc(appId)}/domains/${enc(domainId)}`, {
            method: "PATCH",
            body: { sni_endpoint: str(fields["sniEndpointId"]) || null },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "sni-endpoint": {
        if (fields["certificateChain"] && fields["privateKey"]) {
          const { scope: appId, id: sniId } = parseScopedId(id);
          await this.api.request(`/apps/${enc(appId)}/sni-endpoints/${enc(sniId)}`, {
            method: "PATCH",
            body: {
              certificate_chain: fields["certificateChain"],
              private_key: fields["privateKey"],
            },
          });
        } else if (fields["certificateChain"] || fields["privateKey"]) {
          throw new Error("Replace the certificate chain and private key together.");
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "pipeline":
        if (str(fields["name"])) {
          await this.api.request(`/pipelines/${enc(id)}`, {
            method: "PATCH",
            body: { name: str(fields["name"]) },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      case "pipeline-coupling":
        if (str(fields["stage"])) {
          await this.api.request(`/pipeline-couplings/${enc(id)}`, {
            method: "PATCH",
            body: { stage: str(fields["stage"]) },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      case "space":
        if (str(fields["name"])) {
          await this.api.request(`/spaces/${enc(id)}`, {
            method: "PATCH",
            body: { name: str(fields["name"]) },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      default:
        throw new Error(`Heroku plugin: cannot update "${typeId}"`);
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalOf(resourceId);
    const del = (path: string) => this.api.request(path, { method: "DELETE" });
    switch (typeId) {
      case "app":
        await del(`/apps/${enc(id)}`);
        break;
      case "config-var": {
        const { scope: appId, id: key } = parseScopedId(id);
        await this.api.request(`/apps/${enc(appId)}/config-vars`, {
          method: "PATCH",
          body: { [key]: null },
        });
        break;
      }
      case "add-on": {
        const ad = await this.api.request<HkAddon>(`/addons/${enc(id)}`);
        await del(`/apps/${enc(ad.app?.id ?? "")}/addons/${enc(id)}`);
        break;
      }
      case "domain":
      case "sni-endpoint":
      case "log-drain": {
        const { scope: appId, id: childId } = parseScopedId(id);
        const seg = {
          domain: "domains",
          "sni-endpoint": "sni-endpoints",
          "log-drain": "log-drains",
        }[typeId];
        await del(`/apps/${enc(appId)}/${seg}/${enc(childId)}`);
        break;
      }
      case "pipeline":
        await del(`/pipelines/${enc(id)}`);
        break;
      case "pipeline-coupling":
        await del(`/pipeline-couplings/${enc(id)}`);
        break;
      case "review-app":
        await del(`/review-apps/${enc(id)}`);
        break;
      case "space":
        await del(`/spaces/${enc(id)}`);
        break;
      default:
        throw new Error(`Heroku plugin: cannot delete "${typeId}"`);
    }
    this.invalidate();
  }

  // ── Actions ──────────────────────────────────────────────────────────

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalOf(resourceId);
    if (typeId === "app") {
      switch (actionId) {
        case "restart-all":
          await this.api.request(`/apps/${enc(id)}/dynos`, { method: "DELETE" });
          return;
        case "clear-cache":
          await this.api.request(`/apps/${enc(id)}/build-cache`, { method: "DELETE" });
          return;
        case "refresh-acm":
          await this.api.request(`/apps/${enc(id)}/acm`, { method: "PATCH" });
          return;
      }
    }
    if (typeId === "formation") {
      const { scope: appId, id: type } = parseScopedId(id);
      switch (actionId) {
        case "restart":
          await this.api.request(`/apps/${enc(appId)}/formations/${enc(type)}`, {
            method: "DELETE",
          });
          return;
        case "stop":
          await this.api.request(`/apps/${enc(appId)}/formation/${enc(type)}`, {
            method: "PATCH",
            body: { quantity: 0 },
          });
          return;
        case "start":
          await this.api.request(`/apps/${enc(appId)}/formation/${enc(type)}`, {
            method: "PATCH",
            body: { quantity: 1 },
          });
          return;
      }
    }
    if (typeId === "dyno") {
      const { scope: appId, id: dynoId } = parseScopedId(id);
      if (actionId === "restart") {
        await this.api.request(`/apps/${enc(appId)}/dynos/${enc(dynoId)}`, { method: "DELETE" });
        return;
      }
      if (actionId === "stop") {
        await this.api.request(`/apps/${enc(appId)}/dynos/${enc(dynoId)}/actions/stop`, {
          method: "POST",
        });
        return;
      }
    }
    if (typeId === "release" && actionId === "rollback") {
      const { scope: appId, id: releaseId } = parseScopedId(id);
      await this.api.request(`/apps/${enc(appId)}/releases`, {
        method: "POST",
        body: { release: releaseId },
      });
      return;
    }
    throw new Error(`Heroku plugin: action "${actionId}" is not supported for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalOf(resourceId);
    const v = parseFormArg(args[0]);
    switch (`${typeId}:${command}`) {
      case "app:runDyno":
        await this.api.request(`/apps/${enc(id)}/dynos`, {
          method: "POST",
          body: {
            command: str(v["command"]),
            attach: false,
            type: "run:detached",
            ...(str(v["size"]) ? { size: str(v["size"]) } : {}),
          },
        });
        return null;
      case "app:rollback":
        await this.api.request(`/apps/${enc(id)}/releases`, {
          method: "POST",
          body: { release: str(v["release"]) },
        });
        return null;
      case "add-on:changePlan": {
        const ad = await this.api.request<HkAddon>(`/addons/${enc(id)}`);
        const service = ad.addon_service?.name ?? "";
        const plan = str(v["plan"]);
        await this.api.request(`/apps/${enc(ad.app?.id ?? "")}/addons/${enc(id)}`, {
          method: "PATCH",
          body: { plan: plan.includes(":") || !service ? plan : `${service}:${plan}` },
        });
        this.invalidate();
        return null;
      }
      case "pipeline:promote": {
        const source = str(v["source"]);
        const couplings = await this.api.listAll<HkCoupling>(
          `/pipelines/${enc(id)}/pipeline-couplings`,
        );
        const from = couplings.find((c) => c.app.id === source);
        if (!from) throw new Error("Heroku plugin: that app is not in this pipeline");
        const next = { development: "staging", staging: "production" }[from.stage];
        const targets = couplings.filter((c) => c.stage === next);
        if (!targets.length)
          throw new Error(`There are no apps in the ${next ?? "next"} stage to promote to.`);
        await this.api.request("/pipeline-promotions", {
          method: "POST",
          body: {
            pipeline: { id },
            source: { app: { id: source } },
            targets: targets.map((t) => ({ app: { id: t.app.id } })),
          },
        });
        return null;
      }
      case "pipeline:reviewConfig": {
        const stale = str(v["staleDays"]);
        await this.api.request(`/pipelines/${enc(id)}/review-app-config`, {
          method: "PATCH",
          body: {
            automatic_review_apps: v["automatic"] === "true",
            wait_for_ci: v["waitForCi"] === "true",
            destroy_stale_apps: Boolean(stale),
            ...(stale ? { stale_days: Number(stale) } : {}),
          },
        });
        return null;
      }
      default:
        throw new Error(`Heroku plugin: unknown command "${command}" for "${typeId}"`);
    }
  }

  // ── Logs ─────────────────────────────────────────────────────────────

  async getLogs(
    typeId: string,
    resourceId: string,
    accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    const id = externalOf(resourceId);
    if (typeId === "app") return fetchHerokuLogs(this.api, id, params.tailLines, params.container);
    if (typeId === "dyno" || typeId === "formation") {
      const r = await this.getResource(typeId, resourceId, accountId);
      const appId = String(r.fields["appId"]);
      const name = typeId === "dyno" ? String(r.fields["name"]) : String(r.fields["type"]);
      return fetchHerokuLogs(this.api, appId, params.tailLines, params.container, name);
    }
    throw new Error(`Heroku plugin: no logs for "${typeId}"`);
  }

  // ── Costs and credits ────────────────────────────────────────────────

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const teams = await this.teams();
    return fetchHerokuCostData(this.api, teams, !this.team, range);
  }

  async fetchCreditBalance(_accountId: string): Promise<CreditBalance[]> {
    let credits: HkCredit[];
    try {
      credits = await this.api.listAll<HkCredit>("/account/credits");
    } catch (e) {
      if (isStatus(e, 401, 403))
        throw new CreditAccessError("Heroku refused the account's credits for this key.");
      throw e;
    }
    const now = Date.now();
    return credits
      .filter(
        (c) => typeof c.balance === "number" && (!c.expires_at || Date.parse(c.expires_at) > now),
      )
      .map((c) => ({
        key: c.id,
        label: c.title || "Heroku credit",
        remaining: (c.balance ?? 0) / 100,
        currency: "USD",
        ...(typeof c.amount === "number" ? { granted: c.amount / 100 } : {}),
        ...(c.expires_at ? { expiresAt: c.expires_at } : {}),
      }));
  }
}
