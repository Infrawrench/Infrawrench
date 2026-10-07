import type {
  ChatMessage,
  ChatStreamEvent,
  DetailViewSchema,
  HostServices,
  HttpHostServices,
  PluginClient,
  PreflightResult,
  ResourceInstance,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TranscribeAudioPayload,
  TranscribeAudioResult,
} from "@infrawrench/plugin-base";
import {
  base64ToBytes,
  formatBytes,
  joinSubtitle,
  jsonRestFetch,
  streamOpenAiSseChat,
} from "@infrawrench/plugin-base";

/** OpenAI-compatible SambaCloud API. Spec: github.com/sambanova/sambanova-inference-api-spec */
export const API_BASE = "https://api.sambanova.ai/v1";
const CONSOLE_URL = "https://cloud.sambanova.ai";
/** Whisper on SambaCloud accepts files up to 25 MB. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

interface SnModel {
  id?: string;
  owned_by?: string;
  context_length?: number;
  max_completion_tokens?: number;
  pricing?: {
    prompt?: number | string;
    completion?: number | string;
    duration_per_hour?: number | string | null;
  };
  sn_metadata?: Record<string, unknown>;
}

function s(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function perMillion(perToken: number | string | undefined): number | "" {
  if (perToken === undefined || perToken === null || perToken === "") return "";
  const n = Number(perToken);
  return Number.isFinite(n) ? Math.round(n * 1e6 * 10000) / 10000 : "";
}

export function modelKind(id: string): "chat" | "transcription" | "embedding" {
  if (/whisper/i.test(id)) return "transcription";
  if (/embed/i.test(id)) return "embedding";
  return "chat";
}

function statusFromMessage(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const m = /API error (\d{3})\b/.exec(err.message);
  if (!m) return err;
  const status = Number(m[1]);
  return Object.assign(
    new Error(
      status === 401
        ? `${err.message} Check the API key on cloud.sambanova.ai under API Keys.`
        : err.message,
    ),
    { status },
  );
}

/**
 * SambaNova SambaCloud: the model catalogue (with list prices), a Playground
 * for chat models and a transcription test for Whisper models. SambaCloud
 * publishes no usage, billing, key-management or batch API.
 */
export class SambaNovaClient implements PluginClient {
  private readonly apiKey: string;
  private readonly caCert: string;
  private readonly http: HttpHostServices | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const apiKey = (credentials["apiKey"] ?? "").trim();
    if (!apiKey) throw new Error("SambaNova plugin: missing apiKey credential");
    this.apiKey = apiKey;
    this.caCert = credentials["caCert"] ?? "";
    this.http = services?.http;
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    try {
      return await jsonRestFetch<T>({
        vendor: "SambaNova",
        url: `${API_BASE}${path}`,
        errorPath: path,
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" },
        ...(init ? { init } : {}),
        ...(this.caCert ? { caCert: this.caCert } : {}),
        ...(this.http ? { http: this.http } : {}),
      });
    } catch (err) {
      throw statusFromMessage(err);
    }
  }

  /**
   * `GET /models` answers without checking the key, so validation uses
   * `POST /messages/count_tokens`, which authenticates but generates nothing.
   */
  async verifyCredentials(): Promise<PreflightResult> {
    try {
      await this.fetch("/messages/count_tokens", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-oss-120b",
          messages: [{ role: "user", content: "ping" }],
        }),
      });
      return { checks: [{ capabilityId: "inference", status: "ok" }] };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        return {
          checks: [
            {
              capabilityId: "inference",
              status: "missing",
              missingPermissions: [{ id: "api-key", label: "A valid SambaCloud API key" }],
              message: "SambaNova rejected the API key.",
              helpLink: { label: "Manage API keys", url: `${CONSOLE_URL}/apis` },
            },
          ],
        };
      }
      return {
        checks: [
          { capabilityId: "inference", status: "unknown", message: String((err as Error).message) },
        ],
      };
    }
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    if (typeId !== "sambanova-model")
      throw new Error(`SambaNova plugin: unknown resource type "${typeId}"`);
    const res = await this.fetch<{ data?: SnModel[] }>("/models");
    return (res.data ?? []).filter((m) => m.id).map((m) => this.mapModel(accountId, m));
  }

  private mapModel(accountId: string, m: SnModel): ResourceInstance {
    const id = s(m.id);
    const now = new Date().toISOString();
    return {
      id: `${accountId}:sambanova-model:${id}`,
      pluginId: "sambanova",
      resourceTypeId: "sambanova-model",
      accountId,
      displayName: id,
      externalId: id,
      fields: {
        modelId: id,
        kind: modelKind(id),
        ownedBy: s(m.owned_by),
        contextLength: m.context_length ?? "",
        maxCompletionTokens: m.max_completion_tokens ?? "",
        inputPricePerMillion: perMillion(m.pricing?.prompt),
        outputPricePerMillion: perMillion(m.pricing?.completion),
        pricePerAudioHour:
          m.pricing?.duration_per_hour !== undefined && m.pricing?.duration_per_hour !== null
            ? Number(m.pricing.duration_per_hour)
            : "",
      },
      resolvedOutputs: { modelId: id, baseUrl: API_BASE },
      secretStates: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /** `GET /models/{model_id}` */
  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id =
      resourceId.slice(`${accountId}:${typeId}:`.length) ||
      resourceId.split(":").slice(2).join(":");
    return this.mapModel(accountId, await this.fetch<SnModel>(`/models/${encodeURIComponent(id)}`));
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (outputKey === "baseUrl") return API_BASE;
    const r = await this.getResource(typeId, resourceId, accountId);
    return s(r.resolvedOutputs[outputKey] ?? r.fields[outputKey]);
  }

  /** `POST /chat/completions` with `stream: true`. */
  async *streamChatMessage(
    _typeId: string,
    resourceId: string,
    accountId: string,
    messages: ChatMessage[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const model =
      resourceId.slice(`${accountId}:sambanova-model:`.length) ||
      resourceId.split(":").slice(2).join(":");
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        kind: "error",
        message:
          res.status === 429
            ? "SambaNova rate limit reached (requests per minute or per day). The free tier has lower limits; linking a payment method raises them."
            : `Chat request failed (${res.status}): ${text.slice(0, 400) || res.statusText}`,
      };
      return;
    }
    yield* streamOpenAiSseChat(res.body);
  }

  /**
   * `POST /audio/transcriptions` (multipart). Uses global `fetch` with a real
   * `FormData`: the host HTTP service cannot carry multipart bodies.
   */
  async transcribeAudio(
    _typeId: string,
    resourceId: string,
    accountId: string,
    payload: TranscribeAudioPayload,
  ): Promise<TranscribeAudioResult> {
    const model =
      payload.modelId ||
      resourceId.slice(`${accountId}:sambanova-model:`.length) ||
      "Whisper-Large-v3";
    const bytes = base64ToBytes(payload.audioBase64);
    if (bytes.byteLength === 0) throw new Error("SambaNova plugin: empty audio clip");
    if (bytes.byteLength > MAX_AUDIO_BYTES) {
      throw new Error(
        `SambaNova plugin: clip is ${formatBytes(bytes.byteLength)}, over the 25 MB limit`,
      );
    }
    const form = new FormData();
    const ext = (payload.mimeType.split("/")[1] ?? "webm").split(";")[0];
    form.append(
      "file",
      new Blob([bytes], { type: payload.mimeType }),
      payload.fileName || `clip.${ext}`,
    );
    form.append("model", model);
    form.append("response_format", "json");
    if (payload.language) form.append("language", payload.language);
    const started = Date.now();
    const res = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      throw Object.assign(
        new Error(
          `SambaNova API error ${res.status} for /audio/transcriptions: ${await res.text()}`,
        ),
        { status: res.status },
      );
    }
    const body = (await res.json()) as { text?: string };
    return { text: s(body.text), summary: `${model} · ${Date.now() - started} ms` };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return {
      id: resource.id,
      label: resource.displayName,
      status: { kind: "status-dot", status: "healthy" },
    };
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const id = s(f["modelId"]) || (resource.externalId ?? resource.displayName);
    const kind = s(f["kind"]) || modelKind(id);
    const price = (v: unknown, unit: string) => (s(v) !== "" ? `$${s(v)} ${unit}` : "—");
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Model",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Model ID", value: id, copyable: true },
              { key: "Type", value: kind },
              { key: "Owned By", value: s(f["ownedBy"]) || "—" },
              {
                key: "Context Length",
                value: Number(f["contextLength"])
                  ? Number(f["contextLength"]).toLocaleString()
                  : "—",
              },
              {
                key: "Max Completion Tokens",
                value: Number(f["maxCompletionTokens"])
                  ? Number(f["maxCompletionTokens"]).toLocaleString()
                  : "—",
              },
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Pricing",
        children: [
          {
            kind: "key-value-list",
            items: [
              { key: "Input", value: price(f["inputPricePerMillion"], "/ 1M tokens") },
              { key: "Output", value: price(f["outputPricePerMillion"], "/ 1M tokens") },
              ...(s(f["pricePerAudioHour"]) !== ""
                ? [{ key: "Audio", value: price(f["pricePerAudioHour"], "/ hour") }]
                : []),
            ],
          },
          {
            kind: "text",
            variant: "muted",
            content:
              "SambaCloud has no usage or billing API: spend and rate-limit usage are on the Billing and Usage pages of the cloud console.",
          } as SchemaNode,
        ],
      },
      {
        kind: "section",
        title: "Endpoint",
        children: [
          {
            kind: "text",
            variant: "mono",
            copyable: true,
            content: `${API_BASE}/${kind === "transcription" ? "audio/transcriptions" : kind === "embedding" ? "embeddings" : "chat/completions"}`,
          },
        ],
      },
    ];
    return {
      title: id,
      subtitle: joinSubtitle("SambaNova Model", kind),
      status: { kind: "status-dot", status: "healthy", label: "Available" },
      sections,
      headerActions: [
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
        {
          kind: "action",
          label: "Usage in console",
          variant: "ghost",
          action: { type: "open-url", url: CONSOLE_URL },
        },
      ],
      ...(kind === "chat" ? { chatPanel: { subtitle: `${id} on SambaCloud` } } : {}),
      ...(kind === "transcription"
        ? {
            speechPanel: {
              modes: ["stt" as const],
              subtitle: `${id} on SambaCloud`,
              models: [{ id, label: id }],
              defaultModel: id,
              maxAudioBytes: MAX_AUDIO_BYTES,
              helpText: "Upload or record a clip of up to 25 MB.",
            },
          }
        : {}),
    };
  }
}
