/**
 * A small MCP client over Streamable HTTP (specification 2025-11-25,
 * "Transports"): enough to initialize and call a tool.
 *
 * Every message is its own `POST` to the MCP endpoint with a bearer token.
 * The answer is one JSON object or an event stream that ends with it; both
 * are read, bounded by the guarded fetch (`./http.ts`). A server that
 * assigns a session (`MCP-Session-Id`) gets it back on every later request,
 * and a `404` for a session means it expired: the client initializes again,
 * once.
 *
 * A Worker keeps nothing between requests, so a session lives as long as
 * one {@link McpClient}: an API request or a queue message. That is three
 * round trips for the first tool call and one for each after.
 */
import { T3Error, type T3Answer, type T3Http } from "./http";

/** The newest protocol version this client speaks, and the ones it accepts back. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
const ACCEPTED_VERSIONS: ReadonlySet<string> = new Set(["2025-11-25", "2025-06-18", "2025-03-26"]);

const CLIENT_INFO = { name: "infrawrench-git", title: "Infrawrench Git", version: "1.0.0" };

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const isResponseFor = (value: unknown, id: number): value is JsonRpcResponse =>
  typeof value === "object" &&
  value !== null &&
  (value as { id?: unknown }).id === id &&
  ("result" in value || "error" in value);

/** The JSON-RPC response to request `id` out of an answer: one JSON object, or an event stream. */
export const responseOf = (answer: T3Answer, id: number): JsonRpcResponse => {
  const type = (answer.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const candidates: string[] = [];
  if (type === "text/event-stream") {
    // Events are separated by a blank line; an event's `data:` lines are one value.
    for (const event of answer.text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data !== "") candidates.push(data);
    }
  } else {
    candidates.push(answer.text);
  }
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isResponseFor(message, id)) return message;
    }
  }
  throw new T3Error("bad_answer", "The environment did not answer the request", answer.status);
};

/** A tool's result: its structured content, else its text as JSON when it is, else its text. */
export const toolResult = (result: unknown, tool: string): unknown => {
  if (typeof result !== "object" || result === null) {
    throw new T3Error("bad_answer", `${tool} answered with nothing`);
  }
  const { content, structuredContent, isError } = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  const text = Array.isArray(content)
    ? content
        .filter(
          (part): part is { type: "text"; text: string } =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("\n")
    : "";
  if (isError === true) {
    // T3 Code's failures are JSON, `{ code, message }`; anything else is a sentence.
    let code: string | null = null;
    let message = text.trim();
    try {
      const failure = JSON.parse(text) as { code?: unknown; message?: unknown };
      if (typeof failure.message === "string") message = failure.message;
      if (typeof failure.code === "string") code = failure.code;
    } catch {
      // Not JSON: the text stands.
    }
    throw new T3Error(
      code === "capability_denied" ? "forbidden" : "tool_failed",
      message.slice(0, 500) || `${tool} failed`,
      null,
      code,
    );
  }
  if (structuredContent !== undefined && structuredContent !== null) return structuredContent;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export interface McpClientOptions {
  readonly http: T3Http;
  /** The MCP endpoint, `https://<environment>/mcp`. */
  readonly url: string;
  /** The bearer token, as it is now: asked for on every request, so a refresh in between is used. */
  readonly token: () => Promise<string>;
  /** For a tool that waits on the agent. Default: the guarded fetch's. */
  readonly timeoutMs?: number;
}

export class McpClient {
  private session: { id: string | null; version: string } | null = null;
  private nextId = 1;

  constructor(private readonly options: McpClientOptions) {}

  private async post(message: Record<string, unknown>, timeoutMs?: number): Promise<T3Answer> {
    const answer = await this.options.http(this.options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${await this.options.token()}`,
        ...(this.session
          ? {
              "mcp-protocol-version": this.session.version,
              ...(this.session.id === null ? {} : { "mcp-session-id": this.session.id }),
            }
          : {}),
      },
      body: JSON.stringify(message),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (answer.status === 401) {
      throw new T3Error(
        "not_signed_in",
        "The environment did not accept this site's sign-in. Sign in to it again.",
        401,
      );
    }
    if (answer.status === 403) {
      throw new T3Error(
        "forbidden",
        "The environment refused: its permission level for outside agents does not allow this",
        403,
      );
    }
    return answer;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = this.nextId++;
    const answer = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    if (answer.status === 404 && this.session?.id) {
      // The session expired: the caller starts another.
      this.session = null;
      throw new SessionExpired();
    }
    if (answer.status < 200 || answer.status >= 300) {
      throw new T3Error("bad_answer", `The environment answered ${answer.status}`, answer.status);
    }
    const response = responseOf(answer, id);
    if (response.error) {
      throw new T3Error(
        "tool_failed",
        String(response.error.message).slice(0, 500) || "The environment refused the request",
      );
    }
    if (method === "initialize") {
      const version = (response.result as { protocolVersion?: unknown } | undefined)
        ?.protocolVersion;
      if (typeof version !== "string" || !ACCEPTED_VERSIONS.has(version)) {
        throw new T3Error(
          "unsupported",
          "The environment speaks a version of MCP this site does not",
        );
      }
      const sessionId = answer.headers.get("mcp-session-id");
      this.session = {
        // Visible ASCII only, as the specification has it; anything else is not sent back.
        id: sessionId !== null && /^[\x21-\x7e]{1,512}$/.test(sessionId) ? sessionId : null,
        version,
      };
    }
    return response.result;
  }

  private async initialize(): Promise<void> {
    if (this.session) return;
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    const told = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (told.status < 200 || told.status >= 300) {
      throw new T3Error("bad_answer", `The environment answered ${told.status}`, told.status);
    }
  }

  /** Call a tool and answer its result (`toolResult`). Rejects with a {@link T3Error}. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.initialize();
        return toolResult(
          await this.request("tools/call", { name, arguments: args }, timeoutMs),
          name,
        );
      } catch (error) {
        if (!(error instanceof SessionExpired) || attempt > 0) {
          if (error instanceof SessionExpired) {
            throw new T3Error("bad_answer", "The environment keeps ending the session");
          }
          throw error;
        }
      }
    }
  }
}

class SessionExpired extends Error {}
