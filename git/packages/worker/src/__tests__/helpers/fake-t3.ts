/**
 * A T3 Code environment, as much of one as the forge talks to: the OAuth
 * endpoints and the MCP server of T3 Code 0.1.11, behaving the way its
 * server does, as a `fetch` to hand to the code under test.
 *
 * Recorded from the installed app, not guessed:
 *
 * - Discovery at `/.well-known/oauth-protected-resource[/mcp]` and
 *   `/.well-known/oauth-authorization-server`; registration answers 201 and
 *   accepts `client_name`, `software_id`, `redirect_uris` and
 *   `token_endpoint_auth_method` (https redirects only); `S256` only; the
 *   token answer is `{access_token, token_type, expires_in, scope}` with no
 *   refresh token (thirty days). `refresh: true` makes this fake issue and
 *   rotate refresh tokens, for the client's refresh path.
 * - `/mcp`: any request with an `Origin` header is a 403; `Accept` has to
 *   name both types; no token is a 401 with `resource_metadata`; protocol
 *   `2025-06-18` with a session id from `initialize`, a 400 without one and
 *   a 404 for one it does not know.
 * - `orchestrator_capabilities` and `modelSelection` are as T3 Code's source
 *   has them at 0.1.13 (`contracts/orchestratorMcp.ts`, `modelSelection.ts`,
 *   `mcp/toolkits/project/handlers.ts`): a launch with no model on a project
 *   with no default is refused once `requireModel` is set, and a model the
 *   provider does not have is `model_unavailable`.
 * - Tools answer `structuredContent` and the same as JSON text; a refusal
 *   is `isError` with `{"_tag":"OrchestratorMcpFailure","code","message"}`
 *   as text; an argument the tool's schema does not have is refused.
 */

export interface FakeT3Options {
  readonly origin?: string;
  /** The access level the person approves: what `scope` the token carries. */
  readonly access?: "read-only" | "full-access";
  /** Issue and rotate refresh tokens (T3 Code itself does not). */
  readonly refresh?: boolean;
  /** Seconds an access token lasts. */
  readonly expiresIn?: number;
  /** Answer tool results as an event stream rather than one JSON object. */
  readonly stream?: boolean;
}

export interface FakeT3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  remoteUrl: string | null;
  /** The project's own default, `{ instanceId, model, options? }`. */
  defaultModelSelection?: Record<string, unknown> | null;
}

/** A provider as `orchestrator_capabilities` answers it. */
export interface FakeT3Provider {
  providerInstanceId: string;
  driverKind: string;
  displayName: string | null;
  models: Array<{
    id: string;
    label?: string;
    options?: Array<{ id: string; values: Array<string | boolean>; default?: string | boolean }>;
  }>;
  constraints: string[];
}

export const FAKE_T3_PROVIDERS: readonly FakeT3Provider[] = [
  {
    providerInstanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    models: [
      {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        options: [
          { id: "reasoningEffort", values: ["low", "medium", "high"], default: "medium" },
          { id: "fastMode", values: [false, true], default: false },
        ],
      },
    ],
    constraints: [],
  },
  {
    providerInstanceId: "claudeAgent",
    driverKind: "claudeAgent",
    displayName: "Claude",
    models: [
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        options: [{ id: "effort", values: ["low", "medium", "high", "xhigh"], default: "high" }],
      },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    ],
    constraints: [],
  },
  {
    providerInstanceId: "cursor",
    driverKind: "cursor",
    displayName: "Cursor",
    models: [{ id: "auto" }],
    constraints: ["Provider is not authenticated."],
  },
];

export interface FakeT3Thread {
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  updatedAt: string;
  messages: string[];
  launch: Record<string, unknown>;
}

export interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const TOOL_ARGUMENTS: Record<string, readonly string[]> = {
  orchestrator_capabilities: ["environmentId", "search"],
  t3_project_list: ["environmentId", "cursor", "limit"],
  t3_project_clone: [
    "environmentId",
    "provider",
    "repository",
    "remoteUrl",
    "destinationPath",
    "protocol",
  ],
  t3_project_create: [
    "environmentId",
    "title",
    "workspaceRoot",
    "createWorkspaceRootIfMissing",
    "defaultModelSelection",
    "scripts",
  ],
  t3_thread_launch: [
    "environmentId",
    "projectId",
    "scratch",
    "title",
    "modelSelection",
    "runtimeMode",
    "interactionMode",
    "workspaceStrategy",
    "message",
    "attachments",
    "clientRequestId",
    "delegatedFrom",
    "workflowRun",
  ],
  t3_thread_list: [
    "environmentId",
    "projectId",
    "allProjects",
    "statuses",
    "titleContains",
    "settled",
    "snoozed",
    "includeSubagents",
    "cursor",
    "limit",
  ],
  t3_thread_send: [
    "environmentId",
    "threadId",
    "message",
    "mode",
    "freshContext",
    "clientRequestId",
  ],
  t3_thread_read: [
    "environmentId",
    "threadId",
    "itemId",
    "textOffset",
    "view",
    "afterPosition",
    "beforePosition",
    "limit",
    "runLimit",
    "maxCharsPerItem",
  ],
};

/** Tools a read-only client is refused. */
const WRITES = new Set([
  "t3_project_clone",
  "t3_project_create",
  "t3_thread_launch",
  "t3_thread_send",
]);
/** Tools that need full access. */
const FULL = new Set(["t3_project_clone", "t3_project_create"]);

const b64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const fakeT3 = (options: FakeT3Options = {}) => {
  const origin = options.origin ?? "https://t3.example.net";
  let counter = 0;
  const next = (prefix: string): string => `${prefix}-${++counter}`;

  const clients = new Map<string, readonly string[]>();
  const codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; scope: string }
  >();
  const tokens = new Map<string, { scope: string; expiresAt: number }>();
  const refreshTokens = new Map<string, { clientId: string; scope: string }>();
  const sessions = new Set<string>();
  const launches = new Map<string, FakeT3Thread>();
  const sends = new Map<string, Record<string, unknown>>();

  const state = {
    origin,
    requests: [] as SeenRequest[],
    calls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
    projects: [] as FakeT3Project[],
    threads: [] as FakeT3Thread[],
    registrations: [] as Array<Record<string, unknown>>,
    providers: structuredClone(FAKE_T3_PROVIDERS) as FakeT3Provider[],
    /** Refuse a launch with no model on a project with no default, as T3 Code does. */
    requireModel: false,
    /** Made to fail the next call of a tool, once: `{ t3_thread_launch: "message" }`. */
    failNext: {} as Record<string, string>,
    /** Stop answering at all. */
    down: false,
    access: options.access ?? "full-access",
    now: () => Date.now(),

    /** Forget every MCP session, as a restart does. */
    dropSessions: () => sessions.clear(),
    /** End every sign-in, as removing this site in T3 Code does. */
    revokeAll: () => {
      tokens.clear();
      refreshTokens.clear();
    },

    /**
     * What the person's browser does at the authorize address: checks the
     * request as T3 Code does, approves, and answers the callback's query.
     */
    approve: (authorizeUrl: string): { code: string; state: string; iss: string } => {
      const url = new URL(authorizeUrl);
      const q = url.searchParams;
      if (`${url.origin}${url.pathname}` !== `${origin}/oauth/mcp/authorize`) {
        throw new Error("not this environment's authorize address");
      }
      const clientId = q.get("client_id") ?? "";
      const redirectUri = q.get("redirect_uri") ?? "";
      if (q.get("response_type") !== "code") throw new Error("response_type");
      if (q.get("code_challenge_method") !== "S256") throw new Error("code_challenge_method");
      if ((q.get("code_challenge") ?? "").length !== 43) throw new Error("code_challenge");
      if (!clients.get(clientId)?.includes(redirectUri)) throw new Error("redirect_uri");
      const resource = q.get("resource");
      if (resource !== null && resource.replace(/\/+$/, "") !== `${origin}/mcp`) {
        throw new Error("invalid_target");
      }
      const code = next("code");
      codes.set(code, {
        clientId,
        redirectUri,
        challenge: q.get("code_challenge")!,
        scope:
          state.access === "read-only"
            ? "orchestration:read"
            : "orchestration:read orchestration:operate settings:write source-control:write",
      });
      return { code, state: q.get("state") ?? "", iss: origin };
    },

    fetch: async (input: string, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(input);
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => (headers[key] = value));
      const body = typeof init.body === "string" ? init.body : "";
      const method = (init.method ?? "GET").toUpperCase();
      state.requests.push({ method, url: input, headers, body });
      if (state.down) throw new TypeError("fetch failed");
      if (url.origin !== origin) return new Response("not found", { status: 404 });
      return route(method, url, headers, body);
    },
  };

  const json = (status: number, value: unknown, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json", ...extra },
    });

  const issue = (clientId: string, scope: string): Record<string, unknown> => {
    const access = next("access.token");
    const expiresIn = options.expiresIn ?? 30 * 24 * 60 * 60;
    tokens.set(access, { scope, expiresAt: state.now() + expiresIn * 1000 });
    const answer: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope,
    };
    if (options.refresh) {
      const refresh = next("refresh");
      refreshTokens.set(refresh, { clientId, scope });
      answer["refresh_token"] = refresh;
    }
    return answer;
  };

  const token = async (form: URLSearchParams): Promise<Response> => {
    const grant = form.get("grant_type");
    if (grant === "authorization_code") {
      const pending = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = b64url(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      );
      if (
        !pending ||
        pending.clientId !== form.get("client_id") ||
        pending.redirectUri !== form.get("redirect_uri") ||
        pending.challenge !== challenge
      ) {
        return json(400, { error: "invalid_grant" });
      }
      return json(200, issue(pending.clientId, pending.scope));
    }
    if (grant === "refresh_token" && options.refresh) {
      const held = refreshTokens.get(form.get("refresh_token") ?? "");
      // Rotated: a refresh token is spent by using it.
      refreshTokens.delete(form.get("refresh_token") ?? "");
      if (!held || held.clientId !== form.get("client_id")) {
        return json(400, { error: "invalid_grant" });
      }
      return json(200, issue(held.clientId, held.scope));
    }
    return json(400, { error: "unsupported_grant_type" });
  };

  const project = (each: FakeT3Project): Record<string, unknown> => ({
    id: each.id,
    title: each.title,
    workspaceRoot: each.workspaceRoot,
    repositoryIdentity:
      each.remoteUrl === null
        ? null
        : {
            canonicalKey: each.remoteUrl
              .replace(/^https?:\/\//, "")
              .replace(/\.git$/, "")
              .toLowerCase(),
            locator: { source: "git-remote", remoteName: "origin", remoteUrl: each.remoteUrl },
          },
    defaultModelSelection: each.defaultModelSelection ?? null,
    scripts: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    deletedAt: null,
  });

  const tools: Record<string, (args: Record<string, any>) => unknown> = {
    orchestrator_capabilities: () => ({
      parentThreadId: null,
      inheritedProviderInstanceId: null,
      inheritedModel: null,
      inheritedOptions: [],
      runtimeMode: "full-access",
      interactionMode: "default",
      providers: state.providers.map((each) => ({
        ...each,
        canRunChildTask: each.constraints.length === 0,
        canRunCrossProviderChildTask: each.constraints.length === 0,
      })),
      features: { threadManagement: true, maxBatchThreads: 20 },
    }),
    t3_project_list: (args) => {
      const cursor = args["cursor"] ?? 0;
      const limit = Math.min(args["limit"] ?? 20, 100);
      const page = state.projects.slice(cursor, cursor + limit);
      return {
        projects: page.map(project),
        nextCursor: cursor + limit < state.projects.length ? cursor + limit : null,
      };
    },
    t3_project_clone: (args) => {
      if (!args["remoteUrl"]) {
        throw new Failure(
          "invalid_request",
          "Enter a repository path or clone URL before cloning.",
        );
      }
      const cwd = String(args["destinationPath"]).replace(/^~/, "/Users/someone");
      return { cwd, remoteUrl: args["remoteUrl"], repository: null };
    },
    t3_project_create: (args) => {
      if (state.projects.some((each) => each.workspaceRoot === args["workspaceRoot"])) {
        throw new Failure("invalid_request", "The workspace is already registered to a project.");
      }
      const cloned = [...state.calls]
        .reverse()
        .find(
          (call) =>
            call.tool === "t3_project_clone" &&
            String(call.args["destinationPath"]).replace(/^~/, "/Users/someone") ===
              args["workspaceRoot"],
        );
      const made: FakeT3Project = {
        id: next("project"),
        title: args["title"],
        workspaceRoot: args["workspaceRoot"],
        remoteUrl: cloned ? String(cloned.args["remoteUrl"]) : null,
      };
      state.projects.push(made);
      return project(made);
    },
    t3_thread_launch: (args) => {
      if (!args["projectId"] && !args["scratch"]) {
        throw new Failure(
          "target_required",
          "Pass projectId: this MCP client is not running inside a T3 thread.",
        );
      }
      const key = String(args["clientRequestId"] ?? next("request"));
      let thread = launches.get(key);
      if (!thread) {
        const chosen = args["modelSelection"] as Record<string, any> | undefined;
        if (chosen !== undefined) {
          const provider = state.providers.find(
            (each) => each.providerInstanceId === chosen["instanceId"],
          );
          const model = provider?.models.find((each) => each.id === chosen["model"]);
          if (!provider || !model) {
            throw new Failure(
              "model_unavailable",
              `Model ${chosen["model"]} is not advertised. No thread was created.`,
            );
          }
          for (const option of (chosen["options"] ?? []) as Array<Record<string, unknown>>) {
            const known = model.options?.find((each) => each.id === option["id"]);
            if (!known || !known.values.includes(option["value"] as string)) {
              throw new Failure(
                "invalid_request",
                `Option ${option["id"]} is not one of the model's.`,
              );
            }
          }
        }
        const preset =
          state.projects.find((each) => each.id === args["projectId"])?.defaultModelSelection ??
          (state.requireModel ? undefined : { instanceId: "claude", model: "some-model" });
        const modelSelection = chosen ?? preset;
        if (modelSelection === undefined) {
          throw new Failure(
            "invalid_request",
            "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
          );
        }
        args = { ...args, modelSelection };
        const threadId = next("thread");
        thread = {
          threadId,
          projectId: args["projectId"],
          title: args["title"],
          status: args["message"] ? "running" : "idle",
          updatedAt: new Date(state.now()).toISOString(),
          messages: args["message"] ? [args["message"]] : [],
          launch: args,
        };
        launches.set(key, thread);
        state.threads.push(thread);
      }
      return {
        threadId: thread.threadId,
        link: `https://app.t3.codes/threads/env-1/${thread.threadId}`,
        projectId: thread.projectId,
        modelSelection: thread.launch["modelSelection"],
        runId: "run-1",
        status: thread.status,
      };
    },
    t3_thread_list: (args) => {
      if (!args["projectId"] && !args["allProjects"]) {
        throw new Failure("target_required", "Pass projectId or allProjects.");
      }
      const wanted = String(args["titleContains"] ?? "").toLowerCase();
      const found = state.threads.filter((each) => each.title.toLowerCase().includes(wanted));
      return {
        projectId: null,
        currentThreadId: null,
        threads: found.map((each) => ({
          threadId: each.threadId,
          projectId: each.projectId,
          title: each.title,
          status: each.status,
          createdAt: each.updatedAt,
          updatedAt: each.updatedAt,
        })),
        nextCursor: null,
        total: found.length,
      };
    },
    t3_thread_send: (args) => {
      const thread = state.threads.find((each) => each.threadId === args["threadId"]);
      if (!thread) throw new Failure("thread_not_found", "No such thread.");
      const key = String(args["clientRequestId"] ?? next("request"));
      const before = sends.get(key);
      if (before) return before;
      const delivery = thread.status === "running" ? "steered" : "started";
      thread.messages.push(args["message"]);
      thread.status = "running";
      const answer = {
        threadId: thread.threadId,
        messageId: next("message"),
        runId: "run-2",
        status: "running",
        delivery,
      };
      sends.set(key, answer);
      return answer;
    },
    t3_thread_read: (args) => {
      const thread = state.threads.find((each) => each.threadId === args["threadId"]);
      if (!thread) throw new Failure("thread_not_found", "No such thread.");
      return {
        thread: {
          threadId: thread.threadId,
          projectId: thread.projectId,
          title: thread.title,
          status: thread.status,
          branch: null,
          worktreePath: null,
        },
        recentRuns: [],
        items: [],
        nextPosition: null,
        hasMore: false,
      };
    },
  };

  const callTool = (name: string, args: Record<string, unknown>, scope: string): unknown => {
    const allowed = TOOL_ARGUMENTS[name];
    const tool = tools[name];
    if (!allowed || !tool) return { protocolError: `Tool '${name}' not found` };
    for (const key of Object.keys(args)) {
      if (!allowed.includes(key)) {
        return {
          protocolError: `Unknown argument "${key}". Accepted arguments: ${allowed.join(", ")}`,
        };
      }
    }
    state.calls.push({ tool: name, args });
    const failure = (code: string, message: string) => ({
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", code, message }) },
      ],
    });
    if (WRITES.has(name) && !scope.includes("orchestration:operate")) {
      return failure(
        "capability_denied",
        "This tool changes the environment, and this MCP client was approved for read-only access.",
      );
    }
    if (FULL.has(name) && !scope.includes("settings:write")) {
      return failure("capability_denied", "This tool needs full access.");
    }
    const planted = state.failNext[name];
    if (planted !== undefined) {
      delete state.failNext[name];
      return failure("orchestration_error", planted);
    }
    try {
      const structuredContent = tool(args as Record<string, any>);
      return {
        isError: false,
        structuredContent,
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      };
    } catch (error) {
      if (error instanceof Failure) return failure(error.code, error.message);
      throw error;
    }
  };

  const mcp = (headers: Record<string, string>, body: string): Response => {
    // Before anything else, as T3 Code does: a browser's page never calls this.
    if (headers["origin"] !== undefined) return new Response(null, { status: 403 });
    const accept = headers["accept"] ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return new Response(null, { status: 406 });
    }
    const bearer = /^Bearer (.+)$/.exec(headers["authorization"] ?? "")?.[1];
    const held = bearer ? tokens.get(bearer) : undefined;
    if (!held || held.expiresAt <= state.now()) {
      return json(
        401,
        { error: "invalid_mcp_credential", message: "A valid T3 Code MCP credential is required." },
        {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        },
      );
    }
    const message = JSON.parse(body) as {
      id?: number;
      method: string;
      params?: Record<string, any>;
    };
    const session = headers["mcp-session-id"];
    if (message.method === "initialize") {
      const id = next("session");
      sessions.add(id);
      return json(
        200,
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "t3code", version: "0.1.11" },
          },
        },
        { "mcp-session-id": id, "mcp-protocol-version": "2025-06-18" },
      );
    }
    if (session === undefined) {
      return json(400, {
        error: "MCP-Session-Id header is required; send initialize to start a session",
      });
    }
    if (!sessions.has(session)) return new Response(null, { status: 404 });
    if (headers["mcp-protocol-version"] !== "2025-06-18")
      return new Response(null, { status: 400 });
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method !== "tools/call") {
      return json(200, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    }
    const result = callTool(
      String(message.params?.["name"]),
      (message.params?.["arguments"] ?? {}) as Record<string, unknown>,
      held.scope,
    ) as { protocolError?: string };
    const response =
      result.protocolError !== undefined
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: result.protocolError } }
        : { jsonrpc: "2.0", id: message.id, result };
    if (options.stream) {
      return new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return json(200, response);
  };

  const route = async (
    method: string,
    url: URL,
    headers: Record<string, string>,
    body: string,
  ): Promise<Response> => {
    const path = url.pathname;
    if (
      method === "GET" &&
      (path === "/.well-known/oauth-protected-resource" ||
        path === "/.well-known/oauth-protected-resource/mcp")
    ) {
      return json(200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["orchestration:read", "orchestration:operate"],
        bearer_methods_supported: ["header"],
        resource_name: "T3 Code",
      });
    }
    if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/mcp/authorize`,
        token_endpoint: `${origin}/oauth/mcp/token`,
        registration_endpoint: `${origin}/oauth/mcp/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["orchestration:read", "orchestration:operate"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (method === "POST" && path === "/oauth/mcp/register") {
      const asked = JSON.parse(body) as Record<string, unknown>;
      state.registrations.push(asked);
      const known = ["client_name", "software_id", "redirect_uris", "token_endpoint_auth_method"];
      const redirects = (asked["redirect_uris"] ?? []) as string[];
      if (
        Object.keys(asked).some((key) => !known.includes(key)) ||
        redirects.length < 1 ||
        redirects.some((each) => !each.startsWith("https://"))
      ) {
        return json(400, {
          error: "invalid_client_metadata",
          error_description:
            "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1].",
        });
      }
      const clientId = next("client.id");
      clients.set(clientId, redirects);
      return json(201, {
        client_id: clientId,
        client_name: asked["client_name"],
        redirect_uris: redirects,
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    }
    if (method === "POST" && path === "/oauth/mcp/token") return token(new URLSearchParams(body));
    if (path === "/mcp") {
      if (method !== "POST" && method !== "DELETE") {
        return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
      }
      return mcp(headers, body);
    }
    return new Response("not found", { status: 404 });
  };

  return state;
};

export type FakeT3 = ReturnType<typeof fakeT3>;
