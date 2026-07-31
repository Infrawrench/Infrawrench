import type { Hono } from "hono";
import { eq, and, isNull, or } from "drizzle-orm";
import { db } from "../../../db/client";
import { resources } from "../../../db/schema";
import { getPlugin } from "../../../plugins/loader";
import { exportStoredResourcesToTerraform } from "../../../services/terraform-export";
import {
  getClientForAccount,
  getClientForResource,
  buildPeerPanes,
  filterVisiblePeerIntegrations,
} from "../../../services/plugin-clients";
import { getMetricRange } from "@infrawrench/server-core/clickhouse/readers";
import { requirePermission } from "../../../auth/permissions";
import { runTunnelSshAttach } from "../../../services/tunnel-ssh-attach";

/**
 * Cross-cutting per-resource action routes:
 *
 * - invoke-action / nosql-command / attach / export-credential — RPC-style
 *   handlers that dispatch to optional plugin client methods.
 * - peer-panes — lazily fetched secondary tabs.
 * - metrics — historical time-series read from ClickHouse.
 */
export function registerActionRoutes(app: Hono): void {
  /** POST /api/resources/invoke-action — invoke a plugin-defined action against a resource. */
  app.post("/invoke-action", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      resourceTypeId: string;
      resourceId: string;
      actionId: string;
      parentResourceId?: string;
    }>();
    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.invokeAction) {
      return c.json({ error: "Plugin does not support custom actions" }, 400);
    }
    try {
      await ctx.client.invokeAction(
        input.resourceTypeId,
        input.resourceId,
        input.actionId,
        input.accountId,
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Action failed" }, 400);
    }
    return c.json({ ok: true });
  });

  /** POST /api/resources/nosql-command — run a NoSQL document-browser command against a resource. */
  app.post("/nosql-command", async (c) => {
    requirePermission(c, "resources:execute");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      resourceTypeId: string;
      resourceId: string;
      command: string;
      args: (string | number)[];
      parentResourceId?: string;
    }>();
    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.executeNoSqlCommand) {
      return c.json({ error: "Plugin does not support NoSQL commands" }, 400);
    }
    try {
      const result = await ctx.client.executeNoSqlCommand(
        input.resourceTypeId,
        input.resourceId,
        input.accountId,
        input.command,
        input.args ?? [],
      );
      return c.json({ result });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Command failed" }, 400);
    }
  });

  /**
   * POST /api/resources/chat-stream — stream a chat turn against a resource
   * that exposes the chatPanel capability (e.g. a DigitalOcean Gradient AI
   * agent). The response is NDJSON: each line is a JSON-encoded
   * ChatStreamEvent (`{"kind":"delta","text":"…"}` / `{"kind":"done",…}` /
   * `{"kind":"error",…}`). The browser-side ChatPanel reads line-by-line via
   * ReadableStream.getReader() + TextDecoder.
   */
  app.post("/chat-stream", async (c) => {
    requirePermission(c, "resources:execute");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      resourceTypeId: string;
      resourceId: string;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      parentResourceId?: string;
      model?: string;
    }>();
    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.streamChatMessage) {
      return c.json({ error: "Plugin does not support chat" }, 400);
    }

    // Hand the underlying ReadableStream off to Hono — we serialise each
    // plugin-yielded event as one NDJSON line, flushed immediately so the
    // browser sees tokens as they arrive. Aborting the response (user
    // clicked Stop or navigated away) closes the iterator on the next
    // backpressure cycle, which Node handles via the AbortSignal we don't
    // wire here (plugins currently ignore aborts; the cleanup story is to
    // let the in-flight HTTP request finish).
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const writeEvent = (event: unknown): void => {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        };
        try {
          const iter = ctx.client.streamChatMessage!(
            input.resourceTypeId,
            input.resourceId,
            input.accountId,
            input.messages,
            input.model ? { model: input.model } : undefined,
          );
          for await (const event of iter) {
            writeEvent(event);
          }
        } catch (err) {
          writeEvent({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-store",
        "X-Accel-Buffering": "no",
      },
    });
  });

  /**
   * POST /api/resources/publish-message — send one message to a pub/sub
   * resource (Cloudflare Queue, AWS SQS/SNS/Kinesis/EventBridge, GCP Pub/Sub,
   * Azure Service Bus / Event Hub, Kafka). The browser-side PublishPanel
   * posts the body + extras here; the plugin's publishMessage handles the
   * provider call and returns a one-line summary.
   */
  app.post("/publish-message", async (c) => {
    requirePermission(c, "resources:execute");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      resourceTypeId: string;
      resourceId: string;
      payload: {
        body: string;
        extras: Record<string, string | Record<string, string>>;
      };
      parentResourceId?: string;
    }>();
    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.publishMessage) {
      return c.json({ error: "Plugin does not support publishing" }, 400);
    }
    try {
      const result = await ctx.client.publishMessage(
        input.resourceTypeId,
        input.resourceId,
        input.accountId,
        input.payload,
      );
      return c.json({ result });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Publish failed" }, 400);
    }
  });

  /**
   * POST /api/resources/synthesize-speech — render one clip of text through a
   * TTS provider (ElevenLabs, Cartesia, OpenAI, Deepgram Aura, …). The
   * browser-side SpeechPanel posts the text plus the chosen voice/model; the
   * response carries base64 audio the panel plays inline.
   */
  app.post("/synthesize-speech", async (c) => {
    requirePermission(c, "resources:execute");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      resourceTypeId: string;
      resourceId: string;
      payload: { text: string; voiceId?: string; modelId?: string };
      parentResourceId?: string;
    }>();
    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.synthesizeSpeech) {
      return c.json({ error: "Plugin does not support speech synthesis" }, 400);
    }
    try {
      const result = await ctx.client.synthesizeSpeech(
        input.resourceTypeId,
        input.resourceId,
        input.accountId,
        input.payload,
      );
      return c.json({ result });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Synthesis failed" }, 400);
    }
  });

  /**
   * POST /api/resources/transcribe-audio — transcribe one clip through an STT
   * provider (Deepgram, AssemblyAI, Whisper, …). The clip arrives base64 in
   * the JSON body; `SpeechPanelCapability.maxAudioBytes` is what keeps that
   * body within the server's request limit, enforced browser-side before the
   * encode.
   */
  app.post("/transcribe-audio", async (c) => {
    requirePermission(c, "resources:execute");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      resourceTypeId: string;
      resourceId: string;
      payload: {
        audioBase64: string;
        mimeType: string;
        fileName?: string;
        modelId?: string;
        language?: string;
      };
      parentResourceId?: string;
    }>();
    const ctx = await getClientForResource(
      input.pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.transcribeAudio) {
      return c.json({ error: "Plugin does not support transcription" }, 400);
    }
    try {
      const result = await ctx.client.transcribeAudio(
        input.resourceTypeId,
        input.resourceId,
        input.accountId,
        input.payload,
      );
      return c.json({ result });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Transcription failed" }, 400);
    }
  });

  /** POST /api/resources/attach — attach a resource onto a same-account target (e.g. disk → VM). */
  app.post("/attach", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      pluginId: string;
      accountId: string;
      sourceTypeId: string;
      sourceResourceId: string;
      targetTypeId: string;
      targetResourceId: string;
    }>();

    const ctx = await getClientForResource(input.pluginId, input.accountId, organizationId);
    if (!ctx) return c.json({ error: "Account not found" }, 404);
    if (!ctx.client.attachResource) {
      return c.json({ error: "Plugin does not support attach" }, 400);
    }
    try {
      await ctx.client.attachResource(
        input.sourceTypeId,
        input.sourceResourceId,
        input.targetTypeId,
        input.targetResourceId,
        input.accountId,
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Attach failed" }, 400);
    }
    return c.json({ ok: true });
  });

  /**
   * POST /api/resources/tunnel-ssh-attach — set up SSH over a Cloudflare Tunnel:
   * tunnel ingress + routing DNS, then install/run cloudflared on the host over
   * SSH. Spans the tunnel's account and the host's account. The tunnel token is
   * resolved server-side and never returned to the client.
   */
  app.post("/tunnel-ssh-attach", async (c) => {
    requirePermission(c, "resources:write");
    const organizationId = c.get("organizationId");
    const input = await c.req.json<{
      tunnel: { accountId: string; pluginId: string; resourceId: string };
      host: { accountId: string; pluginId: string; resourceTypeId: string; resourceId: string };
      hostname: string;
      zoneId: string;
      serviceType?: "http" | "https" | "ssh" | "tcp";
      port?: string;
      sshUsername: string;
      sshKeyId?: string;
    }>();
    try {
      const result = await runTunnelSshAttach({ organizationId, ...input });
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Tunnel SSH setup failed" }, 400);
    }
  });

  /** POST /api/resources/:pluginId/:typeId/export-credential */
  app.post("/:pluginId/:typeId/export-credential", async (c) => {
    requirePermission(c, "secrets:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const input = await c.req.json<{
      resourceId: string;
      accountId: string;
      formatId: string;
      parentResourceId?: string;
    }>();
    if (!input.resourceId || !input.accountId || !input.formatId) {
      return c.json({ error: "Missing resourceId, accountId, or formatId" }, 400);
    }
    const ctx = await getClientForResource(
      pluginId,
      input.accountId,
      organizationId,
      input.parentResourceId,
    );
    if (!ctx) return c.json({ error: "Account or peer resource not found" }, 404);
    if (!ctx.client.exportCredential) {
      return c.json({ error: "Plugin does not support credential export" }, 400);
    }
    try {
      const result = await ctx.client.exportCredential(
        resourceTypeId,
        input.resourceId,
        input.accountId,
        input.formatId,
      );
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Credential export failed" }, 400);
    }
  });

  /** POST /api/resources/:pluginId/:typeId/export-terraform — generate HCL
   * for one stored resource (plus its direct children, e.g. a zone's DNS
   * records). Mapping runs from persisted state — no provider API calls. */
  app.post("/:pluginId/:typeId/export-terraform", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const input = await c.req.json<{ resourceId: string; accountId: string }>();
    if (!input.resourceId || !input.accountId) {
      return c.json({ error: "Missing resourceId or accountId" }, 400);
    }
    const loaded = await getPlugin(pluginId);
    if (!loaded) return c.json({ error: "Plugin not found" }, 404);
    if (!loaded.plugin.terraformExport) {
      return c.json({ error: "Plugin does not support Terraform export" }, 400);
    }
    const rows = await db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
        outputsJson: resources.outputsJson,
        parentResourceId: resources.parentResourceId,
      })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          eq(resources.accountId, input.accountId),
          isNull(resources.deletedAt),
          or(eq(resources.id, input.resourceId), eq(resources.parentResourceId, input.resourceId)),
        ),
      );
    if (!rows.some((r) => r.id === input.resourceId)) {
      return c.json({ error: "Resource not found" }, 404);
    }
    // The requested resource's block leads the file; children follow.
    const ordered = [...rows].sort((a, b) =>
      a.id === input.resourceId ? -1 : b.id === input.resourceId ? 1 : a.id.localeCompare(b.id),
    );
    const outcome = await exportStoredResourcesToTerraform(ordered);
    return c.json(outcome);
  });

  /** POST /api/resources/:pluginId/:typeId/peer-panes */
  app.post("/:pluginId/:typeId/peer-panes", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const { accountId, resourceId, parentResourceId } = await c.req.json<{
      accountId: string;
      resourceId: string;
      parentResourceId?: string;
    }>();

    const ctx = parentResourceId
      ? await getClientForResource(pluginId, accountId, organizationId, parentResourceId)
      : await getClientForAccount(accountId, organizationId);
    if (!ctx) return c.json({ error: "Account not found" }, 404);

    const resourceTypeDef = ctx.plugin.resourceTypes.find((t) => t.id === resourceTypeId);
    if (!resourceTypeDef?.peerIntegrations?.length) return c.json([]);

    // Apply the same requiresFields/showWhen filter the eager /detail route
    // uses, so we never surface peer tabs that the detail payload hid. Mirror
    // the detail route's resolution order: try the live provider first, then
    // fall back to the persisted DB fields so transient provider failures or
    // just-created resources don't make tabs disappear that the initial
    // detail payload already exposed as stubs.
    let parentFields: Record<string, unknown> | undefined;
    const liveParent = await ctx.client
      .getResource(resourceTypeId, resourceId, accountId)
      .catch(() => null);
    if (liveParent?.fields) {
      parentFields = liveParent.fields;
    } else if (!parentResourceId) {
      const [dbResource] = await db
        .select({ fieldsJson: resources.fieldsJson })
        .from(resources)
        .where(and(eq(resources.id, resourceId), eq(resources.organizationId, organizationId)))
        .limit(1);
      if (dbResource?.fieldsJson) {
        parentFields = dbResource.fieldsJson as Record<string, unknown>;
      }
    }
    const visibleIntegrations = filterVisiblePeerIntegrations(
      resourceTypeDef.peerIntegrations,
      parentFields,
    );
    if (!visibleIntegrations.length) return c.json([]);

    const panes = await buildPeerPanes(
      ctx.client,
      ctx.plugin,
      visibleIntegrations,
      resourceTypeId,
      resourceId,
      accountId,
      organizationId,
    );

    return c.json(panes);
  });

  /**
   * POST /api/resources/:pluginId/:typeId/metrics
   *
   * Returns metric series for a resource. History comes from ClickHouse
   * (written by the poller) — only resources pinned on some dashboard
   * accumulate points. When there is no history, falls back to fetching the
   * series live from the provider via the plugin's `fetchMetricSeries`, so an
   * unpinned resource still charts whatever the provider can serve on demand.
   */
  app.post("/:pluginId/:typeId/metrics", async (c) => {
    requirePermission(c, "resources:read");
    const organizationId = c.get("organizationId");
    const pluginId = c.req.param("pluginId");
    const resourceTypeId = c.req.param("typeId");
    const { accountId, resourceId, startMs, endMs, parentResourceId } = await c.req.json<{
      accountId: string;
      resourceId: string;
      startMs?: number;
      endMs?: number;
      parentResourceId?: string;
    }>();

    const toMs = endMs ?? Date.now();
    const fromMs = startMs ?? toMs - 60 * 60 * 1000;
    const series = await getMetricRange(organizationId, resourceId, fromMs, toMs);
    if (series.length > 0) return c.json({ series });

    // Live fallback. Failures degrade to the empty history rather than a 500 —
    // "no data" is an answer, a dead provider shouldn't take out the chart pane.
    try {
      const ctx = await getClientForResource(pluginId, accountId, organizationId, parentResourceId);
      if (!ctx?.client.fetchMetricSeries) return c.json({ series });
      const live = await ctx.client.fetchMetricSeries(resourceTypeId, resourceId, accountId, {
        startMs: fromMs,
        endMs: toMs,
      });
      return c.json({ series: live });
    } catch {
      return c.json({ series });
    }
  });
}
