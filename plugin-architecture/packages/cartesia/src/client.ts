import type {
  PluginClient,
  HostServices,
  ResourceInstance,
  DetailViewSchema,
  SidebarItemSchema,
  DashboardStat,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
  TranscriptWord,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  MetricSeries,
} from "@infrawrench/plugin-base";
import {
  base64ToBytes,
  bytesToBase64,
  jsonRestFetch,
  externalIdOf,
} from "@infrawrench/plugin-base";
import { cartesiaCostSetupError, fetchCartesiaCostData } from "./cost-data.js";
import { LANGUAGES } from "./languages.js";
import { mapAgent, mapPhoneNumber, renderAgentDetail, renderPhoneNumberDetail } from "./agents.js";
import type {
  CartesiaAgent,
  CartesiaAgentsResponse,
  CartesiaDeployment,
  CartesiaPhoneNumber,
} from "./agents.js";

const BASE_URL = "https://api.cartesia.ai";

/**
 * Cartesia pins its API to a date and rejects any request without it: this
 * header is mandatory on *every* call, including GETs. 2026-08-14 is the only
 * version the current reference accepts; it made `access` a plain string,
 * replaced `locales` with `accents` and dropped voice embeddings from TTS.
 * https://docs.cartesia.ai/api-reference/tts/bytes
 * https://docs.cartesia.ai/changelog/2026
 */
const CARTESIA_VERSION = "2026-08-14";

/** Cartesia has no GET /models endpoint: the TTS model list is a fixed enum. */
const SONIC_MODELS: SpeechPanelOption[] = [
  {
    id: "sonic-3.6",
    label: "Sonic 3.6",
    description: "Current flagship: most natural pacing and emotion, 44 languages",
  },
  { id: "sonic-3.5", label: "Sonic 3.5", description: "Previous generation" },
  { id: "sonic-3", label: "Sonic 3", description: "Older generation, pinned snapshot" },
  {
    id: "sonic-latest",
    label: "Sonic (latest)",
    description: "Rolling beta — can change without notice, not for production",
  },
];

const DEFAULT_MODEL = "sonic-3.6";

/** Cartesia's batch transcription API exposes exactly one model. */
const STT_MODEL = "ink-whisper";

/**
 * Formats the batch STT endpoint documents as accepted uploads.
 * https://docs.cartesia.ai/api-reference/stt/transcribe
 */
const ACCEPTED_AUDIO_TYPES = [
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".oga",
  ".ogg",
  ".wav",
  ".webm",
  "audio/*",
];

/**
 * Voice/dictionary/key listings all share one cursor envelope: `limit` +
 * `starting_after`, answered with `{ data, has_more, next_page }`.
 */
interface CartesiaPage<T> {
  data?: T[];
  has_more?: boolean;
  next_page?: string | null;
}

/** Pre-2026-08-14 object form of `access`; still tolerated on read. */
interface CartesiaAccess {
  type?: string;
  visibility?: string;
}

interface CartesiaVoice {
  id: string;
  name?: string;
  tagline?: string;
  description?: string;
  gender?: string | null;
  language?: string;
  /** Superseded by `accents` in 2026-08-14; still read when present. */
  locales?: Array<{ locale?: string } | string>;
  accents?: Array<{ accent?: string; locale?: string; is_native?: boolean }>;
  status?: string;
  visibility?: string;
  country?: string | null;
  created_at?: string;
  is_owner?: boolean;
  is_pro?: boolean;
  access?: CartesiaAccess | string;
  /** Null unless the request asked for `expand[]=preview_file_url`. */
  preview_file_url?: string | null;
}

interface CartesiaPronunciationItem {
  text?: string;
  pronunciation?: string;
  alias?: string;
  case_sensitive?: boolean;
}

interface CartesiaOrganizationUser {
  id: string;
  email?: string | null;
  name?: string | null;
  role?: string;
  created_at?: string;
}

interface CartesiaPronunciationDict {
  id: string;
  name?: string;
  description?: string;
  is_owner?: boolean;
  access?: CartesiaAccess | string;
  visibility?: string;
  pinned?: boolean;
  items?: CartesiaPronunciationItem[];
  created_at?: string;
}

interface CartesiaApiKey {
  id: string;
  description?: string;
  created_at?: string;
  creator_email?: string | null;
  creator_still_in_org?: boolean | null;
}

interface CartesiaCreditBucket {
  start_ts?: string;
  end_ts?: string;
  credits?: number;
  /** Present on breakdown series when `group_by` is set. */
  id?: string;
  /** Optional display name on a breakdown series (e.g. a voice or model name). */
  label?: string;
  buckets?: CartesiaCreditBucket[];
}

interface CartesiaCreditsResponse {
  group_by?: string;
  data?: CartesiaCreditBucket[];
}

interface CartesiaTranscript {
  type?: string;
  request_id?: string;
  text?: string;
  language?: string;
  duration?: number;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}

/** Guard rail on the shared voice library, which is far larger than one org. */
const MAX_LIST_PAGES = 5;
const PAGE_SIZE = 100;
/** How many voices the Speech tab's picker carries in the detail payload. */
const MAX_PICKER_VOICES = 200;

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function localeLabels(voice: CartesiaVoice): string {
  const fromAccents = (voice.accents ?? []).map((accent) => accent.locale ?? "");
  const fromLocales = (voice.locales ?? []).map((entry) =>
    typeof entry === "string" ? entry : (entry.locale ?? ""),
  );
  return [...new Set([...fromAccents, ...fromLocales].filter(Boolean))].join(", ");
}

function accentLabels(voice: CartesiaVoice): string {
  return (voice.accents ?? [])
    .map((accent) => accent.accent ?? "")
    .filter(Boolean)
    .join(", ");
}

/** `access` is a string from 2026-08-14 on and an object before it. */
function accessType(access: CartesiaAccess | string | undefined): string {
  if (typeof access === "string") return access;
  return str(access?.type);
}

function visibilityOf(record: { visibility?: string; access?: CartesiaAccess | string }): string {
  if (record.visibility) return record.visibility;
  return typeof record.access === "object" ? str(record.access.visibility) : "";
}

/**
 * Parse `text = pronunciation` entries, one per line or separated by
 * semicolons (the edit form is a single line). Malformed entries are an
 * error rather than silently dropped.
 */
export function parsePronunciationEntries(
  raw: string,
): Array<{ text: string; pronunciation: string }> {
  const entries: Array<{ text: string; pronunciation: string }> = [];
  const chunks = raw.split(/[\n;]/);
  for (const chunk of chunks) {
    const entry = chunk.trim();
    if (!entry) continue;
    const separator = entry.indexOf("=");
    const text = separator > 0 ? entry.slice(0, separator).trim() : "";
    const pronunciation = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!text || !pronunciation) {
      throw new Error(`Cartesia plugin: entry "${entry}" must look like "text = pronunciation"`);
    }
    entries.push({ text, pronunciation });
  }
  return entries;
}

function formatPronunciationEntries(items: CartesiaPronunciationItem[]): string {
  return items
    .map((item) => `${str(item.text)} = ${str(item.pronunciation ?? item.alias)}`)
    .join("; ");
}

function voiceSubtitle(voice: {
  language?: string;
  gender?: string | null;
  tagline?: string;
}): string {
  const parts = [voice.tagline, voice.language, voice.gender].map(str).filter(Boolean);
  return parts.join(" · ");
}

/**
 * Cartesia plugin client.
 *
 * Created per account. Every request carries `Authorization: Bearer sk_car_…`
 * plus the mandatory `Cartesia-Version` header. `/usage/credits` and
 * `/api-keys` are the two surfaces Cartesia gates behind a *separate* admin
 * key; when the account has none we degrade those to empty rather than
 * failing the whole account.
 */
export class CartesiaClient implements PluginClient {
  private readonly apiKey: string;
  private readonly adminApiKey: string;
  private readonly caCert: string;
  private readonly services: HostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = credentials["apiKey"];
    if (!apiKey) throw new Error("Cartesia plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.adminApiKey = credentials["adminApiKey"] ?? "";
    this.caCert = credentials["caCert"] ?? "";
    this.services = services;
  }

  /** True when the account carries the admin key the usage/keys APIs require. */
  private get hasAdminKey(): boolean {
    return this.adminApiKey.length > 0;
  }

  private headers(admin = false): Record<string, string> {
    const token = admin ? this.adminApiKey : this.apiKey;
    return {
      Authorization: `Bearer ${token}`,
      "Cartesia-Version": CARTESIA_VERSION,
      Accept: "application/json",
    };
  }

  private async fetch<T>(path: string, options?: RequestInit, admin = false): Promise<T> {
    if (admin && !this.hasAdminKey) {
      throw new Error(
        `Cartesia plugin: ${path} requires an admin API key (sk_car_admin_…); add one to this account to enable it`,
      );
    }
    return jsonRestFetch<T>({
      vendor: "Cartesia",
      url: `${BASE_URL}${path}`,
      errorPath: path,
      headers: this.headers(admin),
      ...(options ? { init: options } : {}),
      ...(this.services?.http ? { http: this.services.http } : {}),
      ...(this.caCert ? { caCert: this.caCert } : {}),
    });
  }

  /** Walk the shared `limit` / `starting_after` cursor until it runs out. */
  private async listPaginated<T>(
    path: string,
    params: Record<string, string | string[]>,
    admin = false,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams();
      query.set("limit", String(PAGE_SIZE));
      for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) for (const v of value) query.append(key, v);
        else query.set(key, value);
      }
      if (cursor) query.set("starting_after", cursor);

      const body = await this.fetch<CartesiaPage<T>>(
        `${path}?${query.toString()}`,
        undefined,
        admin,
      );
      const items = body.data ?? [];
      out.push(...items);
      // Phone numbers answer `has_more` without `next_page`; every list here
      // is keyed by `id`, so the last one is the documented cursor.
      const next = body.next_page ?? (items.at(-1) as { id?: string } | undefined)?.id;
      if (!body.has_more || !next) break;
      cursor = next;
    }

    return out;
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "voice":
        return (await this.fetchVoices()).map((voice) => this.mapVoice(accountId, voice));
      case "pronunciation-dict":
        return (await this.fetchPronunciationDicts()).map((dict) =>
          this.mapPronunciationDict(accountId, dict),
        );
      case "api-key":
        return (await this.fetchApiKeys()).map((key) => this.mapApiKey(accountId, key));
      case "agent":
        return (await this.fetchAgents()).map((agent) => mapAgent(accountId, agent));
      case "phone-number":
        return (await this.listPaginated<CartesiaPhoneNumber>("/agents/phone-numbers", {})).map(
          (phone) => mapPhoneNumber(accountId, phone),
        );
      case "organization-user":
        return (await this.fetchOrganizationUsers()).map((user) =>
          this.mapOrganizationUser(accountId, user),
        );
      default:
        throw new Error(`Cartesia plugin: unknown resource type "${typeId}"`);
    }
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "voice") {
      // GET /voices/{id}: verified 2026-07-28 against
      // https://docs.cartesia.ai/api-reference/voices/get
      // `preview_file_url` stays null unless expand[] asks for it.
      const query = new URLSearchParams();
      query.append("expand[]", "preview_file_url");
      const voice = await this.fetch<CartesiaVoice>(
        `/voices/${encodeURIComponent(externalId)}?${query.toString()}`,
      );
      const instance = this.mapVoice(accountId, voice);

      // renderDetail is synchronous, so the Speech tab's voice picker has to be
      // fetched here and stashed as JSON for renderDetail to parse back out.
      const picker = await this.fetchVoicePickerOptions();
      instance.resolvedOutputs = {
        ...instance.resolvedOutputs,
        __voices__: JSON.stringify(picker),
      };
      return instance;
    }

    if (typeId === "agent") {
      // Deployments ride along as JSON for the synchronous renderDetail.
      const [agent, deployments] = await Promise.all([
        this.fetch<CartesiaAgent>(`/agents/${encodeURIComponent(externalId)}`),
        this.fetch<CartesiaDeployment[]>(
          `/agents/${encodeURIComponent(externalId)}/deployments`,
        ).catch((): CartesiaDeployment[] => []),
      ]);
      const instance = mapAgent(accountId, agent);
      instance.resolvedOutputs["__deployments__"] = JSON.stringify(
        Array.isArray(deployments) ? deployments.slice(0, 20) : [],
      );
      return instance;
    }

    const all = await this.listResources(typeId, accountId);
    const found = all.find((resource) => resource.id === resourceId);
    if (!found) throw new Error(`Cartesia plugin: resource ${typeId}/${externalId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const f = resource.fields;

    if (typeId === "voice") {
      if (outputKey === "voiceId") return str(f["voiceId"]);
      if (outputKey === "voiceName") return str(f["name"]);
      if (outputKey === "language") return str(f["language"]);
      if (outputKey === "previewUrl") return str(f["previewUrl"]);
    }

    if (typeId === "pronunciation-dict") {
      if (outputKey === "dictId") return str(f["dictId"]);
      if (outputKey === "dictName") return str(f["name"]);
    }

    if (typeId === "api-key" && outputKey === "keyId") return str(f["keyId"]);

    if (typeId === "agent" && outputKey === "agentId") return str(f["agentId"]);
    if (typeId === "phone-number") {
      if (outputKey === "phoneNumber") return str(f["number"]);
      if (outputKey === "phoneNumberId") return str(f["phoneNumberId"]);
    }
    if (typeId === "organization-user") {
      if (outputKey === "userId") return str(f["userId"]);
      if (outputKey === "email") return str(f["email"]);
    }

    throw new Error(`Cartesia plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const resource = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = resource.fields;

    if (resourceTypeId === "voice") {
      return [
        { label: "Language", value: str(f["language"]) || "—" },
        { label: "Gender", value: str(f["gender"]) || "—" },
        { label: "Access", value: str(f["accessType"]) || "—" },
      ];
    }

    if (resourceTypeId === "pronunciation-dict") {
      return [
        { label: "Entries", value: str(f["entryCount"] ?? 0) },
        { label: "Access", value: str(f["accessType"]) || "—" },
        { label: "Owner", value: f["isOwner"] === true ? "You" : "Shared" },
      ];
    }

    if (resourceTypeId === "api-key") {
      // Cartesia reports consumption only: there is no plan ceiling on this
      // endpoint, so this is a spend figure and deliberately not a gauge.
      const keyId = str(f["keyId"]);
      const [keyCredits, orgCredits] = await Promise.all([
        this.fetchCredits(keyId),
        this.fetchCredits(),
      ]);
      return [
        {
          label: "Credits (30 d)",
          value: keyCredits === null ? "admin key required" : keyCredits.toLocaleString(),
        },
        {
          label: "Org credits (30 d)",
          value: orgCredits === null ? "admin key required" : orgCredits.toLocaleString(),
        },
        { label: "Created by", value: str(f["creatorEmail"]) || "—" },
      ];
    }

    if (resourceTypeId === "agent") {
      return [
        { label: "Language", value: str(f["ttsLanguage"]) || "-" },
        { label: "Deployments", value: str(f["deploymentCount"] ?? 0) },
        { label: "Phone", value: str(f["phoneNumbers"]) || "None" },
      ];
    }

    if (resourceTypeId === "phone-number") {
      return [
        { label: "Agent", value: str(f["agentName"]) || "Unassigned" },
        { label: "Provider", value: str(f["providerType"]) || "-" },
      ];
    }

    if (resourceTypeId === "organization-user") {
      return [
        { label: "Role", value: str(f["role"]) || "-" },
        { label: "Joined", value: str(f["joinedAt"]).slice(0, 10) || "-" },
      ];
    }

    return [];
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case "voice":
        return this.renderVoiceDetail(resource);
      case "pronunciation-dict":
        return this.renderPronunciationDictDetail(resource);
      case "api-key":
        return this.renderApiKeyDetail(resource);
      case "agent":
        return renderAgentDetail(resource);
      case "phone-number":
        return renderPhoneNumberDetail(resource);
      case "organization-user":
        return this.renderOrganizationUserDetail(resource);
      default:
        return {
          title: resource.displayName,
          subtitle: resource.resourceTypeId,
          status: { kind: "status-dot", status: "info" },
          sections: [],
          headerActions: [],
        };
    }
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    const f = resource.fields;
    switch (resource.resourceTypeId) {
      case "agent":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: Number(f["deploymentCount"] ?? 0) > 0 ? "healthy" : "info",
            ...(f["ttsLanguage"] ? { label: str(f["ttsLanguage"]) } : {}),
          },
        };
      case "phone-number":
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: f["agentId"] ? "healthy" : "info",
            label: str(f["agentName"]) || "Unassigned",
          },
        };
      case "organization-user":
        return {
          id: resource.id,
          label: resource.displayName,
          status: { kind: "status-dot", status: "healthy", label: str(f["role"]) || "member" },
        };
      default:
        return {
          id: resource.id,
          label: resource.displayName,
          status: {
            kind: "status-dot",
            status: f["isOwner"] === true ? "healthy" : "info",
          },
        };
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);

    if (typeId === "voice") {
      // DELETE /voices/{id}: verified 2026-07-28 against
      // https://docs.cartesia.ai/api-reference/voices/delete (204 No Content).
      await this.fetch(`/voices/${encodeURIComponent(externalId)}`, { method: "DELETE" });
      return;
    }

    if (typeId === "pronunciation-dict") {
      // DELETE /pronunciation-dicts/{id}: verified 2026-07-28 against
      // https://docs.cartesia.ai/api-reference/pronunciation-dicts/delete
      // (no trailing slash here, unlike the list endpoint).
      await this.fetch(`/pronunciation-dicts/${encodeURIComponent(externalId)}`, {
        method: "DELETE",
      });
      return;
    }

    if (typeId === "agent") {
      // DELETE /agents/{agent_id}: https://docs.cartesia.ai/api-reference/agents/agents/delete (204)
      await this.fetch(`/agents/${encodeURIComponent(externalId)}`, { method: "DELETE" });
      return;
    }

    if (typeId === "organization-user") {
      // DELETE /organizations/users/{id}: admin key only, and refused for
      // admins. https://docs.cartesia.ai/api-reference/organizations/remove-user
      await this.fetch(
        `/organizations/users/${encodeURIComponent(externalId)}`,
        { method: "DELETE" },
        true,
      );
      return;
    }

    throw new Error(`Cartesia plugin: cannot delete type "${typeId}"`);
  }

  // ---- Create and edit -----------------------------------------------------

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    if (typeId === "pronunciation-dict") {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "entries",
            label: "Entries",
            kind: "text",
            multiline: true,
            required: false,
            description:
              "One entry per line, written as text = pronunciation. The pronunciation can be a respelling or IPA.",
            placeholder: "Cartesia = car-TEE-zha\nSQL = sequel",
          },
          {
            key: "accessType",
            label: "Access",
            kind: "select",
            required: true,
            defaultValue: "private",
            options: [
              { id: "private", label: "Private", description: "Only your organization can use it" },
              {
                id: "public",
                label: "Public",
                description: "Anyone with the dictionary ID can use it",
              },
            ],
          },
        ],
      };
    }
    throw new Error(`Cartesia plugin: cannot create resources of type "${typeId}"`);
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    if (typeId === "pronunciation-dict") {
      const name = (fields["name"] ?? "").trim();
      if (!name) throw new Error("Cartesia plugin: a pronunciation dictionary needs a name");
      const items = parsePronunciationEntries(fields["entries"] ?? "");
      // POST /pronunciation-dicts/: https://docs.cartesia.ai/api-reference/pronunciation-dicts/create
      const created = await this.fetch<CartesiaPronunciationDict>("/pronunciation-dicts/", {
        method: "POST",
        body: JSON.stringify({
          name,
          access: fields["accessType"] === "public" ? "public" : "private",
          ...(fields["description"] ? { description: fields["description"] } : {}),
          ...(items.length ? { items } : {}),
        }),
      });
      return this.mapPronunciationDict(accountId, created);
    }
    throw new Error(`Cartesia plugin: cannot create resources of type "${typeId}"`);
  }

  /**
   * PATCH with only the changed keys:
   * - voice: `PATCH /voices/{id}` (name, tagline, description, gender, access)
   * - pronunciation-dict: `PATCH /pronunciation-dicts/{id}` (name, description,
   *   access, items). Editing entries replaces the whole list, so the case
   *   sensitivity of entries whose text is unchanged is carried over.
   * - agent: `PATCH /agents/{id}` (name, description, language, noise suppression)
   * https://docs.cartesia.ai/api-reference/voices/update
   * https://docs.cartesia.ai/api-reference/pronunciation-dicts/update
   * https://docs.cartesia.ai/api-reference/agents/agents/update
   */
  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const encoded = encodeURIComponent(externalIdOf(resourceId));

    if (typeId === "voice") {
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined)
        body["name"] = requireNonEmpty(fields["name"], "voice name");
      if (fields["tagline"] !== undefined) {
        if (fields["tagline"].length > 32) {
          throw new Error("Cartesia plugin: a voice tagline is at most 32 characters");
        }
        body["tagline"] = fields["tagline"];
      }
      if (fields["description"] !== undefined) body["description"] = fields["description"];
      if (fields["gender"] !== undefined) body["gender"] = fields["gender"] || null;
      if (fields["accessType"] !== undefined) body["access"] = fields["accessType"];
      if (Object.keys(body).length) {
        await this.fetch(`/voices/${encoded}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      return this.getResource("voice", resourceId, accountId);
    }

    if (typeId === "pronunciation-dict") {
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined) {
        body["name"] = requireNonEmpty(fields["name"], "dictionary name");
      }
      if (fields["description"] !== undefined) body["description"] = fields["description"];
      if (fields["accessType"] !== undefined) body["access"] = fields["accessType"];
      if (fields["entries"] !== undefined) {
        const current = await this.getResource("pronunciation-dict", resourceId, accountId);
        const previous = parsePronunciationItems(current.resolvedOutputs["__items__"]);
        body["items"] = parsePronunciationEntries(fields["entries"]).map((entry) => {
          const match = previous.find((item) => item.text === entry.text);
          return match?.case_sensitive !== undefined
            ? { ...entry, case_sensitive: match.case_sensitive }
            : entry;
        });
      }
      if (Object.keys(body).length) {
        const updated = await this.fetch<CartesiaPronunciationDict>(
          `/pronunciation-dicts/${encoded}`,
          { method: "PATCH", body: JSON.stringify(body) },
        );
        if (updated?.id) return this.mapPronunciationDict(accountId, updated);
      }
      return this.getResource("pronunciation-dict", resourceId, accountId);
    }

    if (typeId === "agent") {
      const body: Record<string, unknown> = {};
      if (fields["name"] !== undefined)
        body["name"] = requireNonEmpty(fields["name"], "agent name");
      if (fields["description"] !== undefined) body["description"] = fields["description"] || null;
      if (fields["ttsLanguage"] !== undefined) body["tts_language"] = fields["ttsLanguage"];
      if (fields["noiseSuppressionLevel"] !== undefined) {
        const level = Number(fields["noiseSuppressionLevel"]);
        if (!Number.isInteger(level) || level < 0 || level > 100) {
          throw new Error(
            "Cartesia plugin: noise suppression must be a whole number from 0 to 100",
          );
        }
        body["noise_suppression_level"] = level;
      }
      if (Object.keys(body).length) {
        await this.fetch(`/agents/${encoded}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      return this.getResource("agent", resourceId, accountId);
    }

    throw new Error(`Cartesia plugin: cannot update type "${typeId}"`);
  }

  // ---- Metrics -------------------------------------------------------------

  /**
   * Daily credit consumption from `GET /usage/credits?interval=day`: filtered
   * with `api_key_id` for an API key, and broken down with `group_by=voice`
   * for a voice (the series whose `id` is the voice). An API key also gets
   * its credits split by capability (`api_key_id` + `group_by=capability`;
   * the docs only rule out pairing `api_key_id` with `group_by=api_key`).
   * Admin key only; with none there is nothing to chart and this returns no
   * series.
   * https://docs.cartesia.ai/api-reference/usage/credits
   */
  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    if (!this.hasAdminKey) return [];
    if (resourceTypeId !== "api-key" && resourceTypeId !== "voice") return [];

    const externalId = externalIdOf(resourceId);
    const endMs = timeRange?.endMs ?? Date.now();
    const startMs = timeRange?.startMs ?? endMs - 30 * 24 * 60 * 60 * 1000;
    const credits = (params: Record<string, string>): Promise<CartesiaCreditsResponse> => {
      const query = new URLSearchParams();
      query.set("start_ts", new Date(startMs).toISOString());
      query.set("end_ts", new Date(endMs).toISOString());
      query.set("interval", "day");
      for (const [key, value] of Object.entries(params)) query.set(key, value);
      return this.fetch<CartesiaCreditsResponse>(
        `/usage/credits?${query.toString()}`,
        undefined,
        true,
      );
    };

    if (resourceTypeId === "voice") {
      const body = await credits({ group_by: "voice" });
      const buckets = (body.data ?? []).find((series) => series.id === externalId)?.buckets ?? [];
      return [{ label: "Credits", unit: "credits", points: creditPoints(buckets) }];
    }

    const [total, byCapability] = await Promise.all([
      credits({ api_key_id: externalId }),
      // The split is an extra: a refusal there must not blank the total.
      credits({ api_key_id: externalId, group_by: "capability" }).catch(
        (): CartesiaCreditsResponse => ({}),
      ),
    ]);
    const series: MetricSeries[] = [
      { label: "Credits", unit: "credits", points: creditPoints(total.data ?? []) },
    ];
    for (const entry of byCapability.data ?? []) {
      const points = creditPoints(entry.buckets ?? []);
      if (!entry.id || !points.some((p) => p.value !== 0)) continue;
      series.push({
        label: `Credits: ${str(entry.label) || entry.id}`,
        unit: "credits",
        points,
      });
    }
    return series;
  }

  // ---- Speech tab ----------------------------------------------------------

  async synthesizeSpeech(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: SynthesizeSpeechPayload,
  ): Promise<SynthesizeSpeechResult> {
    if (typeId !== "voice") {
      throw new Error(`Cartesia plugin: cannot synthesize speech for type "${typeId}"`);
    }

    const voiceId = payload.voiceId || externalIdOf(resourceId);
    if (!voiceId) throw new Error("Cartesia plugin: no voice selected for synthesis");
    const modelId = payload.modelId || DEFAULT_MODEL;

    const started = Date.now();
    const { bytes, requestId } = await this.ttsBytes({
      model_id: modelId,
      transcript: payload.text,
      // The voice is part of the body, not the path, and always arrives as an
      // object rather than a bare id.
      voice: { id: voiceId },
      // Required: Cartesia has no server-side default. For mp3 the object is
      // container/sample_rate/bit_rate only; adding an `encoding` key here is
      // rejected with a 400.
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
    });
    const elapsedMs = Date.now() - started;

    const characters = payload.text.length;
    return {
      audioBase64: bytesToBase64(bytes),
      mimeType: "audio/mpeg",
      fileName: `cartesia-${voiceId}.mp3`,
      summary: `${modelId} · ${characters.toLocaleString()} characters · mp3 44.1 kHz 128 kbps · ${elapsedMs} ms`,
      characters,
      ...(requestId ? { requestId } : {}),
    };
  }

  async transcribeAudio(
    typeId: string,
    _resourceId: string,
    _accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    if (typeId !== "voice") {
      throw new Error(`Cartesia plugin: cannot transcribe audio for type "${typeId}"`);
    }

    const result = await this.sttTranscribe(payload);

    const words: TranscriptWord[] = (result.words ?? [])
      .filter((word) => typeof word.word === "string")
      .map((word) => ({
        text: str(word.word),
        ...(typeof word.start === "number" ? { start: word.start } : {}),
        ...(typeof word.end === "number" ? { end: word.end } : {}),
      }));

    const duration = typeof result.duration === "number" ? result.duration : undefined;
    const summaryParts = [STT_MODEL];
    if (duration !== undefined) summaryParts.push(`${duration.toFixed(1)} s of audio`);
    if (words.length > 0) summaryParts.push(`${words.length} words`);

    return {
      text: str(result.text),
      summary: summaryParts.join(" · "),
      ...(result.language ? { language: result.language } : {}),
      ...(duration !== undefined ? { durationSeconds: duration } : {}),
      ...(words.length > 0 ? { words } : {}),
      ...(result.request_id ? { requestId: result.request_id } : {}),
    };
  }

  /**
   * POST /tts/bytes: verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/tts/bytes
   *
   * Deliberately not routed through `jsonRestFetch`: that helper JSON-parses
   * every response, and this one is raw mp3. Using the global `fetch` here
   * means this single call bypasses bastion egress routing and the custom CA
   * credential; all the JSON control-plane calls still go through the host.
   */
  private async ttsBytes(
    body: Record<string, unknown>,
  ): Promise<{ bytes: Uint8Array; requestId?: string }> {
    const res = await fetch(`${BASE_URL}/tts/bytes`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(body),
    });

    // A failed call answers with JSON where we expected audio, so branch on the
    // status *before* touching the body.
    if (!res.ok) {
      throw new Error(`Cartesia API error ${res.status} for /tts/bytes: ${await safeText(res)}`);
    }

    const requestId = headerValue(res, "x-request-id");
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      ...(requestId ? { requestId } : {}),
    };
  }

  /**
   * POST /stt: verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/stt/transcribe
   *
   * multipart/form-data, so this also goes through the global `fetch`:
   * `jsonRestFetch`'s host-HTTP path stringifies FormData rather than
   * encoding it. The clip's Content-Type is whatever MediaRecorder or the
   * file picker produced: forwarded verbatim, never transcoded.
   */
  private async sttTranscribe(payload: TranscribeAudioPayload): Promise<CartesiaTranscript> {
    const bytes = base64ToBytes(payload.audioBase64);
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: payload.mimeType }),
      payload.fileName ?? fileNameFor(payload.mimeType),
    );
    // Ink Whisper is the only transcription model Cartesia exposes; the Speech
    // tab's model picker drives synthesis, not this call.
    form.append("model", STT_MODEL);
    if (payload.language) form.append("language", payload.language);
    form.append("timestamp_granularities[]", "word");

    // No Content-Type header: fetch has to set it so the multipart boundary
    // matches the body it generated.
    const res = await fetch(`${BASE_URL}/stt`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Cartesia API error ${res.status} for /stt: ${await safeText(res)}`);
    }
    return (await res.json()) as CartesiaTranscript;
  }

  // ---- Listing -------------------------------------------------------------

  /**
   * GET /voices: verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/voices/list
   *
   * `expand[]=preview_file_url` is required: without it every voice comes back
   * with `preview_file_url: null`.
   */
  private async fetchVoices(): Promise<CartesiaVoice[]> {
    return this.listPaginated<CartesiaVoice>("/voices", {
      "expand[]": ["preview_file_url"],
    });
  }

  private async fetchVoicePickerOptions(): Promise<SpeechPanelOption[]> {
    const voices = await this.fetchVoices();
    return voices.slice(0, MAX_PICKER_VOICES).map((voice) => {
      const description = voiceSubtitle(voice);
      return {
        id: voice.id,
        label: str(voice.name) || voice.id,
        ...(description ? { description } : {}),
      };
    });
  }

  /**
   * GET /pronunciation-dicts/: verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/pronunciation-dicts/list
   * The trailing slash is part of the documented path.
   */
  private async fetchPronunciationDicts(): Promise<CartesiaPronunciationDict[]> {
    return this.listPaginated<CartesiaPronunciationDict>("/pronunciation-dicts/", {});
  }

  /**
   * GET /api-keys: verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/api-keys/list
   * Admin-key only; without one we list nothing rather than break the account.
   */
  private async fetchApiKeys(): Promise<CartesiaApiKey[]> {
    if (!this.hasAdminKey) return [];
    return this.listPaginated<CartesiaApiKey>("/api-keys", {}, true);
  }

  /**
   * GET /agents: https://docs.cartesia.ai/api-reference/agents/agents/list
   * Unpaginated; answers `{ summaries }` (the `data` envelope is tolerated).
   */
  private async fetchAgents(): Promise<CartesiaAgent[]> {
    const body = await this.fetch<CartesiaAgentsResponse>("/agents");
    return (body.summaries ?? body.data ?? []).filter((agent) => !agent.deleted_at);
  }

  /**
   * GET /organizations/users: admin key only, newest first.
   * https://docs.cartesia.ai/api-reference/organizations/list-users
   */
  private async fetchOrganizationUsers(): Promise<CartesiaOrganizationUser[]> {
    if (!this.hasAdminKey) return [];
    return this.listPaginated<CartesiaOrganizationUser>("/organizations/users", {}, true);
  }

  /**
   * GET /usage/credits: verified 2026-07-28 against
   * https://docs.cartesia.ai/api-reference/usage/credits
   *
   * Admin-key only, and consumption-only: there is no plan limit in the
   * response, so this is never rendered as a used-vs-limit gauge. Returns
   * `null` when the account has no admin key.
   */
  private async fetchCredits(apiKeyId?: string): Promise<number | null> {
    if (!this.hasAdminKey) return null;

    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const query = new URLSearchParams();
    query.set("start_ts", start.toISOString());
    query.set("end_ts", end.toISOString());
    if (apiKeyId) query.set("api_key_id", apiKeyId);

    const body = await this.fetch<CartesiaCreditsResponse>(
      `/usage/credits?${query.toString()}`,
      undefined,
      true,
    );
    return (body.data ?? []).reduce((sum, bucket) => sum + (bucket.credits ?? 0), 0);
  }

  // ---- Cost ----------------------------------------------------------------

  /**
   * Daily spend from `GET /usage/credits`, grouped by capability. The work
   * lives in `cost-data.ts` so it can be tested without a client; this hands it
   * the admin key and the host's HTTP/CA settings.
   *
   * The admin-key guard is repeated here so the failure is visible at the
   * host-facing entry point, not buried a call away: without an admin key the
   * endpoint is unreachable and the account would otherwise report no spend
   * forever rather than telling the user what to do.
   */
  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    if (!this.hasAdminKey) throw cartesiaCostSetupError();

    return fetchCartesiaCostData(
      {
        adminApiKey: this.adminApiKey,
        apiVersion: CARTESIA_VERSION,
        baseUrl: BASE_URL,
        ...(this.services?.http ? { http: this.services.http } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
      },
      range,
    );
  }

  // ---- Mapping -------------------------------------------------------------

  private mapVoice(accountId: string, voice: CartesiaVoice): ResourceInstance {
    const now = new Date().toISOString();
    const createdAt = voice.created_at ?? now;
    return {
      id: `${accountId}:voice:${voice.id}`,
      pluginId: "cartesia",
      resourceTypeId: "voice",
      accountId,
      displayName: str(voice.name) || voice.id,
      externalId: voice.id,
      fields: {
        name: str(voice.name),
        voiceId: voice.id,
        tagline: str(voice.tagline),
        description: str(voice.description),
        language: str(voice.language),
        locales: localeLabels(voice),
        accents: accentLabels(voice),
        gender: str(voice.gender),
        country: str(voice.country),
        status: str(voice.status) || "active",
        accessType: accessType(voice.access),
        visibility: visibilityOf(voice),
        isOwner: voice.is_owner === true,
        isPro: voice.is_pro === true,
        previewUrl: str(voice.preview_file_url),
        createdAt,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt,
      updatedAt: now,
    };
  }

  private mapPronunciationDict(
    accountId: string,
    dict: CartesiaPronunciationDict,
  ): ResourceInstance {
    const now = new Date().toISOString();
    const createdAt = dict.created_at ?? now;
    const items = dict.items ?? [];
    return {
      id: `${accountId}:pronunciation-dict:${dict.id}`,
      pluginId: "cartesia",
      resourceTypeId: "pronunciation-dict",
      accountId,
      displayName: str(dict.name) || dict.id,
      externalId: dict.id,
      fields: {
        name: str(dict.name),
        dictId: dict.id,
        description: str(dict.description),
        entries: formatPronunciationEntries(items),
        entryCount: items.length,
        accessType: accessType(dict.access),
        visibility: visibilityOf(dict),
        isOwner: dict.is_owner === true,
        pinned: dict.pinned === true,
        createdAt,
      },
      // renderDetail can't call the API, so the entries ride along as JSON.
      resolvedOutputs: { __items__: JSON.stringify(items) },
      secretStates: [],
      createdAt,
      updatedAt: now,
    };
  }

  private mapApiKey(accountId: string, key: CartesiaApiKey): ResourceInstance {
    const now = new Date().toISOString();
    const createdAt = key.created_at ?? now;
    return {
      id: `${accountId}:api-key:${key.id}`,
      pluginId: "cartesia",
      resourceTypeId: "api-key",
      accountId,
      displayName: str(key.description) || key.id,
      externalId: key.id,
      fields: {
        keyId: key.id,
        description: str(key.description),
        creatorEmail: str(key.creator_email),
        creatorStillInOrg: key.creator_still_in_org === true,
        createdAt,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt,
      updatedAt: now,
    };
  }

  private mapOrganizationUser(accountId: string, user: CartesiaOrganizationUser): ResourceInstance {
    const now = new Date().toISOString();
    const joinedAt = user.created_at ?? now;
    return {
      id: `${accountId}:organization-user:${user.id}`,
      pluginId: "cartesia",
      resourceTypeId: "organization-user",
      accountId,
      displayName: str(user.name) || str(user.email) || user.id,
      externalId: user.id,
      fields: {
        email: str(user.email),
        name: str(user.name),
        role: str(user.role),
        userId: user.id,
        joinedAt,
      },
      resolvedOutputs: {},
      secretStates: [],
      createdAt: joinedAt,
      updatedAt: now,
    };
  }

  // ---- Detail views --------------------------------------------------------

  private renderVoiceDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const voiceId = str(f["voiceId"]) || resource.externalId || "";
    const name = str(f["name"]) || resource.displayName;

    const voices = parseVoiceOptions(resource.resolvedOutputs?.["__voices__"]);
    if (!voices.some((option) => option.id === voiceId) && voiceId) {
      const description = voiceSubtitle({
        language: str(f["language"]),
        gender: str(f["gender"]),
        tagline: str(f["tagline"]),
      });
      voices.unshift({ id: voiceId, label: name, ...(description ? { description } : {}) });
    }

    const previewUrl = str(f["previewUrl"]);

    return {
      title: name,
      subtitle: `Cartesia Voice · ${str(f["language"]) || "unknown language"}`,
      status: { kind: "status-dot", status: f["isOwner"] === true ? "healthy" : "info" },
      sections: [
        {
          kind: "section",
          title: "Voice",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Voice ID", value: voiceId || "—" },
                { key: "Tagline", value: str(f["tagline"]) || "—" },
                { key: "Description", value: str(f["description"]) || "—" },
                { key: "Language", value: str(f["language"]) || "—" },
                { key: "Locales", value: str(f["locales"]) || "—" },
                { key: "Accents", value: str(f["accents"]) || "-" },
                { key: "Gender", value: str(f["gender"]) || "—" },
                { key: "Country", value: str(f["country"]) || "—" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Access",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Status", value: str(f["status"]) || "-" },
                { key: "Access", value: str(f["accessType"]) || "—" },
                { key: "Visibility", value: str(f["visibility"]) || "—" },
                { key: "Owned by You", value: f["isOwner"] === true ? "Yes" : "No" },
                { key: "Pro Voice Clone", value: f["isPro"] === true ? "Yes" : "No" },
                { key: "Created", value: str(f["createdAt"]) || "—" },
                {
                  key: "Preview Audio",
                  value:
                    previewUrl || "— (Cartesia only returns this with expand[]=preview_file_url)",
                },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      metricsCapability: { defaultTimeRangeMs: 30 * 24 * 60 * 60 * 1000 },
      speechPanel: {
        modes: ["tts", "stt"],
        subtitle: `Sonic text-to-speech and Ink Whisper transcription · ${name}`,
        helpText:
          "The model picker applies to synthesis. Transcription always runs on ink-whisper — Cartesia's only transcription model — and the language picker applies to it. Audio comes back as 44.1 kHz 128 kbps mp3.",
        voices,
        ...(voiceId ? { defaultVoice: voiceId } : {}),
        voiceLabel: "Voice",
        models: SONIC_MODELS,
        defaultModel: DEFAULT_MODEL,
        modelLabel: "Synthesis model",
        languages: LANGUAGES,
        defaultLanguage: "en",
        languageLabel: "Transcription language",
        acceptedAudioTypes: ACCEPTED_AUDIO_TYPES,
        // No maxCharacters: Cartesia documents no per-request transcript limit,
        // so we let the provider's own error surface rather than guessing one.
      },
    };
  }

  private renderPronunciationDictDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const items = parsePronunciationItems(resource.resolvedOutputs?.["__items__"]);

    return {
      title: str(f["name"]) || resource.displayName,
      subtitle: `Cartesia Pronunciation Dictionary · ${items.length} ${
        items.length === 1 ? "entry" : "entries"
      }`,
      status: { kind: "status-dot", status: f["isOwner"] === true ? "healthy" : "info" },
      sections: [
        {
          kind: "section",
          title: "Dictionary",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Dictionary ID", value: str(f["dictId"]) || "—" },
                { key: "Description", value: str(f["description"]) || "—" },
                { key: "Access", value: str(f["accessType"]) || "—" },
                { key: "Visibility", value: str(f["visibility"]) || "—" },
                { key: "Owned by You", value: f["isOwner"] === true ? "Yes" : "No" },
                { key: "Pinned", value: f["pinned"] === true ? "Yes" : "No" },
                { key: "Created", value: str(f["createdAt"]) || "—" },
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Entries",
          children: [
            {
              kind: "key-value-list",
              items:
                items.length > 0
                  ? items.map((item) => ({
                      key: str(item.text) || "—",
                      value: str(item.pronunciation ?? item.alias) || "—",
                    }))
                  : [{ key: "Entries", value: "None" }],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderOrganizationUserDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: resource.displayName,
      subtitle: "Cartesia Organization Member",
      status: { kind: "status-dot", status: "healthy", label: str(f["role"]) || "member" },
      sections: [
        {
          kind: "section",
          title: "Member",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Name", value: str(f["name"]) || "-" },
                { key: "Email", value: str(f["email"]) || "-" },
                { key: "Role", value: str(f["role"]) || "-" },
                { key: "User ID", value: str(f["userId"]) || "-", copyable: true },
                { key: "Joined", value: str(f["joinedAt"]) || "-" },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderApiKeyDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    return {
      title: str(f["description"]) || resource.displayName,
      subtitle: "Cartesia API Key",
      status: { kind: "status-dot", status: "info" },
      sections: [
        {
          kind: "section",
          title: "Key",
          children: [
            {
              kind: "key-value-list",
              items: [
                { key: "Key ID", value: str(f["keyId"]) || "—" },
                { key: "Description", value: str(f["description"]) || "—" },
                { key: "Created By", value: str(f["creatorEmail"]) || "—" },
                {
                  key: "Creator Still in Org",
                  value: f["creatorStillInOrg"] === true ? "Yes" : "No",
                },
                { key: "Created", value: str(f["createdAt"]) || "—" },
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
      metricsCapability: { defaultTimeRangeMs: 30 * 24 * 60 * 60 * 1000 },
    };
  }
}

function requireNonEmpty(value: string, what: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Cartesia plugin: the ${what} cannot be empty`);
  return trimmed;
}

function parseVoiceOptions(raw: string | undefined): SpeechPanelOption[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SpeechPanelOption =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as SpeechPanelOption).id === "string",
    );
  } catch {
    return [];
  }
}

function parsePronunciationItems(raw: string | undefined): CartesiaPronunciationItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CartesiaPronunciationItem[]) : [];
  } catch {
    return [];
  }
}

/** Best-effort extension so the upload keeps a name the provider recognises. */
function fileNameFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim() ?? "";
  const map: Record<string, string> = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "video/webm": "webm",
    "video/mp4": "mp4",
  };
  return `recording.${map[base] ?? "webm"}`;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

function headerValue(res: Response, name: string): string | undefined {
  return res.headers?.get?.(name) ?? undefined;
}

/** Credit buckets as chart points, oldest first; unparseable timestamps dropped. */
function creditPoints(
  buckets: CartesiaCreditBucket[],
): Array<{ timestamp: number; value: number }> {
  return buckets
    .map((bucket) => ({
      timestamp: Date.parse(str(bucket.start_ts)),
      value: bucket.credits ?? 0,
    }))
    .filter((point) => Number.isFinite(point.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
}
