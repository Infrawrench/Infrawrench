// Shared plumbing for the effect/cli command tests: stdout/stderr capture and
// a `fetch` that answers org-scoped paths from fixtures. Each test file still
// declares its own `vi.mock("electron")` and `vi.mock("../cloud-tokens")`
// (Vitest hoists mocks per file), then calls `useCliCapture()`.
import { afterEach, beforeEach, vi } from "vitest";
import { runEffectCli } from "../cli/effect/run";

export interface Captured {
  stdout: string;
  stderr: string;
  /** Every request made, as `METHOD /path?query` below `/api/org/<id>`. */
  requests: string[];
}

/**
 * Capture both streams for every test in the file, and reset the record of
 * requests. Returns the live record: read it after `run(...)`.
 */
export function useCliCapture(): Captured {
  const captured: Captured = { stdout: "", stderr: "", requests: [] };
  beforeEach(() => {
    captured.stdout = "";
    captured.stderr = "";
    captured.requests = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      // A downloaded file is written as bytes; read it back as the text it is.
      captured.stdout +=
        chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      captured.stderr += String(chunk);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  return captured;
}

/**
 * A fixture that is not a 200 JSON body: an error status, a body that is not
 * JSON (a CSV, a PDF's bytes), or one that needs response headers
 * (`Content-Disposition` on a download).
 */
export class RawResponse {
  constructor(
    readonly status: number,
    readonly body: string | Uint8Array,
    readonly headers: Record<string, string> = {},
  ) {}
}

/**
 * Answer `fetch` from `routes`, keyed by `METHOD /path` (query string
 * included when the command sends one) below `/api/org/<id>`: a value is
 * served as a 200 JSON body, a {@link RawResponse} as itself. A request no
 * route names is a 404, so a wrong path shows up as a failed request.
 */
export function serveRoutes(captured: Captured, routes: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname.replace(/^\/api\/org\/[^/]+/, "") + url.search;
      const key = `${init?.method ?? "GET"} ${path}`;
      captured.requests.push(key);
      if (!(key in routes)) return new Response(`no fixture for ${key}`, { status: 404 });
      const route = routes[key];
      if (route instanceof RawResponse) {
        // A 204 (a dismissal DELETE) has no body; `Response` refuses one, even empty.
        const body = route.status === 204 ? null : route.body;
        return new Response(body, { status: route.status, headers: route.headers });
      }
      return new Response(JSON.stringify(route), { status: 200 });
    }),
  );
}

/** Run one command line through the effect/cli root; resolves with the exit code. */
export const run = (...argv: string[]): Promise<number> =>
  runEffectCli(argv, { version: "9.9.9", guiRunning: false });
