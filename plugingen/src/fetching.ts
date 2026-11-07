import { PluginGenError } from "./errors.js";

export type FetchText = (url: string) => Promise<string>;

export interface FetchOptions {
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  maxBytes?: number;
}

/** A generic name: some vendors' firewalls refuse the runtime's default. */
const USER_AGENT = "plugingen-openapi-client/1.0";
const TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 8_000];
const RETRY_AFTER_CAP_MS = 60_000;
/** Well above the largest provider document, and well below what would hurt the runner. */
const MAX_BYTES = 256 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([408, 425, 429]);

function retryable(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, RETRY_AFTER_CAP_MS) : undefined;
}

async function readLimited(response: Response, maxBytes: number, url: string): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new PluginGenError("parse", `${url} is too large to read`);
  if (!response.body) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new PluginGenError("parse", `${url} is too large to read`);
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * A timeout per attempt, covering the body as well as the headers, and retries only
 * for what a retry can fix. A 404 answers the question, so it fails straight away with
 * a kind the watcher reports, whereas running out of retries is `network`, which it
 * only warns about.
 */
export function createFetcher(options: FetchOptions = {}): FetchText {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const attempts = options.attempts ?? ATTEMPTS;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (url) => {
    let last = "";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let wait = BACKOFF_MS[attempt] ?? BACKOFF_MS.at(-1) ?? 0;
      try {
        // Read the global each time, so a test or a snapshot harness can replace it.
        const response = await globalThis.fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return await readLimited(response, maxBytes, url);
        await response.body?.cancel();
        if (!retryable(response.status)) {
          throw new PluginGenError("unavailable", `${url} answered ${response.status}`);
        }
        last = `${url} answered ${response.status}`;
        wait = retryAfterMs(response) ?? wait;
      } catch (error) {
        if (error instanceof PluginGenError) throw error;
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const detail = cause instanceof Error ? cause.message : String(cause);
        last = `${url} could not be fetched: ${detail}`;
      }
      if (attempt + 1 < attempts) await sleep(wait + Math.random() * 500);
    }
    throw new PluginGenError("network", last);
  };
}
