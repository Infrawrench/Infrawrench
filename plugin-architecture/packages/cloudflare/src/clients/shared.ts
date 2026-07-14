/**
 * Shared Cloudflare API client used by all per-feature client modules.
 *
 * Wraps the official `cloudflare` SDK and caches the resolved account ID.
 * The `fetch` escape hatch remains because the SDK does not expose the R2
 * object plane — see `r2-client.ts`. New code should prefer the SDK
 * namespaces exposed via `api.cf`.
 */
import Cloudflare from "cloudflare";
import type { Zone } from "cloudflare/resources/zones/zones";

/**
 * Detects auth/permission errors from the Cloudflare SDK.
 *
 * Cloudflare API tokens are scoped, and users routinely create tokens that
 * cover only the resources they actually use (e.g. an "edit DNS" token won't
 * have Hyperdrive read). When such a token tries to list a resource it
 * doesn't have permission for, the SDK throws either:
 *   - An HTTP 403 `PermissionDeniedError` / 401 `AuthenticationError`, or
 *   - A 200/4xx body with `success: false` and an `errors[].code === 10000`
 *     "Authentication error" — Cloudflare's catch-all auth-failure code.
 *
 * Returns true for any of these shapes. Falls back to duck-typing on the
 * error fields rather than `instanceof` because the SDK is bundled into a
 * single dependency tree and `instanceof` checks across re-exports are
 * brittle. Anything else (5xx, network, malformed JSON) returns false so
 * those real bugs continue to surface.
 */
function isCloudflareAuthError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as {
    status?: unknown;
    errors?: Array<{ code?: unknown }>;
    message?: unknown;
  };

  // Collect every numeric Cloudflare error code we can find — from the
  // structured `.errors` array and from any JSON body embedded in the message
  // string (the raw-fetch / SDK-stringified path).
  const codes = collectCloudflareErrorCodes(e);
  // 10000 — generic "Authentication error"; 9109 — "Unauthorized to access
  // requested resource" (returned when the token lacks a per-resource scope).
  if (codes.some((c) => c === 10000 || c === 9109)) return true;
  // A specific non-auth code (e.g. 9999 "Access is not enabled") means the
  // token is fine — the failure is something else. Don't claim a missing
  // permission, even on a 403.
  if (codes.length > 0) return false;

  // No machine code to go on: fall back to the HTTP status and the raw-fetch
  // message shape so resource types still on raw fetch (e.g. workers-ai) also
  // benefit from the friendly hint.
  if (e.status === 401 || e.status === 403) return true;
  if (typeof e.message === "string") {
    if (/error\s+40[13]/i.test(e.message)) return true;
    if (e.message.includes("Authentication error")) return true;
  }
  return false;
}

/** Gather numeric Cloudflare error codes from a structured error or its message body. */
function collectCloudflareErrorCodes(e: { errors?: unknown; message?: unknown }): number[] {
  const codes: number[] = [];
  const pushFrom = (errors: unknown) => {
    if (!Array.isArray(errors)) return;
    for (const item of errors) {
      if (item && typeof item === "object" && typeof (item as { code?: unknown }).code === "number")
        codes.push((item as { code: number }).code);
    }
  };
  pushFrom(e.errors);
  if (typeof e.message === "string") {
    const brace = e.message.indexOf("{");
    if (brace !== -1) {
      try {
        pushFrom((JSON.parse(e.message.slice(brace)) as { errors?: unknown }).errors);
      } catch {
        /* not JSON — ignore */
      }
    }
  }
  return codes;
}

/**
 * Friendly error thrown by listers when the API token lacks the scope needed
 * to read a resource type. The host renders the message inline in the
 * resource-type tab body, so the message must be self-contained guidance.
 *
 * Throwing (rather than returning `[]`) keeps the auth-failure path
 * distinguishable from a genuinely empty list: the user sees a clear hint
 * instead of an empty tab with no explanation. Other resource-type tabs are
 * loaded as independent promises, so this never breaks adjacent tabs.
 */
class CloudflareMissingPermissionError extends Error {
  readonly resourceLabel: string;
  readonly scope: string;
  constructor(resourceLabel: string, scope: string) {
    super(
      `This API token doesn't have the ${scope} permission, so ${resourceLabel} can't be loaded. ` +
        `Add it in Cloudflare → My Profile → API Tokens (edit the token, add the ${scope} permission, save) ` +
        `and try again.`,
    );
    this.name = "CloudflareMissingPermissionError";
    this.resourceLabel = resourceLabel;
    this.scope = scope;
  }
}

/**
 * Join a Cloudflare `errors: [{ code, message }]` array into a readable string,
 * e.g. "Zone not entitled to this functionality (code 1034)". Returns null when
 * there's nothing usable to format.
 */
function formatErrorsArray(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const parts = errors
    .map((e) => {
      if (!e || typeof e !== "object") return typeof e === "string" ? e : "";
      const rec = e as { code?: unknown; message?: unknown };
      const msg = typeof rec.message === "string" ? stripErrorCodePrefix(rec.message) : "";
      if (!msg) return "";
      return rec.code != null ? `${msg} (code ${rec.code})` : msg;
    })
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Strip Cloudflare's machine-readable message prefix — a dotted lowercase token
 * ending in a colon, e.g. `access.api.error.not_enabled: Access is not enabled.`
 * → `Access is not enabled.`. Requires at least three dotted segments so we
 * don't clip ordinary sentences or URLs that happen to contain a colon.
 */
function stripErrorCodePrefix(message: string): string {
  return message.replace(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,}:\s+/, "");
}

/**
 * Widen a typed SDK response object to a generic string-keyed record.
 *
 * The per-feature mappers deliberately read Cloudflare responses as untyped
 * JSON (coercing every field with `String()`/`Number()`/`Boolean()`) so a
 * drifting or partially-permissioned API response degrades gracefully instead
 * of crashing. Any object satisfies `Record<string, unknown>` at runtime; the
 * assertion is only needed because SDK interfaces lack an index signature.
 * Requiring `object` (rather than `unknown`) keeps nullable SDK results from
 * sneaking through without an explicit `?? {...}` fallback.
 */
export function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Turn a raw Cloudflare error into a clean, human message by pulling out
 * `errors[].message`. Handles both the SDK's structured error object and the
 * raw-fetch path whose message embeds the JSON body (e.g.
 * `403 {"success":false,"errors":[...]}`). Falls back to the original message.
 */
export function formatCloudflareError(err: unknown): string {
  if (err instanceof CloudflareMissingPermissionError) return err.message;

  // 1. Structured SDK error object (.errors), or a nested response body.
  const obj = err as { errors?: unknown; error?: unknown };
  const fromTop = formatErrorsArray(obj?.errors);
  if (fromTop) return fromTop;

  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";

  // 2. A JSON envelope embedded in the message string.
  const brace = raw.indexOf("{");
  if (brace !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(brace)) as { errors?: unknown };
      const fromBody = formatErrorsArray(parsed.errors);
      if (fromBody) return fromBody;
    } catch {
      /* not JSON — fall through */
    }
  }
  return raw || "Cloudflare request failed";
}

/**
 * Wrap any Cloudflare call so failures surface a clean `errors[].message`
 * instead of a raw JSON blob. Our friendly permission hint passes through
 * unchanged.
 */
export async function withCloudflareErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CloudflareMissingPermissionError) throw err;
    throw new Error(formatCloudflareError(err), { cause: err });
  }
}

/**
 * Run a lister; if it fails with a Cloudflare auth error, rethrow as a
 * {@link CloudflareMissingPermissionError} with provider-specific guidance.
 * Other failures are reformatted to a clean `errors[].message` (the original
 * error is preserved as `cause`).
 *
 * Each lister calls this with the user-facing resource label and the
 * Cloudflare API-token scope label that grants read access. The labels are
 * the same strings the user sees on Cloudflare's "Create Token" UI so they
 * can find the right permission immediately.
 */
export async function withAuthErrorHint<T>(
  fn: () => Promise<T>,
  resourceLabel: string,
  scope: string,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isCloudflareAuthError(err)) {
      throw new CloudflareMissingPermissionError(resourceLabel, scope);
    }
    throw new Error(formatCloudflareError(err), { cause: err });
  }
}

/**
 * Helper for listers that fan out one inner call per zone (page rules, DNS
 * custom rulesets, SSL certs, etc.). Tracks auth-error counts so we can
 * distinguish "the token has zone:read but not <feature>:read" from "this
 * zone simply has no resources".
 *
 * The caller passes a `perZone` async function that throws on failure (the
 * usual SDK iterator pattern). We:
 *   - Run the zone-list call through {@link withAuthErrorHint} so a missing
 *     Zone:Read scope surfaces with the right hint instead of bleeding
 *     through as a per-feature error.
 *   - Per zone, swallow auth errors but count them. If every zone's call
 *     failed with auth and zero results came back, throw the per-feature
 *     missing-permission error. Other zone errors (DNS not enabled, etc.)
 *     are swallowed as before so a single bad zone doesn't poison the list.
 */
export async function collectPerZone<T>(
  api: CloudflareApi,
  perZone: (zoneId: string, zoneName: string) => Promise<T[]>,
  resourceLabel: string,
  scope: string,
): Promise<T[]> {
  const zones = await withAuthErrorHint(() => api.listZones(), "zones", "Zone · Zone:Read");
  const results: T[] = [];
  let authFailures = 0;
  for (const zone of zones) {
    try {
      const part = await perZone(zone.id, zone.name);
      for (const item of part) results.push(item);
    } catch (err) {
      if (isCloudflareAuthError(err)) {
        authFailures++;
        continue;
      }
      // Non-auth per-zone errors are non-fatal — feature may not be enabled
      // on that zone, or the user lacks permission for some zones but not
      // others. Continue collecting from remaining zones.
    }
  }
  if (results.length === 0 && authFailures > 0 && authFailures === zones.length) {
    throw new CloudflareMissingPermissionError(resourceLabel, scope);
  }
  return results;
}

export class CloudflareApi {
  readonly apiToken: string;
  readonly baseUrl = "https://api.cloudflare.com/client/v4";
  readonly cf: Cloudflare;
  cfAccountId: string | null = null;
  private zonesPromise: Promise<Zone[]> | null = null;
  private accountIdPromise: Promise<string> | null = null;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
    // Loading an account fans out into per-zone list calls across many resource
    // types, so brief 429 bursts are expected. The SDK retries 429s with
    // exponential backoff and honors the Retry-After header; raise the budget
    // above the default of 2 to ride out those bursts.
    this.cf = new Cloudflare({ apiToken, maxRetries: 5 });
  }

  /**
   * Raw fetch wrapper. Retained only for the R2 object plane (uploads,
   * deletes, list-objects), which the SDK does not expose. Do not add new
   * call sites — use `this.cf` instead.
   */
  async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Cloudflare API error ${res.status} for ${path}: ${await res.text()}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    const json = (await res.json()) as {
      success: boolean;
      result: T;
      errors?: Array<{ message: string }>;
    };
    if (!json.success) {
      const msgs = json.errors?.map((e) => e.message).join(", ") ?? "unknown error";
      throw new Error(`Cloudflare API error for ${path}: ${msgs}`);
    }
    return json.result;
  }

  /** Collect all items from an SDK PagePromise into an array. */
  async collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of pages) out.push(item);
    return out;
  }

  /**
   * Full account zone list, fetched once per client and shared across callers.
   *
   * Opening an account view fans out into ~25 concurrent listResources calls,
   * most of which enumerate zones; without a shared cache each would
   * re-paginate /zones and together trip Cloudflare's rate limit (429). The
   * in-flight promise is cached (not just the resolved value) so concurrent
   * callers await the same request. A failed fetch clears the cache so the
   * next caller can retry.
   */
  listZones(): Promise<Zone[]> {
    if (!this.zonesPromise) {
      this.zonesPromise = this.collect(this.cf.zones.list()).then(
        (zones) => {
          // Side effect: cache account ID so account-scoped callers can skip
          // their own lookup.
          if (!this.cfAccountId && zones[0]?.account?.id) {
            this.cfAccountId = zones[0].account.id;
          }
          return zones;
        },
        (err) => {
          this.zonesPromise = null;
          throw err;
        },
      );
    }
    return this.zonesPromise;
  }

  /**
   * Resolve the Cloudflare account ID from the first zone. Deduped across
   * concurrent callers via a cached promise — without it the fan-out of
   * account-scoped listers each fires its own /zones?per_page=1 request.
   */
  async getAccountId(): Promise<string> {
    if (this.cfAccountId) return this.cfAccountId;
    if (!this.accountIdPromise) {
      this.accountIdPromise = this.resolveAccountId().catch((err) => {
        this.accountIdPromise = null;
        throw err;
      });
    }
    return this.accountIdPromise;
  }

  private async resolveAccountId(): Promise<string> {
    for await (const zone of this.cf.zones.list({ per_page: 1 })) {
      const accountId = zone.account?.id ?? "";
      if (!accountId)
        throw new Error("Cloudflare plugin: could not determine account ID from zone");
      this.cfAccountId = accountId;
      return accountId;
    }
    throw new Error("Cloudflare plugin: no zones found — cannot determine account ID");
  }

  async getZoneOptions(): Promise<Array<{ id: string; label: string }>> {
    const zones = await this.listZones();
    return zones.map((z) => ({ id: z.id, label: z.name }));
  }

  async getAccessAppOptions(): Promise<Array<{ id: string; label: string }>> {
    const account_id = await this.getAccountId();
    const opts: Array<{ id: string; label: string }> = [];
    for await (const a of this.cf.zeroTrust.access.applications.list({ account_id })) {
      const app = a as Record<string, unknown>;
      const id = String(app["id"] ?? "");
      const label = String(app["name"] ?? app["domain"] ?? id);
      opts.push({ id, label });
    }
    return opts;
  }
}
