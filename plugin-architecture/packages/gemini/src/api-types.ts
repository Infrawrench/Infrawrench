/**
 * Wire types for the parts of the Gemini API on **AI Studio**
 * (`https://generativelanguage.googleapis.com/v1beta`) that its OpenAPI document
 * does not describe: Interactions, webhooks and voices. Everything else is
 * generated into `api-types.gen.ts` (see `plugingen.json`).
 *
 * This is not Vertex AI. Auth is the `x-goog-api-key` header: the legacy
 * `?key=` query parameter still works, but the header keeps the key out of
 * URLs and request logs.
 *
 * ⚠️ **There is no admin API, no usage API, no quota API and no billing API on
 * this host.** The live discovery document has zero occurrences of `billing`,
 * `apiKeys`, `admin` or `rateLimit`. Spend and quota live in the AI Studio UI
 * (and, underneath, in Google Cloud against the backing project, which needs
 * OAuth rather than an AI Studio key). The only in-API cost signal is the
 * per-response `usageMetadata` token count.
 */

// -----------------------------------------------------------------------------
// Interactions (TTS): https://ai.google.dev/api/interactions-api
// -----------------------------------------------------------------------------

/**
 * ⚠️ The Interactions API is **not** in the v1beta discovery document: it is
 * a separately hand-documented surface, though the route is live. Everything
 * below comes from ai.google.dev prose and the official code samples.
 *
 * `speech_config` is an **array** of speaker configs; a single-voice request
 * sends one entry.
 */
export interface InteractionRequest {
  model: string;
  input: string;
  response_format: { type: "audio" | "text" };
  generation_config?: {
    speech_config?: Array<{ voice?: string; speaker?: string; language?: string }>;
  };
}

/**
 * The base64 audio arrives at `interaction.output_audio.data`.
 *
 * `mime_type` is an enum that includes `audio/l16` (raw 16-bit linear PCM)
 * alongside real containers like `audio/wav` and `audio/mp3`. Gemini's TTS
 * models emit **headerless PCM at 24 000 Hz, mono, 16-bit**, which no browser
 * `<audio>` element can play, so the client reads `mime_type`, `sample_rate`
 * and `channels` at runtime and wraps the bytes in a WAV header itself when
 * the payload has no container.
 */
interface AudioContent {
  data?: string;
  mime_type?: string;
  sample_rate?: number;
  channels?: number;
}

export interface InteractionResponse {
  interaction?: {
    id?: string;
    status?: string;
    model?: string;
    created?: string;
    updated?: string;
    output_audio?: AudioContent;
    steps?: Array<{
      content?: Array<{ type?: string; data?: string; mime_type?: string; text?: string }>;
    }>;
    usage?: {
      total_input_tokens?: number;
      total_output_tokens?: number;
      total_tokens?: number;
    };
  };
}

/**
 * A webhook. Verified: https://ai.google.dev/api/webhooks
 * This surface is snake_case, unlike the camelCase resources above.
 */
export interface Webhook {
  id?: string;
  name?: string;
  uri?: string;
  subscribed_events?: string[];
  state?: "enabled" | "disabled" | "disabled_due_to_failed_deliveries";
  signing_secrets?: Array<{ expire_time?: string; truncated_secret?: string }>;
  new_signing_secret?: string;
  create_time?: string;
  update_time?: string;
}

/** What `PATCH /v1beta/webhooks/{id}` takes: only the fields named in `update_mask`. */
export interface WebhookUpdate {
  name?: string;
  uri?: string;
  subscribed_events?: string[];
  state?: "enabled" | "disabled";
}

export interface ListWebhooksResponse {
  webhooks?: Webhook[];
  next_page_token?: string;
}

/** A stored voice. Verified: https://ai.google.dev/api/voices (snake_case). */
export interface Voice {
  id?: string;
  display_name?: string;
  type?: "prompted" | "replicated" | "prebuilt";
  model?: string;
  language_code?: string;
  gender?: string;
  accent?: string;
  persona?: string;
  pitch?: string;
  context?: string;
  description?: string;
  expire_time?: string;
  prompted?: { input?: string; region_code?: string };
}

export interface ListVoicesResponse {
  voices?: Voice[];
  next_page_token?: string;
}
