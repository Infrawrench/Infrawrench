/**
 * The DigitalOcean plugin's command console: parameterised droplet and volume
 * commands routed through the host's `prompt-nosql-command` modal, plus the
 * Gradient AI agent playground (chat completion against an agent's deployment
 * URL, using an endpoint access key minted and persisted on first use).
 */
import type { ChatMessage, ChatStreamEvent, HostServices } from "@infrawrench/plugin-base";
import { streamOpenAiSseChat } from "@infrawrench/plugin-base";
import {
  type ActionContext,
  executeDropletCommand,
  executeReservedIpCommand,
  executeVolumeCommand,
} from "./actions.js";
import { safeParseJson } from "./detail-renderers/shared.js";

/** The slice of `DigitalOceanClient` the console needs. */
export interface DoNoSqlContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
  /** Host secret store — used to persist minted playground keys. */
  services: HostServices | undefined;
  actionCtx: ActionContext;
  /** Per-client session cache of agent uuid → endpoint access key. */
  playgroundKeyCache: Map<string, string>;
}

/**
 * Parameterised droplet & volume commands. Reuses the host's
 * `prompt-nosql-command` modal as a generic prompt mechanism (the modal name
 * is a historical artefact — it carries any plugin-defined form). The form
 * values arrive JSON-encoded in `args[0]`.
 */
export async function executeDoNoSqlCommand(
  ctx: DoNoSqlContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  command: string,
  args: (string | number)[],
): Promise<unknown> {
  if (typeId === "droplet") {
    return executeDropletCommand(ctx.actionCtx, resourceId, accountId, command, args);
  }
  if (typeId === "volume") {
    return executeVolumeCommand(ctx.actionCtx, resourceId, accountId, command, args);
  }
  if (typeId === "reserved-ip") {
    return executeReservedIpCommand(ctx.actionCtx, resourceId, accountId, command, args);
  }
  if (typeId === "managed-database" && command === "make-db-user") {
    // Mint a DB user and persist whatever credential DO surfaces once at
    // creation: a SCRAM `password` (mongo/redis/opensearch/kafka-SASL) and,
    // for Kafka mTLS, the `access_cert` + `access_key`. We store via the
    // host secret service keyed to the db-user id so `findMintedDatabaseUser`
    // resolves it for the connection string. This is the reliable path for
    // engines where DO never exposes the default user's password.
    const clusterId = resourceId.split(":").slice(2).join(":");
    const first = args[0];
    const values: Record<string, string> =
      typeof first === "string" && first
        ? (() => {
            try {
              const parsed = JSON.parse(first) as Record<string, string>;
              return parsed && typeof parsed === "object" ? parsed : {};
            } catch {
              return {};
            }
          })()
        : {};
    const name = String(values["name"] ?? "").trim();
    if (!name) throw new Error("Username is required.");
    const secrets = ctx.services?.secrets;
    if (!secrets?.setPlaintext) {
      throw new Error("This host can't persist credentials, so the user couldn't be stored.");
    }
    // Kafka is the odd one out: its `/users` endpoint requires a `settings`
    // block with at least one ACL or DO rejects with 422 "settings is
    // required". Every other engine creates the user from just `{ name }`.
    // We detect the engine off the cluster and, for Kafka, attach an ACL
    // (defaults to admin on `*` so the minted user can actually drive the
    // console; the form lets the user narrow the topic/permission).
    const body: Record<string, unknown> = { name };
    let engine = "";
    try {
      const cluster = await ctx.fetch<{ database?: { engine?: string } }>(
        `/databases/${clusterId}`,
      );
      engine = String(cluster.database?.engine ?? "");
    } catch {
      /* fall back to no settings; non-Kafka engines don't need them */
    }
    if (engine === "kafka") {
      const topic = String(values["topic"] ?? "").trim() || "*";
      const permission = String(values["permission"] ?? "").trim() || "admin";
      body["settings"] = { acl: [{ topic, permission }] };
    }
    const resp = await ctx.fetch<{
      user?: {
        name?: string;
        password?: string;
        access_cert?: string;
        access_key?: string;
      };
    }>(`/databases/${clusterId}/users`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const user = resp.user ?? {};
    const uname = String(user.name ?? name);
    const dbUserId = `${accountId}:db-user:${clusterId}:${uname}`;
    let stored = false;
    if (user.password) {
      await secrets.setPlaintext(dbUserId, "password", String(user.password));
      stored = true;
    }
    if (user.access_cert) {
      await secrets.setPlaintext(dbUserId, "accessCert", String(user.access_cert));
      stored = true;
    }
    if (user.access_key) {
      await secrets.setPlaintext(dbUserId, "accessKey", String(user.access_key));
      stored = true;
    }
    if (!stored) {
      throw new Error(
        "DigitalOcean returned no credential for the new user. Ensure the API token has the " +
          "`database:view_credentials` scope, then try again.",
      );
    }
    return;
  }
  if (typeId === "gen-ai-agent") {
    const agentUuid = resourceId.split(":").slice(2).join(":");
    const first = args[0];
    const values: Record<string, string> =
      typeof first === "string" && first
        ? (() => {
            try {
              const parsed = JSON.parse(first) as Record<string, string>;
              return parsed && typeof parsed === "object" ? parsed : {};
            } catch {
              return {};
            }
          })()
        : {};
    if (command === "attach-knowledge-base") {
      const kbUuid = String(values["knowledgeBaseUuid"] ?? "");
      if (!kbUuid) throw new Error("Pick a knowledge base.");
      await ctx.fetch(`/gen-ai/agents/${agentUuid}/knowledge_bases/${kbUuid}`, {
        method: "POST",
      });
      return;
    }
    if (command === "detach-knowledge-base") {
      const kbUuid = String(values["knowledgeBaseUuid"] ?? "");
      if (!kbUuid) throw new Error("Missing knowledge base UUID.");
      await ctx.fetch(`/gen-ai/agents/${agentUuid}/knowledge_bases/${kbUuid}`, {
        method: "DELETE",
      });
      return;
    }
    if (command === "attach-child-agent") {
      const childUuid = String(values["childAgentUuid"] ?? "");
      if (!childUuid) throw new Error("Pick an agent to route to.");
      const body: Record<string, string> = {};
      if (values["routeName"]) body["route_name"] = values["routeName"];
      if (values["ifCase"]) body["if_case"] = values["ifCase"];
      await ctx.fetch(`/gen-ai/agents/${agentUuid}/child_agents/${childUuid}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      return;
    }
    if (command === "detach-child-agent") {
      const childUuid = String(values["childAgentUuid"] ?? "");
      if (!childUuid) throw new Error("Missing child agent UUID.");
      await ctx.fetch(`/gen-ai/agents/${agentUuid}/child_agents/${childUuid}`, {
        method: "DELETE",
      });
      return;
    }
    if (command === "attach-function") {
      // The form's value keys map straight onto the DO request body.
      const name = String(values["functionName"] ?? "").trim();
      const faasName = String(values["faasName"] ?? "").trim();
      const faasNamespace = String(values["faasNamespace"] ?? "").trim();
      if (!name || !faasName || !faasNamespace) {
        throw new Error("Function name, FaaS function name, and FaaS namespace are all required.");
      }
      const body: Record<string, unknown> = {
        function_name: name,
        faas_name: faasName,
        faas_namespace: faasNamespace,
        ...(values["description"] ? { description: values["description"] } : {}),
        ...(values["inputSchema"] ? { input_schema: safeParseJson(values["inputSchema"]) } : {}),
        ...(values["outputSchema"] ? { output_schema: safeParseJson(values["outputSchema"]) } : {}),
      };
      await ctx.fetch(`/gen-ai/agents/${agentUuid}/functions`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      return;
    }
    if (command === "detach-function") {
      const fnUuid = String(values["functionUuid"] ?? "");
      if (!fnUuid) throw new Error("Missing function UUID.");
      await ctx.fetch(`/gen-ai/agents/${agentUuid}/functions/${fnUuid}`, {
        method: "DELETE",
      });
      return;
    }
  }
  if (typeId === "gen-ai-knowledge-base") {
    const kbUuid = resourceId.split(":").slice(2).join(":");
    const first = args[0];
    const values: Record<string, string> =
      typeof first === "string" && first
        ? (() => {
            try {
              const parsed = JSON.parse(first) as Record<string, string>;
              return parsed && typeof parsed === "object" ? parsed : {};
            } catch {
              return {};
            }
          })()
        : {};

    if (command === "add-spaces-source") {
      // Two paths: the resource picker submits `spacesBucket` = the bucket's
      // `bucketRef` output (`name|region`); manual entry submits
      // `spacesBucketName` + `spacesRegion` separately.
      const picked = String(values["spacesBucket"] ?? "").trim();
      let bucketName = "";
      let region = "";
      if (picked.includes("|")) {
        const [n, r] = picked.split("|");
        bucketName = String(n ?? "").trim();
        region = String(r ?? "").trim();
      } else {
        bucketName = String(values["spacesBucketName"] ?? picked).trim();
        region = String(values["spacesRegion"] ?? "").trim();
      }
      if (!bucketName) throw new Error("Pick or enter a Spaces bucket.");
      if (!region) throw new Error("Pick the bucket's region.");
      const itemPath = String(values["itemPath"] ?? "").trim();
      const body = {
        knowledge_base_uuid: kbUuid,
        spaces_data_source: {
          bucket_name: bucketName,
          region,
          ...(itemPath ? { item_path: itemPath } : {}),
        },
      };
      await ctx.fetch(`/gen-ai/knowledge_bases/${kbUuid}/data_sources`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      return;
    }

    if (command === "add-web-source") {
      const baseUrl = String(values["baseUrl"] ?? "").trim();
      if (!baseUrl) throw new Error("Enter a base URL to crawl.");
      const crawlingOption = String(values["crawlingOption"] ?? "SCOPED").trim() || "SCOPED";
      const body = {
        knowledge_base_uuid: kbUuid,
        web_crawler_data_source: {
          base_url: baseUrl,
          crawling_option: crawlingOption,
          embed_media: String(values["embedMedia"] ?? "no") === "yes",
        },
      };
      await ctx.fetch(`/gen-ai/knowledge_bases/${kbUuid}/data_sources`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      return;
    }

    if (command === "remove-data-source") {
      const dsUuid = String(values["dataSourceUuid"] ?? "").trim();
      if (!dsUuid) throw new Error("Missing data source UUID.");
      await ctx.fetch(`/gen-ai/knowledge_bases/${kbUuid}/data_sources/${dsUuid}`, {
        method: "DELETE",
      });
      return;
    }

    if (command === "start-indexing" || command === "reindex-source") {
      // Omitting data_source_uuids reindexes every source; the per-source
      // reindex passes the one uuid the row carried.
      const dsUuid = String(values["dataSourceUuid"] ?? "").trim();
      const body: Record<string, unknown> = { knowledge_base_uuid: kbUuid };
      if (dsUuid) body["data_source_uuids"] = [dsUuid];
      await ctx.fetch(`/gen-ai/indexing_jobs`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      return;
    }

    if (command === "cancel-indexing") {
      const jobUuid = String(values["jobUuid"] ?? "").trim();
      if (!jobUuid) throw new Error("Missing indexing job UUID.");
      await ctx.fetch(`/gen-ai/indexing_jobs/${jobUuid}/cancel`, {
        method: "PUT",
        body: JSON.stringify({ uuid: jobUuid }),
        headers: { "Content-Type": "application/json" },
      });
      return;
    }
  }

  if (typeId === "gen-ai-model-router") {
    const routerUuid = resourceId.split(":").slice(2).join(":");
    const first = args[0];
    const values: Record<string, string> =
      typeof first === "string" && first
        ? (() => {
            try {
              const parsed = JSON.parse(first) as Record<string, string>;
              return parsed && typeof parsed === "object" ? parsed : {};
            } catch {
              return {};
            }
          })()
        : {};

    // The update endpoint replaces the whole `policies` array, so we read
    // the current router, mutate the list, and PUT it back. Existing
    // policies are normalized to the request shape (models as id strings);
    // `fallback_models` is passed through verbatim so we don't disturb it.
    interface ApiPolicy {
      task_slug?: string;
      selection_policy?: { prefer?: string };
      models?: unknown[];
      custom_task?: unknown;
    }
    const loadRouter = async (): Promise<{
      name: string;
      description: string;
      policies: ApiPolicy[];
      fallback: unknown[];
    }> => {
      const data = await ctx.fetch<{ model_router?: Record<string, unknown> }>(
        `/gen-ai/models/routers/${routerUuid}`,
      );
      const r = data.model_router ?? {};
      const cfg = (r["config"] ?? {}) as { policies?: ApiPolicy[]; fallback_models?: unknown[] };
      return {
        name: String(r["name"] ?? ""),
        description: String(r["description"] ?? ""),
        policies: Array.isArray(cfg.policies) ? cfg.policies : [],
        fallback: Array.isArray(cfg.fallback_models) ? cfg.fallback_models : [],
      };
    };
    // Coerce a policy's `models` (id strings or {uuid} objects) to id strings.
    const modelIdsOf = (p: ApiPolicy): string[] =>
      (p.models ?? [])
        .map((m) =>
          typeof m === "string" ? m : String((m as Record<string, unknown>)["uuid"] ?? ""),
        )
        .filter(Boolean);
    const normalize = (p: ApiPolicy): ApiPolicy => ({
      task_slug: String(p.task_slug ?? ""),
      selection_policy: { prefer: p.selection_policy?.prefer ?? "none" },
      models: modelIdsOf(p),
      ...(p.custom_task ? { custom_task: p.custom_task } : {}),
    });
    const putRouter = async (
      cur: { name: string; description: string; fallback: unknown[] },
      policies: ApiPolicy[],
    ): Promise<void> => {
      await ctx.fetch(`/gen-ai/models/routers/${routerUuid}`, {
        method: "PUT",
        body: JSON.stringify({
          uuid: routerUuid,
          name: cur.name,
          ...(cur.description ? { description: cur.description } : {}),
          fallback_models: cur.fallback,
          policies,
        }),
        headers: { "Content-Type": "application/json" },
      });
    };

    if (command === "save-router-policy") {
      const task = String(values["task"] ?? "").trim();
      if (!task) throw new Error("Pick a task for this policy.");
      const prefer = String(values["prefer"] ?? "none").trim() || "none";
      let models: string[] = [];
      try {
        const parsed = JSON.parse(String(values["modelIds"] ?? "[]")) as unknown;
        if (Array.isArray(parsed)) models = parsed.map(String).filter(Boolean);
      } catch {
        /* empty / malformed → fall back to the task's default models below */
      }
      const originalTask = String(values["originalTask"] ?? "").trim();

      const cur = await loadRouter();
      // No models picked → use the task preset's recommended default set.
      if (models.length === 0) {
        const presets = await ctx
          .fetch<{
            tasks?: Array<{ task_slug?: string; models?: string[] }>;
          }>("/gen-ai/models/routers/tasks/presets?per_page=200")
          .catch(() => ({ tasks: [] }));
        const preset = (presets.tasks ?? []).find((t) => t.task_slug === task);
        models = Array.isArray(preset?.models) ? preset!.models.map(String) : [];
      }
      if (models.length === 0) {
        throw new Error(
          "No models selected and the task has no default models — pick at least one model.",
        );
      }
      const next = cur.policies
        .map(normalize)
        // Drop the policy we're replacing (matched by its original task slug
        // on edit, or the new task slug on add to avoid duplicates).
        .filter((p) => p.task_slug !== (originalTask || task) && p.task_slug !== task);
      next.push({
        task_slug: task,
        selection_policy: { prefer },
        models,
      });
      await putRouter(cur, next);
      return;
    }

    if (command === "remove-router-policy") {
      const task = String(values["task"] ?? "").trim();
      if (!task) throw new Error("Missing task slug.");
      const cur = await loadRouter();
      const next = cur.policies.map(normalize).filter((p) => p.task_slug !== task);
      await putRouter(cur, next);
      return;
    }
  }
  throw new Error(`DigitalOcean plugin: executeNoSqlCommand not supported for type "${typeId}"`);
}

/**
 * The host secret field the minted Playground key is persisted under, keyed on
 * the agent resource id. Org-scoped on the cloud host, so every team member's
 * Playground reuses one minted key instead of each session minting its own —
 * `DoNoSqlContext.playgroundKeyCache` is only the in-memory fallback for hosts
 * that don't expose a secret write path.
 */
const PLAYGROUND_KEY_FIELD = "__playgroundEndpointKey";

/**
 * Resolve an endpoint access key for the Playground, in priority order:
 *   1. in-memory session cache (cheapest),
 *   2. the host's persisted secret store (shared across sessions; org-wide
 *      on the cloud host — the secret stays server-side and is never sent
 *      to other users' browsers),
 *   3. mint a fresh `infrawrench-playground` key, persist it, and cache it.
 *
 * The persisted-then-reused design is what stops us minting "a ton of
 * tokens" — one key per agent is created once and shared.
 */
async function getOrMintPlaygroundKey(
  ctx: DoNoSqlContext,
  agentUuid: string,
  agentResourceId: string,
): Promise<string> {
  const field = PLAYGROUND_KEY_FIELD;

  const cached = ctx.playgroundKeyCache.get(agentUuid);
  if (cached) return cached;

  // Reuse a previously-persisted key when the host exposes secret storage.
  const stored = await ctx.services?.secrets?.getPlaintext(agentResourceId, field);
  if (stored) {
    ctx.playgroundKeyCache.set(agentUuid, stored);
    return stored;
  }

  const name = `infrawrench-playground`;
  // The agent-API-key create response nests the secret inside
  // `api_key_info.secret_key` (unlike model API keys, which return a
  // top-level `secret_key`). Read both spots to be safe.
  const data = await ctx.fetch<{
    api_key_info?: { secret_key?: string };
    secret_key?: string;
  }>(`/gen-ai/agents/${agentUuid}/api_keys`, {
    method: "POST",
    body: JSON.stringify({ name }),
    headers: { "Content-Type": "application/json" },
  });
  const secret = String(data.api_key_info?.secret_key ?? data.secret_key ?? "");
  if (!secret) {
    throw new Error(
      "DigitalOcean didn't return an endpoint access key secret. Confirm the API token has the `genai:create` scope and try again.",
    );
  }
  ctx.playgroundKeyCache.set(agentUuid, secret);
  // Persist for reuse (best-effort — if the host has no write path or it
  // fails, we still chat this session via the in-memory cache).
  if (ctx.services?.secrets?.setPlaintext) {
    try {
      await ctx.services.secrets.setPlaintext(agentResourceId, field, secret);
    } catch {
      /* non-fatal — session cache covers this run */
    }
  }
  return secret;
}

/**
 * Stream tokens from a deployed agent's OpenAI-compatible chat completions
 * endpoint. DO's agents.do-ai.run gateway implements SSE (`stream: true`)
 * exactly like OpenAI — `data: {json}\n\n` lines, terminating with
 * `data: [DONE]`. We parse it incrementally and yield `delta` events as
 * each `choices[0].delta.content` chunk arrives, then a single `done` with
 * the assembled message.
 */
// The body of the iterable is an async generator so plugins (and the
// host's IPC bridge) can `for await (const event of stream) { … }`.
export async function* streamDoChatMessage(
  ctx: DoNoSqlContext,
  typeId: string,
  resourceId: string,
  _accountId: string,
  messages: ChatMessage[],
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  if (typeId !== "gen-ai-agent") {
    yield {
      kind: "error",
      message: `DigitalOcean plugin: streamChatMessage not supported for type "${typeId}".`,
    };
    return;
  }
  const agentUuid = resourceId.split(":").slice(2).join(":");
  if (!agentUuid) {
    yield { kind: "error", message: "Couldn't determine the agent UUID." };
    return;
  }

  // Resolve the deployment URL + endpoint access key. The deployment URL
  // already includes the `agents.do-ai.run` host; we tack `/api/v1/chat/
  // completions` on (matches DO's OpenAI-compatible path).
  let deploymentUrl: string;
  let secretKey: string;
  try {
    const agentRes = await ctx.fetch<{
      agent: { deployment?: { url?: string } };
    }>(`/gen-ai/agents/${agentUuid}`);
    deploymentUrl = String(agentRes.agent?.deployment?.url ?? "");
    if (!deploymentUrl) {
      yield {
        kind: "error",
        message:
          "Agent has no deployment URL yet. Wait for the agent to finish provisioning and reload.",
      };
      return;
    }
    secretKey = await getOrMintPlaygroundKey(ctx, agentUuid, resourceId);
  } catch (err) {
    yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  const endpoint = `${deploymentUrl.replace(/\/+$/, "")}/api/v1/chat/completions`;
  const body = JSON.stringify({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    // Asking the gateway to return usage in the final chunk — DO mirrors
    // OpenAI's `stream_options.include_usage` opt-in here. Some gateways
    // ignore it, in which case we just skip the usage payload.
    stream_options: { include_usage: true },
  });

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body,
    });
  } catch (err) {
    yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
    return;
  }

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    yield {
      kind: "error",
      message: `Agent endpoint returned ${res.status}: ${errText || res.statusText}`,
    };
    return;
  }

  yield* streamOpenAiSseChat(res.body);
}
