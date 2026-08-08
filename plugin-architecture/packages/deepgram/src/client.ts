import type {
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  CreditBalance,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  MetricSeriesPoint,
  PluginClient,
  ResourceInstance,
  SectionNode,
  SidebarItemSchema,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TableRow,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
} from "@infrawrench/plugin-base";
import { base64ToBytes, bytesToBase64, jsonRestFetch } from "@infrawrench/plugin-base";
import { fetchDeepgramCostData } from "./cost-data.js";

const BASE_URL = "https://api.deepgram.com";

/**
 * Deepgram caps a single `POST /v1/speak` request at 2,000 characters. Going
 * over returns HTTP 413 with no audio, so the panel enforces it client-side
 * and this client re-checks before spending a request.
 */
const MAX_TTS_CHARACTERS = 2000;

/**
 * Largest clip the Speech panel will accept, in bytes.
 *
 * This is deliberately far below the provider's own ceiling. The panel ships
 * audio base64-encoded inside a JSON body, and base64 inflates by 4/3 — with
 * the web ingress at `proxy-body-size: 36m` the real raw-audio ceiling is
 * ~27 MB, and a clip large enough to matter also blows up `FileReader`
 * (`RangeError: Invalid string length`) before it ever reaches the network.
 * The transport is the binding constraint here, not the API.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Deepgram accepts 2 GB; our transport does not.

/** Fallback when `/v1/models` can't be reached — Deepgram's own documented defaults. */
const FALLBACK_TTS_VOICE = "aura-2-thalia-en";
const FALLBACK_STT_MODEL = "nova-3";

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

interface DgProject {
  project_id: string;
  name?: string;
  /** Only returned by `GET /v1/projects/{id}`, never by the list. */
  mip_opt_out?: boolean;
}

interface DgProjectList {
  projects?: DgProject[];
}

interface DgApiKey {
  api_key_id: string;
  key?: string;
  comment?: string;
  scopes?: string[];
  tags?: string[];
  created?: string;
  expiration_date?: string;
}

interface DgApiKeyEntry {
  member?: DgMember;
  api_key: DgApiKey;
}

interface DgApiKeyList {
  api_keys?: DgApiKeyEntry[];
}

/**
 * `GET /keys/{key_id}` nests differently from the list: the key hangs off the
 * *member*, one level deeper, inside an `item` envelope. It is also the only
 * read that returns `tags` and `expiration_date`.
 */
interface DgApiKeyItem {
  item?: {
    member?: DgMember & { api_key?: DgApiKey };
  };
}

interface DgMember {
  member_id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  scopes?: string[];
}

interface DgMemberList {
  members?: DgMember[];
}

interface DgInvite {
  email: string;
  scope?: string;
}

interface DgInviteList {
  invites?: DgInvite[];
}

interface DgBalance {
  balance_id: string;
  amount?: number;
  units?: string;
  purchase_order_id?: string;
}

interface DgBalanceList {
  balances?: DgBalance[];
}

interface DgModelMetadata {
  accent?: string;
  age?: string;
  /** Per-voice hex swatch Deepgram uses in their own picker. */
  color?: string;
  image?: string;
  sample?: string;
  tags?: string[];
  use_cases?: string[];
}

interface DgModel {
  name?: string;
  canonical_name: string;
  architecture?: string;
  languages?: string[];
  version?: string;
  uuid?: string;
  batch?: boolean;
  streaming?: boolean;
  formatted_output?: boolean;
  metadata?: DgModelMetadata;
}

interface DgModelList {
  stt?: DgModel[];
  tts?: DgModel[];
}

/**
 * One bucket from `GET /v1/projects/{id}/usage/breakdown`.
 *
 * The per-bucket timestamps live on the nested `grouping` object, **not** at
 * the top level of the result — `results[].grouping.start`, not
 * `results[].start`. The top-level `start`/`end` on the envelope describe the
 * whole window.
 */
interface DgUsageBucket {
  hours?: number;
  total_hours?: number;
  agent_hours?: number;
  tokens_in?: number;
  tokens_out?: number;
  tts_characters?: number;
  requests?: number;
  grouping?: {
    start?: string;
    end?: string;
    accessor?: string | null;
    endpoint?: string | null;
    feature_set?: string | null;
    models?: string[];
    method?: string | null;
    tags?: string[] | null;
    deployment?: string | null;
  };
}

interface DgUsageBreakdown {
  start?: string;
  end?: string;
  resolution?: { units?: string; amount?: number };
  results?: DgUsageBucket[];
}

/** Shape of `/v1/listen` responses (pre-recorded, JSON). */
interface DgListenWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  confidence?: number;
  speaker?: number;
}

interface DgListenAlternative {
  transcript?: string;
  confidence?: number;
  words?: DgListenWord[];
  /**
   * Present only under `language=multi` (Nova-3 code-switching), sorted by
   * word count descending. The `detect_language` flag reports on the channel
   * instead — two different shapes for the same question.
   */
  languages?: string[];
}

interface DgListenChannel {
  alternatives?: DgListenAlternative[];
  detected_language?: string;
  language_confidence?: number;
}

interface DgListenUtterance {
  start?: number;
  end?: number;
  confidence?: number;
  transcript?: string;
  speaker?: number;
  words?: DgListenWord[];
}

interface DgListenResponse {
  metadata?: {
    request_id?: string;
    duration?: number;
    channels?: number;
    models?: string[];
    model_info?: Record<string, { name?: string; version?: string; arch?: string }>;
  };
  results?: {
    channels?: DgListenChannel[];
    utterances?: DgListenUtterance[];
  };
}

/** Cached model catalogue stashed into `resolvedOutputs.__models__` by `getResource`. */
interface StashedModels {
  stt: Array<{ id: string; label: string; description?: string }>;
  tts: Array<{ id: string; label: string; description?: string; sample?: string }>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function externalIdOf(resourceId: string): string {
  return resourceId.split(":").slice(2).join(":");
}

/** Split a `"{projectId}/{childId}"` external id. */
function splitChildId(resourceId: string): { projectId: string; childId: string } {
  const external = externalIdOf(resourceId);
  const slash = external.indexOf("/");
  if (slash < 0) return { projectId: external, childId: "" };
  return { projectId: external.slice(0, slash), childId: external.slice(slash + 1) };
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

function memberName(member: { first_name?: string; last_name?: string; email?: string }): string {
  const full = [member.first_name, member.last_name].filter(Boolean).join(" ").trim();
  return full || member.email || "Member";
}

/**
 * A one-line voice/model blurb for the picker's second line. TTS entries have
 * the richer payload — accent, age and characteristic tags — while STT entries
 * only carry languages and an architecture.
 */
function modelDescription(model: DgModel): string {
  const bits: string[] = [];
  const meta = model.metadata;
  if (meta?.accent) bits.push(meta.accent);
  if (meta?.age) bits.push(meta.age);
  const tags = meta?.tags ?? [];
  if (tags.length > 0) bits.push(tags.slice(0, 3).join(", "));
  const languages = model.languages ?? [];
  if (bits.length === 0 && languages.length > 0) bits.push(languages.slice(0, 4).join(", "));
  if (bits.length === 0 && model.architecture) bits.push(model.architecture);
  return bits.join(" · ");
}

/**
 * Deepgram model ids are cheap to sort into a stable, useful order: the
 * newest generation first, then alphabetically. `aura-2-*` before `aura-*`,
 * `nova-3` before `nova-2`.
 */
function byGenerationDesc(a: { id: string }, b: { id: string }): number {
  const gen = (id: string): number => {
    const match = /(?:aura|nova)-(\d)/.exec(id);
    return match?.[1] ? Number(match[1]) : 1;
  };
  const diff = gen(b.id) - gen(a.id);
  return diff !== 0 ? diff : a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Deepgram plugin client.
 *
 * One account == one Deepgram API key. The key's own scopes decide which
 * projects and which management endpoints answer; an owner-scoped key sees
 * everything, a member-scoped key sees its own project only.
 *
 * Auth is `Authorization: Token <key>` — Deepgram does **not** accept
 * `Bearer`. See https://developers.deepgram.com/docs/authenticating
 */
export class DeepgramClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Deepgram plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  private get authHeaders(): Record<string, string> {
    return { Authorization: `Token ${this.apiKey}` };
  }

  /**
   * JSON control-plane call. Always routed through the host's HTTP service
   * when one is present — that is the only path that picks up bastion egress
   * routing and a custom CA.
   */
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    return jsonRestFetch<T>({
      vendor: "Deepgram",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers: { ...this.authHeaders, Accept: "application/json" },
      ...(options ? { init: options } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "project":
        return this.listProjects(accountId);
      case "api-key":
        return this.listForEachProject(accountId, (p) => this.listApiKeys(accountId, p));
      case "member":
        return this.listForEachProject(accountId, (p) => this.listMembers(accountId, p));
      case "invite":
        return this.listForEachProject(accountId, (p) => this.listInvites(accountId, p));
      case "balance":
        return this.listForEachProject(accountId, (p) => this.listBalances(accountId, p));
      case "model":
        return this.listForEachProject(accountId, (p) => this.listModels(accountId, p));
      default:
        throw new Error(`Deepgram plugin: unknown resource type "${typeId}"`);
    }
  }

  /**
   * Fan out a child listing across every project the key can see. A project
   * the key lacks scope for fails individually rather than emptying the list.
   */
  private async listForEachProject(
    accountId: string,
    load: (projectId: string) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const projects = await this.fetchProjects();
    const settled = await Promise.allSettled(projects.map((p) => load(p.project_id)));
    return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  /**
   * Prepaid balances across every project the key can see.
   *
   * Deepgram scopes balances to a project and an account can hold several, so
   * the pot key is `<projectId>:<balanceId>` — one project running dry while
   * another has headroom is exactly the situation this feature exists to
   * surface, and summing them would hide it.
   *
   * `units` is Deepgram's own word for what the amount is denominated in
   * ("usd"); anything else is passed through uppercased rather than assumed to
   * be dollars. Projects the key lacks scope for fail individually, the same
   * stance `listForEachProject` takes — a member-scoped key sees no balances
   * at all, which is a permission gap rather than a zero balance.
   */
  async fetchCreditBalance(): Promise<CreditBalance[]> {
    const projects = await this.fetchProjects();
    const settled = await Promise.allSettled(
      projects.map(async (project) => {
        const data = await this.fetch<DgBalanceList>(
          `/v1/projects/${encodeURIComponent(project.project_id)}/balances`,
        );
        return (data.balances ?? []).map((b): CreditBalance => ({
          key: `${project.project_id}:${b.balance_id}`,
          label: `${project.name ?? project.project_id} balance`,
          remaining: Number(b.amount ?? 0),
          currency: (b.units ?? "usd").toUpperCase(),
        }));
      }),
    );
    return settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  /** https://developers.deepgram.com/reference/management-api/projects/list */
  private async fetchProjects(): Promise<DgProject[]> {
    const data = await this.fetch<DgProjectList>("/v1/projects");
    return data.projects ?? [];
  }

  private async listProjects(accountId: string): Promise<ResourceInstance[]> {
    const projects = await this.fetchProjects();
    return projects.map((p) => this.mapProject(accountId, p));
  }

  /** https://developers.deepgram.com/reference/management-api/keys/list */
  private async listApiKeys(accountId: string, projectId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<DgApiKeyList>(
      `/v1/projects/${encodeURIComponent(projectId)}/keys`,
    );
    return (data.api_keys ?? []).map((entry) => this.mapApiKey(accountId, projectId, entry));
  }

  /** https://developers.deepgram.com/reference/management-api/members/list */
  private async listMembers(accountId: string, projectId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<DgMemberList>(
      `/v1/projects/${encodeURIComponent(projectId)}/members`,
    );
    return (data.members ?? []).map((m) => this.mapMember(accountId, projectId, m));
  }

  /** https://developers.deepgram.com/reference/management-api/invitations/list */
  private async listInvites(accountId: string, projectId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<DgInviteList>(
      `/v1/projects/${encodeURIComponent(projectId)}/invites`,
    );
    return (data.invites ?? []).map((i) => this.mapInvite(accountId, projectId, i));
  }

  /** https://developers.deepgram.com/reference/management-api/balances/list */
  private async listBalances(accountId: string, projectId: string): Promise<ResourceInstance[]> {
    const data = await this.fetch<DgBalanceList>(
      `/v1/projects/${encodeURIComponent(projectId)}/balances`,
    );
    return (data.balances ?? []).map((b) => this.mapBalance(accountId, projectId, b));
  }

  /**
   * https://developers.deepgram.com/reference/management-api/models/list-project
   * Project-scoped list — only the models this project is entitled to. Falls
   * back to the account-wide catalogue when the project route is unavailable.
   */
  private async fetchModels(projectId?: string): Promise<DgModelList> {
    if (projectId) {
      try {
        return await this.fetch<DgModelList>(
          `/v1/projects/${encodeURIComponent(projectId)}/models`,
        );
      } catch {
        // Fall through to the account-wide catalogue below.
      }
    }
    return this.fetch<DgModelList>("/v1/models");
  }

  private async listModels(accountId: string, projectId: string): Promise<ResourceInstance[]> {
    const data = await this.fetchModels(projectId);
    return [
      ...(data.stt ?? []).map((m) => this.mapModel(accountId, projectId, m, "stt")),
      ...(data.tts ?? []).map((m) => this.mapModel(accountId, projectId, m, "tts")),
    ];
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private mapProject(accountId: string, project: DgProject): ResourceInstance {
    const now = new Date().toISOString();
    return {
      id: `${accountId}:project:${project.project_id}`,
      pluginId: "deepgram",
      resourceTypeId: "project",
      accountId,
      displayName: project.name ?? project.project_id,
      fields: {
        name: project.name ?? "",
        projectId: project.project_id,
        ...(project.mip_opt_out !== undefined ? { mipOptOut: project.mip_opt_out } : {}),
      },
      resolvedOutputs: {
        projectId: project.project_id,
        projectName: project.name ?? "",
      },
      secretStates: [],
      externalId: project.project_id,
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapApiKey(accountId: string, projectId: string, entry: DgApiKeyEntry): ResourceInstance {
    const key = entry.api_key;
    const now = new Date().toISOString();
    const externalId = `${projectId}/${key.api_key_id}`;
    return {
      id: `${accountId}:api-key:${externalId}`,
      pluginId: "deepgram",
      resourceTypeId: "api-key",
      accountId,
      displayName: key.comment || key.api_key_id,
      fields: {
        comment: key.comment ?? "",
        scopes: (key.scopes ?? []).join(", "),
        tags: (key.tags ?? []).join(", "),
        apiKeyId: key.api_key_id,
        created: key.created ?? "",
        expirationDate: key.expiration_date ?? "",
        memberEmail: entry.member?.email ?? "",
      },
      // The secret is only ever present on the create response — Deepgram
      // does not return it from the list endpoint.
      resolvedOutputs: { apiKeyId: key.api_key_id },
      secretStates: [],
      externalId,
      parentResourceId: `${accountId}:project:${projectId}`,
      createdAt: key.created ?? now,
      updatedAt: key.created ?? now,
    };
  }

  private mapMember(accountId: string, projectId: string, member: DgMember): ResourceInstance {
    const now = new Date().toISOString();
    const externalId = `${projectId}/${member.member_id}`;
    return {
      id: `${accountId}:member:${externalId}`,
      pluginId: "deepgram",
      resourceTypeId: "member",
      accountId,
      displayName: memberName(member),
      fields: {
        email: member.email ?? "",
        firstName: member.first_name ?? "",
        lastName: member.last_name ?? "",
        memberId: member.member_id,
        scopes: (member.scopes ?? []).join(", "),
      },
      resolvedOutputs: { memberId: member.member_id, email: member.email ?? "" },
      secretStates: [],
      externalId,
      parentResourceId: `${accountId}:project:${projectId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapInvite(accountId: string, projectId: string, invite: DgInvite): ResourceInstance {
    const now = new Date().toISOString();
    const externalId = `${projectId}/${invite.email}`;
    return {
      id: `${accountId}:invite:${externalId}`,
      pluginId: "deepgram",
      resourceTypeId: "invite",
      accountId,
      displayName: invite.email,
      fields: { email: invite.email, scope: invite.scope ?? "" },
      resolvedOutputs: { email: invite.email, scope: invite.scope ?? "" },
      secretStates: [],
      externalId,
      parentResourceId: `${accountId}:project:${projectId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapBalance(accountId: string, projectId: string, balance: DgBalance): ResourceInstance {
    const now = new Date().toISOString();
    const externalId = `${projectId}/${balance.balance_id}`;
    const amount = typeof balance.amount === "number" ? balance.amount : 0;
    return {
      id: `${accountId}:balance:${externalId}`,
      pluginId: "deepgram",
      resourceTypeId: "balance",
      accountId,
      displayName: `${amount.toFixed(2)} ${balance.units ?? ""}`.trim(),
      fields: {
        amount,
        units: balance.units ?? "",
        balanceId: balance.balance_id,
        purchaseOrderId: balance.purchase_order_id ?? "",
      },
      resolvedOutputs: { balanceId: balance.balance_id, amount: String(amount) },
      secretStates: [],
      externalId,
      parentResourceId: `${accountId}:project:${projectId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapModel(
    accountId: string,
    projectId: string,
    model: DgModel,
    family: "stt" | "tts",
  ): ResourceInstance {
    const now = new Date().toISOString();
    const externalId = `${projectId}/${model.canonical_name}`;
    return {
      id: `${accountId}:model:${externalId}`,
      pluginId: "deepgram",
      resourceTypeId: "model",
      accountId,
      displayName: model.name ?? model.canonical_name,
      fields: {
        name: model.name ?? model.canonical_name,
        canonicalName: model.canonical_name,
        family,
        architecture: model.architecture ?? "",
        version: model.version ?? "",
        languages: (model.languages ?? []).join(", "),
        accent: model.metadata?.accent ?? "",
        age: model.metadata?.age ?? "",
        tags: (model.metadata?.tags ?? []).join(", "),
        useCases: (model.metadata?.use_cases ?? []).join(", "),
        color: model.metadata?.color ?? "",
        uuid: model.uuid ?? "",
        ...(model.batch !== undefined ? { batch: model.batch } : {}),
        ...(model.streaming !== undefined ? { streaming: model.streaming } : {}),
      },
      resolvedOutputs: {
        canonicalName: model.canonical_name,
        modelUuid: model.uuid ?? "",
        sampleUrl: model.metadata?.sample ?? "",
        imageUrl: model.metadata?.image ?? "",
      },
      secretStates: [],
      externalId,
      parentResourceId: `${accountId}:project:${projectId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Single-resource reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    if (typeId === "project") {
      const projectId = externalIdOf(resourceId);
      const project = await this.fetch<DgProject>(`/v1/projects/${encodeURIComponent(projectId)}`);
      const instance = this.mapProject(accountId, project);
      // `renderDetail` is synchronous, so the Speech tab's voice and model
      // pickers can't do their own round trip. Pre-bake the catalogue here and
      // stash it as JSON — the Cloudflare queue plugin uses the same
      // `__doubleUnderscore__` convention for its consumer list.
      instance.resolvedOutputs = {
        ...instance.resolvedOutputs,
        __models__: JSON.stringify(await this.loadSpeechOptions(projectId)),
      };
      return instance;
    }

    const { projectId, childId } = splitChildId(resourceId);

    if (typeId === "api-key") {
      // https://developers.deepgram.com/reference/manage/keys/get
      // Worth the extra call: this is the only read that carries `tags` and
      // `expiration_date`, both of which the list endpoint omits.
      const data = await this.fetch<DgApiKeyItem>(
        `/v1/projects/${encodeURIComponent(projectId)}/keys/${encodeURIComponent(childId)}`,
      );
      const member = data.item?.member;
      const key = member?.api_key;
      if (key) {
        const entry: DgApiKeyEntry = { api_key: key, ...(member ? { member } : {}) };
        return this.mapApiKey(accountId, projectId, entry);
      }
    }

    if (typeId === "balance") {
      // https://developers.deepgram.com/reference/manage/billing/get
      // Unlike the list, this returns the bare balance object, unwrapped.
      const balance = await this.fetch<DgBalance>(
        `/v1/projects/${encodeURIComponent(projectId)}/balances/${encodeURIComponent(childId)}`,
      );
      return this.mapBalance(accountId, projectId, balance);
    }

    // Members, invites and models have no per-item read worth a second code
    // path — the list already carries every field.
    const siblings =
      typeId === "member"
        ? await this.listMembers(accountId, projectId)
        : typeId === "invite"
          ? await this.listInvites(accountId, projectId)
          : typeId === "model"
            ? await this.listModels(accountId, projectId)
            : await this.listResources(typeId, accountId);
    const found = siblings.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Deepgram plugin: resource ${typeId}/${resourceId} not found`);
    return found;
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
    throw new Error(`Deepgram plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Speech option catalogue
  // -------------------------------------------------------------------------

  /**
   * Build the Speech tab's voice + model pickers from Deepgram's own catalogue.
   * `GET /v1/models` returns two arrays — `tts` (voices, with the richest
   * metadata of any provider we ship: accent, characteristics, avatar image
   * and a preview clip) and `stt` (transcription models).
   */
  private async loadSpeechOptions(projectId?: string): Promise<StashedModels> {
    try {
      const data = await this.fetchModels(projectId);
      const tts = (data.tts ?? [])
        .map((m) => {
          const description = modelDescription(m);
          return {
            id: m.canonical_name,
            label: m.name ?? m.canonical_name,
            ...(description ? { description } : {}),
            ...(m.metadata?.sample ? { sample: m.metadata.sample } : {}),
          };
        })
        .sort(byGenerationDesc);
      const stt = (data.stt ?? [])
        .map((m) => {
          const description = modelDescription(m);
          return {
            id: m.canonical_name,
            label: m.name ?? m.canonical_name,
            ...(description ? { description } : {}),
          };
        })
        .sort(byGenerationDesc);
      return { stt, tts };
    } catch {
      // A key without the models scope shouldn't blank the whole detail page —
      // fall back to Deepgram's documented defaults.
      return { stt: [], tts: [] };
    }
  }

  private static parseStashedModels(resource: ResourceInstance): StashedModels {
    const raw = resource.resolvedOutputs["__models__"];
    if (typeof raw !== "string" || raw.length === 0) return { stt: [], tts: [] };
    try {
      const parsed = JSON.parse(raw) as Partial<StashedModels>;
      return { stt: parsed.stt ?? [], tts: parsed.tts ?? [] };
    } catch {
      return { stt: [], tts: [] };
    }
  }

  // -------------------------------------------------------------------------
  // Stats and metrics
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (resourceTypeId === "project") {
      const projectId = externalIdOf(resourceId);
      const [usage, balances] = await Promise.all([
        this.fetchUsageBuckets(projectId).catch(() => [] as DgUsageBucket[]),
        this.listBalances(accountId, projectId).catch(() => [] as ResourceInstance[]),
      ]);
      const totals = summariseUsage(usage);
      const credit = balances.reduce((sum, b) => sum + Number(b.fields["amount"] ?? 0), 0);
      return [
        { label: "Requests (30d)", value: totals.requests.toLocaleString() },
        { label: "Audio Hours (30d)", value: totals.hours.toFixed(2) },
        { label: "TTS Characters (30d)", value: totals.ttsCharacters.toLocaleString() },
        ...(balances.length > 0
          ? [{ label: "Prepaid Balance", value: `$${credit.toFixed(2)}` }]
          : []),
      ];
    }

    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    switch (resourceTypeId) {
      case "api-key":
        return [
          { label: "Scopes", value: String(f["scopes"] ?? "") || "—" },
          { label: "Created", value: String(f["created"] ?? "") },
          { label: "Expires", value: String(f["expirationDate"] ?? "") || "Never" },
        ];
      case "member":
        return [
          { label: "Email", value: String(f["email"] ?? "") },
          { label: "Scopes", value: String(f["scopes"] ?? "") || "—" },
        ];
      case "invite":
        return [
          { label: "Email", value: String(f["email"] ?? "") },
          { label: "Scope", value: String(f["scope"] ?? "") },
        ];
      case "balance":
        return [
          { label: "Amount", value: String(f["amount"] ?? "0") },
          { label: "Units", value: String(f["units"] ?? "") },
        ];
      case "model":
        return [
          { label: "Family", value: String(f["family"] ?? "").toUpperCase() },
          { label: "Canonical Name", value: String(f["canonicalName"] ?? "") },
          ...(f["accent"] ? [{ label: "Accent", value: String(f["accent"]) }] : []),
        ];
      default:
        return [];
    }
  }

  /**
   * https://developers.deepgram.com/reference/management-api/usage/breakdown
   *
   * Consumption only — Deepgram exposes no quota ceiling, so there is nothing
   * to draw a used-vs-limit gauge from. Prepaid customers get a separate
   * `balances.amount`, which the Overview surfaces instead.
   */
  private async fetchUsageBuckets(
    projectId: string,
    range?: { startMs: number; endMs: number },
  ): Promise<DgUsageBucket[]> {
    const endMs = range?.endMs ?? Date.now();
    const startMs = range?.startMs ?? endMs - 30 * 24 * 60 * 60 * 1000;
    const params = new URLSearchParams({
      start: new Date(startMs).toISOString().slice(0, 10),
      end: new Date(endMs).toISOString().slice(0, 10),
    });
    const data = await this.fetch<DgUsageBreakdown>(
      `/v1/projects/${encodeURIComponent(projectId)}/usage/breakdown?${params.toString()}`,
    );
    return data.results ?? [];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (resourceTypeId !== "project") return [];
    const projectId = externalIdOf(resourceId);
    const buckets = await this.fetchUsageBuckets(projectId, timeRange);
    if (buckets.length === 0) return [];

    // Deepgram can return several rows per interval (one per grouping key), so
    // sum into a map keyed by the bucket's own timestamp rather than assuming
    // one row per point.
    const byStamp = new Map<number, { requests: number; hours: number; characters: number }>();
    for (const bucket of buckets) {
      const stamp = Date.parse(bucket.grouping?.start ?? bucket.grouping?.end ?? "");
      if (!Number.isFinite(stamp)) continue;
      const acc = byStamp.get(stamp) ?? { requests: 0, hours: 0, characters: 0 };
      acc.requests += num(bucket.requests);
      acc.hours += num(bucket.hours);
      acc.characters += num(bucket.tts_characters);
      byStamp.set(stamp, acc);
    }

    const stamps = [...byStamp.keys()].sort((a, b) => a - b);
    const requests: MetricSeriesPoint[] = [];
    const hours: MetricSeriesPoint[] = [];
    const characters: MetricSeriesPoint[] = [];
    for (const stamp of stamps) {
      const acc = byStamp.get(stamp)!;
      requests.push({ timestamp: stamp, value: acc.requests });
      hours.push({ timestamp: stamp, value: acc.hours });
      characters.push({ timestamp: stamp, value: acc.characters });
    }

    const series: MetricSeries[] = [];
    const nonZero = (points: MetricSeriesPoint[]): boolean => points.some((p) => p.value !== 0);
    if (nonZero(requests)) series.push({ label: "Requests", unit: "count", points: requests });
    if (nonZero(hours)) series.push({ label: "Audio Hours", unit: "hours", points: hours });
    if (nonZero(characters)) {
      series.push({ label: "TTS Characters", unit: "characters", points: characters });
    }
    return series;
  }

  // -------------------------------------------------------------------------
  // Costs
  // -------------------------------------------------------------------------

  /**
   * Billed USD from `GET /v1/projects/{id}/billing/breakdown`, one request per
   * project the key can see. The collector lives in `cost-data.ts` and takes
   * only the credential plus the host HTTP services, so it can be exercised
   * without a client.
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchDeepgramCostData(
      {
        apiKey: this.apiKey,
        ...(this.caCert ? { caCert: this.caCert } : {}),
        ...(this.services?.http ? { http: this.services.http } : {}),
      },
      range,
    );
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const projectField = await this.projectPickerField(parentResourceId);

    if (typeId === "api-key") {
      return {
        fields: [
          ...projectField,
          {
            key: "comment",
            label: "Name",
            kind: "text",
            required: true,
            description: "Deepgram calls this the key's comment. Shown in the console.",
          },
          {
            key: "scopes",
            label: "Scopes",
            kind: "select",
            required: true,
            options: [
              { id: "member", label: "member — transcribe, synthesize, read own usage" },
              { id: "admin", label: "admin — manage keys, members and invites" },
              { id: "owner", label: "owner — full control, including billing" },
            ],
            defaultValue: "member",
            description: "A key can never be granted a scope wider than the key that created it.",
          },
          {
            key: "tags",
            label: "Tags",
            kind: "string-list",
            required: false,
            placeholder: "tag",
            addLabel: "+ Add tag",
            description: "Free-form labels. Usage can be filtered by tag.",
          },
          {
            key: "expirationDate",
            label: "Expires",
            kind: "datetime",
            datetimeMode: "datetime",
            required: false,
            description: "Leave blank for a key that never expires.",
          },
        ],
      };
    }

    if (typeId === "invite") {
      return {
        fields: [
          ...projectField,
          { key: "email", label: "Email", kind: "text", required: true },
          {
            key: "scope",
            label: "Scope",
            kind: "select",
            required: true,
            options: [
              { id: "member", label: "member" },
              { id: "admin", label: "admin" },
              { id: "owner", label: "owner" },
            ],
            defaultValue: "member",
          },
        ],
      };
    }

    throw new Error(`Deepgram plugin: no create config for type "${typeId}"`);
  }

  /**
   * A project picker, unless the create was launched from a project's detail
   * page — in which case the parent already answers the question.
   */
  private async projectPickerField(
    parentResourceId?: string,
  ): Promise<CreateResourceConfig["fields"]> {
    if (parentResourceId) return [];
    const projects = await this.fetchProjects().catch(() => [] as DgProject[]);
    const options = projects.map((p) => ({
      id: p.project_id,
      label: p.name ?? p.project_id,
    }));
    return [
      {
        key: "projectId",
        label: "Project",
        kind: "select",
        required: true,
        options,
        ...(options[0] ? { defaultValue: options[0].id } : {}),
      },
    ];
  }

  private resolveProjectId(fields: Record<string, string>, parentResourceId?: string): string {
    const projectId = parentResourceId ? externalIdOf(parentResourceId) : fields["projectId"];
    if (!projectId) throw new Error("Deepgram plugin: a project is required");
    return projectId;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const projectId = this.resolveProjectId(fields, parentResourceId);

    if (typeId === "api-key") {
      // https://developers.deepgram.com/reference/management-api/keys/create
      const body: Record<string, unknown> = {
        comment: fields["comment"] ?? "",
        scopes: [fields["scopes"] ?? "member"],
      };
      const tags = (fields["tags"] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (tags.length > 0) body["tags"] = tags;
      // `expiration_date` is the only expiry field Deepgram documents on this
      // endpoint (their spec types the body as an untyped two-branch `oneOf`).
      if (fields["expirationDate"]) body["expiration_date"] = fields["expirationDate"];

      const created = await this.fetch<DgApiKey>(
        `/v1/projects/${encodeURIComponent(projectId)}/keys`,
        { method: "POST", body: JSON.stringify(body) },
      );
      const instance = this.mapApiKey(accountId, projectId, { api_key: created });
      // The plaintext key is returned exactly once, on this response.
      if (created.key) {
        instance.resolvedOutputs = { ...instance.resolvedOutputs, apiKey: created.key };
      }
      return instance;
    }

    if (typeId === "invite") {
      // https://developers.deepgram.com/reference/management-api/invitations/send
      const email = fields["email"];
      if (!email) throw new Error("Deepgram plugin: an email address is required");
      const scope = fields["scope"] ?? "member";
      await this.fetch<{ message?: string }>(
        `/v1/projects/${encodeURIComponent(projectId)}/invites`,
        { method: "POST", body: JSON.stringify({ email, scope }) },
      );
      return this.mapInvite(accountId, projectId, { email, scope });
    }

    throw new Error(`Deepgram plugin: cannot create type "${typeId}"`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "project") {
      // https://developers.deepgram.com/reference/management-api/projects/update
      const projectId = externalIdOf(resourceId);
      // `name` is the only documented mutable attribute.
      const name = fields["name"];
      if (name === undefined) return this.getResource("project", resourceId, accountId);
      await this.fetch<{ message?: string }>(`/v1/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      return this.getResource("project", resourceId, accountId);
    }

    if (typeId === "member") {
      // https://developers.deepgram.com/reference/manage/members/scopes/update
      // Roles are expressed as a scope: member | admin | owner.
      const { projectId, childId } = splitChildId(resourceId);
      const scope = fields["scopes"];
      if (!scope) return this.getResource("member", resourceId, accountId);
      await this.fetch<{ message?: string }>(
        `/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(childId)}/scopes`,
        { method: "PUT", body: JSON.stringify({ scope }) },
      );
      return this.getResource("member", resourceId, accountId);
    }

    throw new Error(`Deepgram plugin: cannot update type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const { projectId, childId } = splitChildId(resourceId);

    if (typeId === "api-key") {
      // https://developers.deepgram.com/reference/management-api/keys/delete
      await this.fetch<void>(
        `/v1/projects/${encodeURIComponent(projectId)}/keys/${encodeURIComponent(childId)}`,
        { method: "DELETE" },
      );
      return;
    }

    if (typeId === "invite") {
      // https://developers.deepgram.com/reference/management-api/invitations/delete
      // Invites are addressed by email, not by an id.
      await this.fetch<void>(
        `/v1/projects/${encodeURIComponent(projectId)}/invites/${encodeURIComponent(childId)}`,
        { method: "DELETE" },
      );
      return;
    }

    if (typeId === "member") {
      // https://developers.deepgram.com/reference/management-api/members/delete
      await this.fetch<void>(
        `/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(childId)}`,
        { method: "DELETE" },
      );
      return;
    }

    throw new Error(`Deepgram plugin: cannot delete type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Speech — binary transport
  // -------------------------------------------------------------------------

  /**
   * Raw-bytes request/response helper for the two speech endpoints.
   *
   * Neither call can go through `jsonRestFetch`: `/v1/speak` answers with
   * binary audio (the helper would try to `JSON.parse` it) and both endpoints
   * carry the `dg-request-id` / `dg-char-count` headers the Speech tab
   * surfaces, which the helper discards. This path uses the global `fetch`
   * directly and therefore **bypasses bastion egress routing and any custom
   * CA** — an accepted trade for the interactive playground.
   */
  private async speechFetch(
    url: string,
    contentType: string,
    body: Uint8Array | string,
  ): Promise<{ bytes: Uint8Array; headers: Headers }> {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.authHeaders, "Content-Type": contentType },
      // A fresh copy keeps TypeScript's BodyInit happy across Node's
      // Uint8Array<ArrayBufferLike> and the DOM's Uint8Array<ArrayBuffer>.
      body: typeof body === "string" ? body : new Uint8Array(body),
    });
    if (!res.ok) {
      // Binary success, JSON errors: a failed call returns JSON where the
      // caller expected audio, so always branch on status before parsing.
      const text = await res.text();
      if (res.status === 413) {
        throw new Error(
          `Deepgram rejected the request as too large (413). ${text || "Text must be 2,000 characters or fewer."}`,
        );
      }
      throw new Error(`Deepgram API error ${res.status}: ${text}`);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  }

  /**
   * `POST /v1/speak` — https://developers.deepgram.com/reference/text-to-speech-api/speak
   *
   * The voice/model, encoding and sample rate are **query** parameters; the
   * JSON body carries nothing but `{"text": "..."}`. mp3 is requested
   * explicitly so the browser's `<audio>` element can always play the result.
   */
  async synthesizeSpeech(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    if (typeId !== "project") {
      throw new Error(`Deepgram plugin: speech synthesis is not available on "${typeId}"`);
    }
    const text = payload.text.trim();
    if (!text) throw new Error("Deepgram plugin: nothing to synthesize");
    if (text.length > MAX_TTS_CHARACTERS) {
      throw new Error(
        `Deepgram accepts at most ${MAX_TTS_CHARACTERS} characters per request (got ${text.length}).`,
      );
    }

    const voice = payload.voiceId || FALLBACK_TTS_VOICE;
    const params = new URLSearchParams({ model: voice, encoding: "mp3" });
    const started = Date.now();
    const { bytes, headers } = await this.speechFetch(
      `${BASE_URL}/v1/speak?${params.toString()}`,
      "application/json",
      JSON.stringify({ text }),
    );
    const elapsedMs = Date.now() - started;

    const requestId = headers.get("dg-request-id") ?? undefined;
    const modelName = headers.get("dg-model-name") ?? voice;
    const headerChars = Number(headers.get("dg-char-count") ?? "");
    const characters = Number.isFinite(headerChars) && headerChars > 0 ? headerChars : text.length;

    return {
      audioBase64: bytesToBase64(bytes),
      mimeType: "audio/mpeg",
      fileName: `${voice}-${started}.mp3`,
      summary: `${characters.toLocaleString()} characters · ${modelName} · ${elapsedMs} ms · ${(bytes.byteLength / 1024).toFixed(1)} KB`,
      characters,
      ...(requestId ? { requestId } : {}),
    };
  }

  /**
   * `POST /v1/listen` — https://developers.deepgram.com/reference/speech-to-text-api/listen
   *
   * Deepgram accepts the raw audio bytes with the clip's own `Content-Type`,
   * which is exactly what the Speech tab hands us: `MediaRecorder` produces
   * `audio/webm;codecs=opus` on Chromium and `audio/mp4` on Safari, and both
   * are forwarded untouched — no multipart wrapper, no transcoding.
   *
   * `punctuate`, `smart_format`, `diarize` and `utterances` are all on so the
   * result carries speaker labels and per-word timings.
   */
  async transcribeAudio(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    if (typeId !== "project") {
      throw new Error(`Deepgram plugin: transcription is not available on "${typeId}"`);
    }
    const audio = base64ToBytes(payload.audioBase64);
    if (audio.byteLength === 0) throw new Error("Deepgram plugin: the clip is empty");

    const params = new URLSearchParams({
      punctuate: "true",
      smart_format: "true",
      diarize: "true",
      utterances: "true",
    });
    if (payload.modelId) params.set("model", payload.modelId);
    else params.set("model", FALLBACK_STT_MODEL);
    if (payload.language) params.set("language", payload.language);

    const started = Date.now();
    const { bytes, headers } = await this.speechFetch(
      `${BASE_URL}/v1/listen?${params.toString()}`,
      payload.mimeType || "application/octet-stream",
      audio,
    );
    const elapsedMs = Date.now() - started;

    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as DgListenResponse;
    const channel = parsed.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    const utterances = parsed.results?.utterances ?? [];

    // Prefer the utterance words — they carry the diarisation speaker label
    // for every token. Fall back to the flat alternative word list.
    const source: DgListenWord[] =
      utterances.length > 0
        ? utterances.flatMap((u) =>
            (u.words ?? []).map((w) => {
              const speaker = w.speaker ?? u.speaker;
              return { ...w, ...(speaker !== undefined ? { speaker } : {}) };
            }),
          )
        : (alternative?.words ?? []);

    const words: TranscriptWord[] = source.map((w) => ({
      text: w.punctuated_word ?? w.word ?? "",
      ...(typeof w.start === "number" ? { start: w.start } : {}),
      ...(typeof w.end === "number" ? { end: w.end } : {}),
      ...(typeof w.speaker === "number" ? { speaker: `Speaker ${w.speaker}` } : {}),
    }));

    const transcript =
      utterances.length > 0
        ? utterances
            .map((u) => u.transcript ?? "")
            .filter(Boolean)
            .join("\n")
        : (alternative?.transcript ?? "");

    const durationSeconds = parsed.metadata?.duration;
    const model =
      Object.values(parsed.metadata?.model_info ?? {})[0]?.name ??
      payload.modelId ??
      FALLBACK_STT_MODEL;
    const speakers = new Set(source.map((w) => w.speaker).filter((s) => typeof s === "number"));
    const requestId = parsed.metadata?.request_id ?? headers.get("dg-request-id") ?? undefined;

    // Two different shapes answer "what language was this?": `detect_language`
    // reports `channels[].detected_language`, while `language=multi` reports
    // `alternatives[].languages` (sorted by word count) and no channel field.
    const detected =
      channel?.detected_language ??
      (alternative?.languages && alternative.languages.length > 0
        ? alternative.languages.join(", ")
        : undefined);

    const summaryBits = [
      durationSeconds !== undefined ? `${durationSeconds.toFixed(1)} s audio` : undefined,
      `${model}`,
      speakers.size > 1 ? `${speakers.size} speakers` : undefined,
      `${elapsedMs} ms`,
    ].filter(Boolean);

    return {
      text: transcript,
      summary: summaryBits.join(" · "),
      ...(detected ? { language: detected } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(typeof alternative?.confidence === "number"
        ? { confidence: alternative.confidence }
        : {}),
      ...(words.length > 0 ? { words } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "project":
        return this.renderProjectDetail(resource);
      case "api-key":
        return this.renderApiKeyDetail(resource);
      case "member":
        return this.renderMemberDetail(resource);
      case "invite":
        return this.renderInviteDetail(resource);
      case "balance":
        return this.renderBalanceDetail(resource);
      case "model":
        return this.renderModelDetail(resource);
      default:
        return this.renderGenericDetail(resource);
    }
  }

  private renderProjectDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const catalogue = DeepgramClient.parseStashedModels(resource);

    const voices: SpeechPanelOption[] = catalogue.tts.map((v) => ({
      id: v.id,
      label: v.label,
      ...(v.description ? { description: v.description } : {}),
    }));
    const models: SpeechPanelOption[] = catalogue.stt.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.description ? { description: m.description } : {}),
    }));

    const defaultVoice = voices.find((v) => v.id === FALLBACK_TTS_VOICE)?.id ?? voices[0]?.id;
    const defaultModel = models.find((m) => m.id === FALLBACK_STT_MODEL)?.id ?? models[0]?.id;

    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Project",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Name", value: String(f["name"] ?? resource.displayName), copyable: true },
              { key: "Project ID", value: String(f["projectId"] ?? ""), copyable: true },
              ...(f["mipOptOut"] !== undefined
                ? [
                    {
                      key: "Model Improvement Opt-Out",
                      value: f["mipOptOut"] ? "Yes" : "No",
                    },
                  ]
                : []),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Speech Catalogue",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Transcription Models", value: String(models.length) },
              { key: "Text-to-Speech Voices", value: String(voices.length) },
            ],
          },
          ...(catalogue.tts.length > 0
            ? [
                {
                  kind: "table" as const,
                  columns: [
                    { key: "voice", label: "Voice" },
                    { key: "id", label: "Canonical Name", mono: true },
                    { key: "traits", label: "Characteristics", width: "wide" as const },
                  ],
                  rows: catalogue.tts.slice(0, 12).map<TableRow>((v) => ({
                    cells: {
                      voice: v.label,
                      id: v.id,
                      traits: v.description ?? "",
                    },
                  })),
                },
              ]
            : []),
        ],
      },
    ];

    return {
      title: resource.displayName,
      subtitle: "Deepgram project",
      status: { kind: "status-dot", status: "healthy" },
      sections,
      headerActions: [
        {
          kind: "action",
          label: "Open in Deepgram Console",
          action: {
            type: "open-url",
            url: `https://console.deepgram.com/project/${String(f["projectId"] ?? "")}`,
          },
          variant: "ghost",
        },
      ],
      metricsCapability: { defaultTimeRangeMs: 30 * 24 * 60 * 60 * 1000 },
      speechPanel: {
        modes: ["stt", "tts"],
        subtitle: "Round-trip audio against this project's Deepgram entitlements.",
        helpText:
          "Text-to-speech runs on POST /v1/speak (mp3, 2,000 characters max). Transcription posts the clip's raw bytes to POST /v1/listen with punctuation, smart formatting, diarisation and utterance segmentation on, so the word table carries speaker labels.",
        ...(voices.length > 0 ? { voices } : {}),
        ...(defaultVoice ? { defaultVoice } : {}),
        voiceLabel: "Voice (Aura)",
        ...(models.length > 0 ? { models } : {}),
        ...(defaultModel ? { defaultModel } : {}),
        modelLabel: "Transcription Model",
        languages: DEEPGRAM_LANGUAGES,
        defaultLanguage: "en",
        maxCharacters: MAX_TTS_CHARACTERS,
        maxAudioBytes: MAX_AUDIO_BYTES,
        defaultText:
          "Deepgram Aura turns this sentence into speech in a couple of hundred milliseconds.",
        ...(voices.length === 0 && models.length === 0
          ? {
              disabledReason:
                "This API key can't read the model catalogue for this project. A key with at least the member scope is required.",
            }
          : {}),
      },
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const secret = resource.resolvedOutputs["apiKey"];
    return {
      title: resource.displayName,
      subtitle: "Deepgram API key",
      status: { kind: "status-dot", status: "healthy", label: String(f["scopes"] ?? "") || "key" },
      sections: [
        {
          kind: "section",
          title: "Key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key ID", value: String(f["apiKeyId"] ?? ""), copyable: true },
                { key: "Comment", value: String(f["comment"] ?? "") },
                { key: "Scopes", value: String(f["scopes"] ?? "") || "—" },
                ...(f["tags"] ? [{ key: "Tags", value: String(f["tags"]) }] : []),
                { key: "Created", value: String(f["created"] ?? "") },
                { key: "Expires", value: String(f["expirationDate"] ?? "") || "Never" },
                ...(f["memberEmail"] ? [{ key: "Owner", value: String(f["memberEmail"]) }] : []),
              ],
            },
            {
              kind: "text",
              content: secret
                ? "The secret below is shown once. Deepgram never returns it again — copy it now."
                : "Deepgram only returns a key's secret on the response that created it, so it cannot be revealed here.",
              variant: "muted",
            },
            ...(secret
              ? [
                  {
                    kind: "text" as const,
                    content: secret,
                    variant: "mono" as const,
                    copyable: true,
                  },
                ]
              : []),
          ],
        },
      ],
    };
  }

  private renderMemberDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: String(f["email"] ?? "Deepgram project member"),
      status: { kind: "status-dot", status: "healthy" },
      sections: [
        {
          kind: "section",
          title: "Member",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Email", value: String(f["email"] ?? ""), copyable: true },
                { key: "Member ID", value: String(f["memberId"] ?? ""), copyable: true },
                { key: "Scopes", value: String(f["scopes"] ?? "") || "—" },
              ],
            },
            {
              kind: "text",
              content:
                "Removing a member from a project also revokes every API key they own within it.",
              variant: "muted",
            },
          ],
        },
      ],
    };
  }

  private renderInviteDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Pending invitation",
      status: { kind: "status-dot", status: "provisioning", label: "pending" },
      sections: [
        {
          kind: "section",
          title: "Invitation",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Email", value: String(f["email"] ?? ""), copyable: true },
                { key: "Scope", value: String(f["scope"] ?? "") },
              ],
            },
          ],
        },
      ],
    };
  }

  private renderBalanceDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Prepaid balance",
      status: {
        kind: "status-dot",
        status: Number(f["amount"] ?? 0) > 0 ? "healthy" : "degraded",
      },
      sections: [
        {
          kind: "section",
          title: "Balance",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Amount", value: String(f["amount"] ?? "0") },
                { key: "Units", value: String(f["units"] ?? "") },
                { key: "Balance ID", value: String(f["balanceId"] ?? ""), copyable: true },
                ...(f["purchaseOrderId"]
                  ? [{ key: "Purchase Order", value: String(f["purchaseOrderId"]) }]
                  : []),
              ],
            },
            {
              kind: "text",
              content:
                "Deepgram exposes consumption and prepaid credit, but no quota ceiling — there is no used-vs-limit gauge to draw.",
              variant: "muted",
            },
          ],
        },
      ],
    };
  }

  private renderModelDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const family = String(f["family"] ?? "stt");
    const sample = resource.resolvedOutputs["sampleUrl"] ?? "";
    const image = resource.resolvedOutputs["imageUrl"] ?? "";
    return {
      title: resource.displayName,
      subtitle: family === "tts" ? "Aura text-to-speech voice" : "Speech-to-text model",
      status: {
        kind: "status-dot",
        status: "healthy",
        label: family.toUpperCase(),
      },
      sections: [
        {
          kind: "section",
          title: "Model",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Canonical Name", value: String(f["canonicalName"] ?? ""), copyable: true },
                ...(f["architecture"]
                  ? [{ key: "Architecture", value: String(f["architecture"]) }]
                  : []),
                ...(f["version"] ? [{ key: "Version", value: String(f["version"]) }] : []),
                ...(f["languages"] ? [{ key: "Languages", value: String(f["languages"]) }] : []),
                ...(f["accent"] ? [{ key: "Accent", value: String(f["accent"]) }] : []),
                ...(f["age"] ? [{ key: "Age", value: String(f["age"]) }] : []),
                ...(f["tags"] ? [{ key: "Characteristics", value: String(f["tags"]) }] : []),
                ...(f["useCases"] ? [{ key: "Use Cases", value: String(f["useCases"]) }] : []),
                ...(f["color"] ? [{ key: "Swatch", value: String(f["color"]) }] : []),
                ...(f["batch"] !== undefined
                  ? [{ key: "Batch", value: f["batch"] ? "Yes" : "No" }]
                  : []),
                ...(f["streaming"] !== undefined
                  ? [{ key: "Streaming", value: f["streaming"] ? "Yes" : "No" }]
                  : []),
                ...(f["uuid"] ? [{ key: "UUID", value: String(f["uuid"]), copyable: true }] : []),
              ],
            },
            {
              kind: "text",
              content: `Pass this as the \`model\` query parameter on ${family === "tts" ? "/v1/speak" : "/v1/listen"}.`,
              variant: "muted",
            },
          ],
        },
        ...(sample || image
          ? [
              {
                kind: "section" as const,
                title: "Voice Assets",
                children: [
                  ...(sample
                    ? [{ kind: "link" as const, label: "Play sample clip", url: sample }]
                    : []),
                  ...(image ? [{ kind: "link" as const, label: "Avatar image", url: image }] : []),
                ],
              },
            ]
          : []),
      ],
    };
  }

  private renderGenericDetail(resource: ResourceInstance): DetailViewSchema {
    return {
      title: resource.displayName,
      sections: [
        {
          kind: "section",
          title: "Details",
          children: [
            {
              kind: "key-value-list",
              items: Object.entries(resource.fields).map(([key, value]) => ({
                key,
                value: String(value),
              })),
            },
          ],
        },
      ],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    switch (resource.resourceTypeId) {
      case "project":
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "healthy", label: "Project" },
        };
      case "api-key":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: resource.fields["expirationDate"] ? "degraded" : "healthy",
            label: String(resource.fields["scopes"] ?? "") || "key",
          },
        };
      case "member":
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "healthy", label: "Member" },
        };
      case "invite":
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "provisioning", label: "Invited" },
        };
      case "balance":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: Number(resource.fields["amount"] ?? 0) > 0 ? "healthy" : "degraded",
            label: "Balance",
          },
        };
      case "model":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: "info",
            label: String(resource.fields["family"] ?? "").toUpperCase() || "Model",
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
}

/** Roll a usage breakdown up into the three counters the Overview shows. */
function summariseUsage(buckets: DgUsageBucket[]): {
  requests: number;
  hours: number;
  ttsCharacters: number;
} {
  let requests = 0;
  let hours = 0;
  let ttsCharacters = 0;
  for (const bucket of buckets) {
    requests += num(bucket.requests);
    hours += num(bucket.hours);
    ttsCharacters += num(bucket.tts_characters);
  }
  return { requests, hours, ttsCharacters };
}

/**
 * Language options for the transcription half. `multi` is Nova-3's
 * code-switching mode — it detects and transcribes several languages inside a
 * single clip; the older `detect_language` flag is Nova-2 only.
 */
const DEEPGRAM_LANGUAGES: SpeechPanelOption[] = [
  { id: "en", label: "English" },
  { id: "multi", label: "Multilingual", description: "Nova-3 code-switching across languages" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "de", label: "German" },
  { id: "it", label: "Italian" },
  { id: "pt", label: "Portuguese" },
  { id: "nl", label: "Dutch" },
  { id: "hi", label: "Hindi" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "zh", label: "Chinese" },
  { id: "ru", label: "Russian" },
  { id: "sv", label: "Swedish" },
  { id: "tr", label: "Turkish" },
  { id: "uk", label: "Ukrainian" },
];
