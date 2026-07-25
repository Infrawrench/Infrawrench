/**
 * Chat agent loop — drives the selected model with the shared tool registry,
 * persists conversation history, and bridges the destructive-tool approval flow
 * through the `chat_pending_actions` table.
 *
 * The loop itself is model-agnostic: one turn of streaming is delegated to a
 * provider (./providers), which owns all SDK and wire-format specifics. Message
 * content is persisted in the Anthropic block shape for every provider.
 *
 * Streams via an async generator of typed events; the HTTP route adapts these
 * to SSE for the browser.
 */
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { eq, and, asc, desc } from "drizzle-orm";
import { db } from "../db/client";
import { chatConversations, chatMessages, chatPendingActions } from "../db/schema";
import { getToolRegistry } from "../tools/registry";
import type { ToolAuthContext, ToolDefinition, ToolResult } from "../tools/types";
import {
  DEFAULT_CHAT_MODEL,
  type ChatContentBlock as AnthropicContentBlock,
} from "@infrawrench/ui";
import { recordUsage } from "./billing";
import { providerForModel, type ProviderTool } from "./providers";

const DEFAULT_MODEL = DEFAULT_CHAT_MODEL;
// Hard cap on thinking + response text per request. Both Opus 5 and Gemini 3.6
// Flash think by default, so this needs room for reasoning and the reply.
const MAX_TOKENS = 32000;

const SLEEP_TOOL_NAME = "sleep";
const MAX_SLEEP_SECONDS = 300;

/**
 * Chat-only tool (deliberately NOT in the shared registry, so MCP clients
 * never see it): lets the agent wait before re-checking a slow operation.
 * The wait itself runs on the CLIENT — the server suspends the turn with a
 * pre-resolved pending action, the UI shows "Sleeping N seconds…" and posts
 * `resume: true` when the time is up, and the loop continues with the tool
 * result.
 */
const SLEEP_TOOL: ProviderTool = {
  name: SLEEP_TOOL_NAME,
  description:
    "Pause for N seconds before continuing, then automatically resume. Use while waiting for a " +
    "slow operation to finish (resource provisioning, DNS propagation, a reboot) before " +
    "re-checking its status. Max 300 seconds per call; sleep again if you need longer.",
  inputSchema: {
    type: "object",
    properties: {
      seconds: {
        type: "integer",
        minimum: 1,
        maximum: MAX_SLEEP_SECONDS,
        description: "How long to wait",
      },
    },
    required: ["seconds"],
  },
};

const SYSTEM_PROMPT = `You are Infrawrench's in-app agent. You help the user manage their infrastructure — listing and inspecting resources, executing SQL, running ops actions, rotating credentials, and so on — through the tools exposed to you. Every tool maps to something the user can already do in the Infrawrench UI.

Style:
- Be direct. Don't narrate your tool plans before running them; just run them.
- When a tool errors, surface the error verbatim and suggest a fix.
- For destructive actions (delete, drop, restart, secret destroy, credential export, manifest apply, SQL writes, exec, KV writes, Docker stop/restart), the UI will prompt the user to approve before the action runs. Describe what you're about to do in the tool_use, but don't ask the user separately — the approval UI handles confirmation.
- Never print revealed secret values or accessed credentials inline unless the user explicitly asks. Refer to them by description ("the AWS access key has been generated and downloaded").
- Prefer the most specific tool for the job (e.g. \`gcp_create_secret_manager_secret\` over \`create_resource\` when both are available).
- Managed resources expose sidecars: a managed Kubernetes cluster (DOKS, EKS, GKE, …) exposes the \`kubernetes\` plugin through its kubeconfig, and managed databases expose \`postgres\`/\`mysql\`/\`redis\`/\`mongodb\`. For questions like "what is running in my cluster", find the cluster (search_resources), call \`list_resource_sidecars\` on it, then use the normal resource tools with the sidecar's pluginId and \`parentResourceId\` set to the cluster's resource id (e.g. \`list_resources { pluginId: "kubernetes", resourceTypeId: "k8s-deployment", parentResourceId: <cluster id> }\`).

You operate in the user's organization. Resources, accounts, and outputs belong to them.`;

interface ConversationMessageRow {
  id: string;
  role: string;
  content: AnthropicContentBlock[];
}

export type AgentEvent =
  | { type: "message_start"; messageId: string; role: "assistant" }
  | { type: "text_delta"; delta: string }
  | { type: "tool_use_start"; toolUseId: string; name: string }
  | { type: "tool_use_input"; toolUseId: string; partialJson: string }
  | { type: "tool_executed"; toolUseId: string; isError: boolean; resultPreview: string }
  | { type: "pending_action"; pendingActionId: string; toolName: string; toolUseId: string }
  | { type: "sleep"; toolUseId: string; seconds: number }
  | {
      type: "turn_end";
      messageId: string;
      stopReason: string | null;
      costMicros: number;
      hasPending: boolean;
    }
  | {
      type: "spend_blocked";
      monthToDateMicros: number;
      monthlyCapMicros: number;
      freeTier: boolean;
    }
  | { type: "error"; message: string };

interface RunAgentInput {
  conversationId: string;
  auth: ToolAuthContext;
  /** If set, write this as a new user message before running the turn. */
  userText?: string;
}

/**
 * Resolves outstanding pending actions for the latest assistant message into
 * tool_result blocks, returning them so the caller can append a user message
 * and resume the loop. Returns null if there are no pending actions or any
 * are still unresolved.
 */
async function collectResolvedToolResults(
  conversationId: string,
): Promise<AnthropicContentBlock[] | null> {
  const latestAssistant = await db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.role, "assistant")))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);

  const assistant = latestAssistant[0];
  if (!assistant) return null;

  const pending = await db
    .select()
    .from(chatPendingActions)
    .where(eq(chatPendingActions.messageId, assistant.id));

  if (pending.length === 0) return null;
  if (pending.some((p) => p.status === "pending" || p.status === "approved")) {
    // "approved" means the user clicked approve but the executor hasn't run
    // yet. The pending-action route is responsible for transitioning approved
    // → executed/errored synchronously, so seeing approved here means the
    // approval is mid-flight; treat as unresolved.
    return null;
  }

  return pending.map<AnthropicContentBlock>((p) => ({
    type: "tool_result",
    tool_use_id: p.toolUseId,
    content: [{ type: "text", text: p.result ?? "" }],
    is_error: p.isError,
  }));
}

async function loadConversationForApi(
  conversationId: string,
): Promise<{ messages: ConversationMessageRow[]; model: string; system: string }> {
  const [conv] = await db
    .select()
    .from(chatConversations)
    .where(eq(chatConversations.id, conversationId))
    .limit(1);
  if (!conv) throw new Error("Conversation not found");

  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.createdAt));

  return {
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content as AnthropicContentBlock[],
    })),
    model: conv.model,
    system: conv.systemPrompt ?? SYSTEM_PROMPT,
  };
}

function toolToProvider(t: ToolDefinition): ProviderTool {
  // Both providers take JSON Schema (draft 2020-12) for tool input. We convert
  // from the Zod shapes that MCP also uses. Must NOT use the openApi3 target:
  // OpenAPI 3.0 is a different dialect (boolean exclusiveMinimum/
  // exclusiveMaximum, nullable) that the API rejects with "JSON schema is
  // invalid". The default draft-07 output is 2020-12-compatible for the
  // constructs Zod emits. $refStrategy none keeps every schema inline.
  const schema = zodToJsonSchema(z.object(t.inputSchema), { $refStrategy: "none" }) as {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];
  return {
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

function previewResultText(result: ToolResult): string {
  const joined = result.content.map((c) => c.text).join("\n");
  if (joined.length <= 500) return joined;
  return joined.slice(0, 500) + `\n... [${joined.length - 500} more chars]`;
}

/**
 * Run a single agent turn (one Anthropic call + tool auto-runs + a follow-up
 * call for each batch of auto-executed tools) until the model emits text-only
 * (end_turn), max_tokens, or at least one destructive tool_use (which gets
 * suspended for UI approval).
 */
export async function* runAgentTurn(input: RunAgentInput): AsyncGenerator<AgentEvent> {
  const { conversationId, auth, userText } = input;

  // Persist the user's text turn if provided.
  if (userText && userText.length > 0) {
    await db.insert(chatMessages).values({
      id: uuidv4(),
      conversationId,
      role: "user",
      content: [{ type: "text", text: userText }],
    });
    await db
      .update(chatConversations)
      .set({ updatedAt: new Date() })
      .where(eq(chatConversations.id, conversationId));
  } else {
    // No user text — assume we're resuming after pending actions resolved.
    const toolResults = await collectResolvedToolResults(conversationId);
    if (toolResults) {
      await db.insert(chatMessages).values({
        id: uuidv4(),
        conversationId,
        role: "user",
        content: toolResults,
      });
    }
  }

  // Check spend cap. Done after writing the user message so the user's text is
  // not lost — the model just won't reply this turn.
  const { getMonthlySpend } = await import("./billing");
  const spend = await getMonthlySpend(auth.organizationId);
  if (spend.exceeded && spend.monthlyCapMicros != null) {
    yield {
      type: "spend_blocked",
      monthToDateMicros: spend.monthToDateMicros,
      monthlyCapMicros: spend.monthlyCapMicros,
      freeTier: spend.freeTier,
    };
    return;
  }

  const registry = await getToolRegistry();
  const toolByName = new Map(registry.map((t) => [t.name, t] as const));
  const providerTools = [...registry.map(toolToProvider), SLEEP_TOOL];

  // Loop until we get an end_turn / max_tokens / a destructive tool batch.
  // Each iteration: load full history, call the model, persist assistant
  // message, dispatch tool_uses.
  let safetyCounter = 0;
  while (safetyCounter++ < 32) {
    const { messages: history, model } = await loadConversationForApi(conversationId);
    const activeModel = model || DEFAULT_MODEL;
    const provider = providerForModel(activeModel);
    try {
      provider.assertConfigured();
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : "Provider misconfigured" };
      return;
    }

    const apiMessages = history.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    const assistantMessageId = uuidv4();
    yield { type: "message_start", messageId: assistantMessageId, role: "assistant" };

    let stopReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let collectedBlocks: AnthropicContentBlock[] = [];

    try {
      for await (const ev of provider.streamTurn({
        model: activeModel,
        system: SYSTEM_PROMPT,
        tools: providerTools,
        messages: apiMessages,
        maxTokens: MAX_TOKENS,
      })) {
        if (ev.type === "done") {
          collectedBlocks = ev.blocks;
          stopReason = ev.stopReason;
          inputTokens = ev.usage.inputTokens;
          outputTokens = ev.usage.outputTokens;
          cacheReadTokens = ev.usage.cacheReadTokens;
          cacheWriteTokens = ev.usage.cacheWriteTokens;
        } else {
          yield ev;
        }
      }
    } catch (e) {
      yield {
        type: "error",
        message: e instanceof Error ? e.message : `${provider.label} request failed`,
      };
      return;
    }

    // Persist the assistant message.
    await db.insert(chatMessages).values({
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: collectedBlocks,
      stopReason,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });

    const costMicros = await recordUsage({
      organizationId: auth.organizationId,
      conversationId,
      messageId: assistantMessageId,
      model: activeModel,
      usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    });

    await db
      .update(chatConversations)
      .set({ updatedAt: new Date() })
      .where(eq(chatConversations.id, conversationId));

    const toolUses = collectedBlocks.filter(
      (b): b is Extract<AnthropicContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      yield {
        type: "turn_end",
        messageId: assistantMessageId,
        stopReason,
        costMicros,
        hasPending: false,
      };
      return;
    }

    // Partition into auto-run vs destructive.
    const autoBlocks: AnthropicContentBlock[] = [];
    let suspended = false;
    for (const tu of toolUses) {
      if (tu.name === SLEEP_TOOL_NAME) {
        // The client performs the wait: suspend the turn with a pre-resolved
        // pending action; the UI shows the sleep indicator and resumes the
        // loop when the time is up.
        const raw = Number((tu.input as Record<string, unknown>)["seconds"]);
        const seconds = Math.min(
          MAX_SLEEP_SECONDS,
          Math.max(1, Math.round(Number.isFinite(raw) ? raw : 1)),
        );
        await db.insert(chatPendingActions).values({
          id: uuidv4(),
          conversationId,
          messageId: assistantMessageId,
          toolUseId: tu.id,
          toolName: SLEEP_TOOL_NAME,
          toolInput: { seconds },
          status: "executed",
          result: `Slept ${seconds} seconds.`,
          isError: false,
          resolvedAt: new Date(),
        });
        yield { type: "sleep", toolUseId: tu.id, seconds };
        suspended = true;
        continue;
      }
      const tool = toolByName.get(tu.name);
      if (!tool) {
        autoBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: [{ type: "text", text: `Unknown tool: ${tu.name}` }],
          is_error: true,
        });
        yield {
          type: "tool_executed",
          toolUseId: tu.id,
          isError: true,
          resultPreview: `Unknown tool: ${tu.name}`,
        };
        continue;
      }
      if (tool.risk === "destructive") {
        const pendingId = uuidv4();
        await db.insert(chatPendingActions).values({
          id: pendingId,
          conversationId,
          messageId: assistantMessageId,
          toolUseId: tu.id,
          toolName: tu.name,
          toolInput: tu.input,
          status: "pending",
        });
        yield {
          type: "pending_action",
          pendingActionId: pendingId,
          toolName: tu.name,
          toolUseId: tu.id,
        };
        suspended = true;
        continue;
      }
      // Auto-run read / write tools.
      let result: ToolResult;
      try {
        result = await tool.handler(tu.input, auth);
      } catch (e) {
        result = {
          content: [{ type: "text", text: e instanceof Error ? e.message : "Tool threw" }],
          isError: true,
        };
      }
      const text = result.content.map((c) => c.text).join("\n");
      autoBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: [{ type: "text", text }],
        is_error: !!result.isError,
      });
      yield {
        type: "tool_executed",
        toolUseId: tu.id,
        isError: !!result.isError,
        resultPreview: previewResultText(result),
      };
    }

    if (suspended) {
      // Even if we auto-ran some tools alongside destructive ones, we cannot
      // continue this turn until the human approves the pending ones — store
      // auto-results as resolved pending entries so they're included when the
      // turn resumes.
      const toolUsesById = new Map(toolUses.map((tu) => [tu.id, tu]));
      for (const block of autoBlocks) {
        if (block.type !== "tool_result") continue;
        const blockToolUse = toolUsesById.get(block.tool_use_id);
        await db.insert(chatPendingActions).values({
          id: uuidv4(),
          conversationId,
          messageId: assistantMessageId,
          toolUseId: block.tool_use_id,
          toolName: blockToolUse?.name ?? "(auto)",
          toolInput: (blockToolUse?.input as Record<string, unknown> | undefined) ?? {},
          status: "executed",
          result: Array.isArray(block.content)
            ? block.content.map((c) => c.text).join("\n")
            : block.content,
          isError: !!block.is_error,
          resolvedAt: new Date(),
        });
      }
      yield {
        type: "turn_end",
        messageId: assistantMessageId,
        stopReason,
        costMicros,
        hasPending: true,
      };
      return;
    }

    // All tool_uses auto-ran. Insert a follow-on user message with the results
    // and loop for another assistant turn.
    await db.insert(chatMessages).values({
      id: uuidv4(),
      conversationId,
      role: "user",
      content: autoBlocks,
    });
    yield {
      type: "turn_end",
      messageId: assistantMessageId,
      stopReason,
      costMicros,
      hasPending: false,
    };
    // Continue outer loop with another model call.
  }

  yield { type: "error", message: "Agent loop hit max iterations (32)" };
}

/**
 * Execute an approved pending action: runs the tool, updates the row, and
 * returns the resulting block so the caller can decide whether to immediately
 * trigger a new turn.
 */
export async function executePendingAction(
  pendingActionId: string,
  auth: ToolAuthContext,
): Promise<{ allResolved: boolean }> {
  const [pending] = await db
    .select()
    .from(chatPendingActions)
    .where(eq(chatPendingActions.id, pendingActionId))
    .limit(1);
  if (!pending) throw new Error("Pending action not found");
  if (pending.status !== "approved") {
    throw new Error(`Expected status=approved, got ${pending.status}`);
  }

  const registry = await getToolRegistry();
  const tool = registry.find((t) => t.name === pending.toolName);
  if (!tool) {
    await db
      .update(chatPendingActions)
      .set({
        status: "errored",
        result: `Unknown tool: ${pending.toolName}`,
        isError: true,
        resolvedAt: new Date(),
      })
      .where(eq(chatPendingActions.id, pendingActionId));
  } else {
    let result: ToolResult;
    try {
      result = await tool.handler(pending.toolInput as Record<string, unknown>, auth);
    } catch (e) {
      result = {
        content: [{ type: "text", text: e instanceof Error ? e.message : "Tool threw" }],
        isError: true,
      };
    }
    const text = result.content.map((c) => c.text).join("\n");
    await db
      .update(chatPendingActions)
      .set({
        status: result.isError ? "errored" : "executed",
        result: text,
        isError: !!result.isError,
        resolvedAt: new Date(),
      })
      .where(eq(chatPendingActions.id, pendingActionId));
  }

  const remaining = await db
    .select({ status: chatPendingActions.status })
    .from(chatPendingActions)
    .where(eq(chatPendingActions.messageId, pending.messageId));
  const allResolved = remaining.every(
    (r) => r.status === "executed" || r.status === "errored" || r.status === "rejected",
  );
  return { allResolved };
}

export async function rejectPendingAction(
  pendingActionId: string,
  reason?: string,
): Promise<{ allResolved: boolean; messageId: string }> {
  const [pending] = await db
    .select()
    .from(chatPendingActions)
    .where(eq(chatPendingActions.id, pendingActionId))
    .limit(1);
  if (!pending) throw new Error("Pending action not found");

  await db
    .update(chatPendingActions)
    .set({
      status: "rejected",
      result: reason ?? "User rejected this action.",
      isError: true,
      resolvedAt: new Date(),
    })
    .where(eq(chatPendingActions.id, pendingActionId));

  const remaining = await db
    .select({ status: chatPendingActions.status })
    .from(chatPendingActions)
    .where(eq(chatPendingActions.messageId, pending.messageId));
  const allResolved = remaining.every(
    (r) => r.status === "executed" || r.status === "errored" || r.status === "rejected",
  );
  return { allResolved, messageId: pending.messageId };
}
