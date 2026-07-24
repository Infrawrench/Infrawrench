import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "../store/ui.store.js";
import {
  CHAT_MODELS,
  emitChatConversationsChanged,
  microsToUsd,
  type ChatClient,
  type ChatConversationMessage,
  type ChatContentBlock,
  type ChatPendingAction,
  type ConversationSummary,
  type SpendStatus,
} from "./types.js";

interface Props {
  client: ChatClient;
  conversationId: string;
}

interface StreamingState {
  active: boolean;
  /** Buffered text for the in-flight assistant message. */
  text: string;
  toolUses: Array<{ id: string; name: string; input: string; executed?: boolean }>;
  error?: string | undefined;
}

export function ConversationView({ client, conversationId }: Props): React.ReactElement {
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ChatConversationMessage[]>([]);
  const [pending, setPending] = useState<ChatPendingAction[]>([]);
  const [spend, setSpend] = useState<SpendStatus | null>(null);
  const [streaming, setStreaming] = useState<StreamingState>({
    active: false,
    text: "",
    toolUses: [],
  });
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    const data = await client.getConversation(conversationId);
    setConversation(data.conversation);
    setMessages(data.messages);
    setPending(data.pendingActions);
    // Keep any workspace tab pointing at this conversation titled after it —
    // conversations auto-rename after the first message. Done here (not in a
    // sidebar component) so it works even when the sidebar is collapsed. On
    // hosts without workspace tabs (web chat routes) this is a no-op.
    const { workspaceTabs, setWorkspaceTabTitle } = useUIStore.getState();
    for (const tab of workspaceTabs) {
      if (
        tab.target.kind === "chat" &&
        tab.target.conversationId === conversationId &&
        data.conversation.title !== tab.title
      ) {
        setWorkspaceTabTitle(tab.id, data.conversation.title);
      }
    }
    const s = await client.getSpend();
    setSpend(s);
  }, [client, conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming.text, streaming.toolUses.length]);

  const startStream = useCallback(
    async (body: { text?: string; resume?: boolean }) => {
      setStreaming({ active: true, text: "", toolUses: [] });

      try {
        for await (const ev of client.streamTurn(conversationId, body)) {
          if (ev.type === "text_delta") {
            const delta = ev["delta"] as string;
            setStreaming((s) => ({ ...s, text: s.text + delta }));
          } else if (ev.type === "tool_use_start") {
            setStreaming((s) => ({
              ...s,
              toolUses: [
                ...s.toolUses,
                {
                  id: ev["toolUseId"] as string,
                  name: ev["name"] as string,
                  input: "",
                },
              ],
            }));
          } else if (ev.type === "tool_use_input") {
            const id = ev["toolUseId"] as string;
            const partial = ev["partialJson"] as string;
            setStreaming((s) => ({
              ...s,
              toolUses: s.toolUses.map((t) =>
                t.id === id ? { ...t, input: t.input + partial } : t,
              ),
            }));
          } else if (ev.type === "tool_executed") {
            const id = ev["toolUseId"] as string;
            setStreaming((s) => ({
              ...s,
              toolUses: s.toolUses.map((t) => (t.id === id ? { ...t, executed: true } : t)),
            }));
          } else if (ev.type === "pending_action") {
            // Server has persisted the action; we'll see it after reload.
          } else if (ev.type === "turn_end") {
            if (ev["hasPending"]) break;
            // Not the end of the loop: after auto-run tools the server feeds
            // the results back to the model and streams another assistant
            // message. Pull the persisted messages in, clear the in-flight
            // buffer, and keep reading — the stream closes when the model
            // really is done.
            await reload();
            setStreaming((s) => ({ ...s, text: "", toolUses: [] }));
          } else if (ev.type === "spend_blocked") {
            const cap = microsToUsd(Number(ev["monthlyCapMicros"]));
            setStreaming((s) => ({
              ...s,
              error: ev["freeTier"]
                ? `Free-tier chat limit reached ($${cap}/month). Add a payment method in Settings → Billing to keep chatting, or wait for next month.`
                : `Monthly chat spend cap reached ($${cap}). Increase the cap in org settings or wait for next month.`,
            }));
            break;
          } else if (ev.type === "error") {
            setStreaming((s) => ({ ...s, error: ev["message"] as string }));
            break;
          }
        }
      } catch (e) {
        setStreaming((s) => ({
          ...s,
          error: e instanceof Error ? e.message : "Chat stream failed",
        }));
      }

      setStreaming((s) => ({ ...s, active: false }));
      await reload();
      // A completed turn can rename the conversation and bumps updatedAt —
      // let session lists pick that up.
      emitChatConversationsChanged();
    },
    [client, conversationId, reload],
  );

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (!text || streaming.active) return;
    setInput("");
    await startStream({ text });
  }

  async function handleModelChange(model: string): Promise<void> {
    if (!conversation || model === conversation.model) return;
    // Optimistic — the select shouldn't snap back while the PATCH is in flight.
    setConversation({ ...conversation, model });
    try {
      await client.setConversationModel(conversationId, model);
      emitChatConversationsChanged();
    } catch (e) {
      setConversation(conversation);
      setStreaming((s) => ({
        ...s,
        error: e instanceof Error ? e.message : "Failed to change model",
      }));
    }
  }

  const resumeIfResolved = useCallback(async () => {
    const data = await client.getConversation(conversationId);
    const unresolved = data.pendingActions.some(
      (p) => p.status === "pending" || p.status === "approved",
    );
    if (!unresolved && data.pendingActions.length > 0) {
      await startStream({ resume: true });
    }
  }, [client, conversationId, startStream]);

  async function handleApprove(pendingId: string): Promise<void> {
    await client.resolvePendingAction(conversationId, pendingId, "approve");
    await reload();
    // If all pending actions for the latest assistant message are now resolved,
    // resume the model loop with the tool results.
    await resumeIfResolved();
  }

  async function handleReject(pendingId: string, reason?: string): Promise<void> {
    await client.resolvePendingAction(conversationId, pendingId, "reject", reason);
    await reload();
    await resumeIfResolved();
  }

  const pendingByMessage = useMemo(() => {
    const m = new Map<string, ChatPendingAction[]>();
    for (const p of pending) {
      const list = m.get(p.messageId) ?? [];
      list.push(p);
      m.set(p.messageId, list);
    }
    return m;
  }, [pending]);

  // Tool results live in follow-up user messages; index them by tool_use_id so
  // each result renders inside its tool card instead of as a "You" message.
  const toolResultsById = useMemo(() => {
    const m = new Map<string, { text: string; isError: boolean }>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c.text).join("\n")
          : block.content;
        m.set(block.tool_use_id, { text, isError: !!block.is_error });
      }
    }
    return m;
  }, [messages]);

  // Messages that are pure tool plumbing (only tool_result blocks) are hidden;
  // their content shows up inside the corresponding tool card.
  const visibleMessages = useMemo(
    () => messages.filter((m) => !m.content.every((b) => b.type === "tool_result")),
    [messages],
  );

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-sm font-semibold truncate">{conversation?.title ?? "Chat"}</h1>
          {conversation && (
            <select
              value={conversation.model}
              onChange={(e) => void handleModelChange(e.target.value)}
              disabled={streaming.active}
              aria-label="Model"
              className="bg-surface-overlay border border-border rounded-md px-2 py-1 text-xs text-on-surface-secondary focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            >
              {CHAT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {!CHAT_MODELS.some((m) => m.id === conversation.model) && (
                <option value={conversation.model}>{conversation.model} (legacy)</option>
              )}
            </select>
          )}
        </div>
        <div className="text-xs text-on-surface-muted text-right">
          <div>
            Spend: ${spend ? microsToUsd(spend.monthToDateMicros) : "0.00"}
            {spend?.monthlyCapMicros != null ? ` / $${microsToUsd(spend.monthlyCapMicros)}` : ""}
            {spend?.freeTier ? " (free tier)" : ""}
          </div>
          {spend?.exceeded && <div className="text-amber-500 font-medium">Cap reached</div>}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-3">
          {visibleMessages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              pendingActions={pendingByMessage.get(m.id) ?? []}
              toolResults={toolResultsById}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
          {streaming.active && (
            <div className="space-y-2">
              {streaming.text && (
                <div className="text-sm whitespace-pre-wrap text-on-surface-secondary">
                  {streaming.text}
                </div>
              )}
              {streaming.toolUses.map((t) => (
                <div
                  key={t.id}
                  className="border border-border rounded-lg px-3 py-1.5 text-xs bg-surface-overlay flex items-center justify-between"
                >
                  <span className="font-mono text-on-surface-secondary">{t.name}</span>
                  <span className={t.executed ? "text-emerald-500" : "text-on-surface-muted"}>
                    {t.executed ? "Done" : "Running…"}
                  </span>
                </div>
              ))}
              {!streaming.text && streaming.toolUses.length === 0 && (
                <div className="text-on-surface-faint text-sm animate-pulse">Thinking…</div>
              )}
            </div>
          )}
          {streaming.error && (
            <div className="text-red-500 text-sm whitespace-pre-wrap">{streaming.error}</div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <footer className="border-t border-border p-4">
        <div className="max-w-3xl mx-auto flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            disabled={streaming.active}
            placeholder="Ask anything about your infrastructure…"
            rows={2}
            className="flex-1 bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            aria-label="Message"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={streaming.active || input.trim().length === 0}
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            Send
          </button>
        </div>
      </footer>
    </div>
  );
}

interface BubbleProps {
  message: ChatConversationMessage;
  pendingActions: ChatPendingAction[];
  toolResults: Map<string, { text: string; isError: boolean }>;
  onApprove(id: string): Promise<void>;
  onReject(id: string, reason?: string): Promise<void>;
}

function MessageBubble({
  message,
  pendingActions,
  toolResults,
  onApprove,
  onReject,
}: BubbleProps): React.ReactElement {
  const isAssistant = message.role === "assistant";
  const pendingByToolUseId = new Map<string, ChatPendingAction>(
    pendingActions.map((p) => [p.toolUseId, p]),
  );

  // DM layout: the user's messages are right-aligned bubbles, the assistant
  // replies flow plainly on the left — no per-message role labels.
  if (!isAssistant) {
    const text = message.content
      .filter((b): b is Extract<ChatContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] bg-blue-600 text-white rounded-2xl rounded-br-md px-4 py-2 text-sm whitespace-pre-wrap break-words">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {message.content.map((block, i) => (
        <BlockView
          key={i}
          block={block}
          pending={block.type === "tool_use" ? pendingByToolUseId.get(block.id) : undefined}
          result={block.type === "tool_use" ? toolResults.get(block.id) : undefined}
          onApprove={onApprove}
          onReject={onReject}
        />
      ))}
    </div>
  );
}

interface BlockProps {
  block: ChatContentBlock;
  pending: ChatPendingAction | undefined;
  result: { text: string; isError: boolean } | undefined;
  onApprove(id: string): Promise<void>;
  onReject(id: string, reason?: string): Promise<void>;
}

function BlockView({
  block,
  pending,
  result,
  onApprove,
  onReject,
}: BlockProps): React.ReactElement | null {
  if (block.type === "text") {
    return (
      <div className="text-sm whitespace-pre-wrap text-on-surface-secondary">{block.text}</div>
    );
  }
  if (block.type === "tool_use") {
    const status = pending?.status ?? (result?.isError ? "errored" : "executed");
    const statusLabel =
      status === "pending"
        ? "Pending approval"
        : status === "approved"
          ? "Approved…"
          : status === "rejected"
            ? "Rejected"
            : status === "errored"
              ? "Errored"
              : "Done";
    const statusColor =
      status === "pending"
        ? "text-amber-500"
        : status === "rejected" || status === "errored"
          ? "text-red-500"
          : status === "executed"
            ? "text-emerald-500"
            : "text-on-surface-muted";
    const resultText = pending?.result ?? result?.text;

    return (
      <div className="border border-border rounded-lg bg-surface-overlay text-xs">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="font-mono text-on-surface-secondary">{block.name}</span>
          <span className={statusColor}>{statusLabel}</span>
        </div>
        {pending?.status === "pending" && (
          <div className="flex gap-2 px-3 pb-2">
            <button
              type="button"
              onClick={() => void onApprove(pending.id)}
              className="px-2.5 py-1 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => void onReject(pending.id)}
              className="px-2.5 py-1 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
            >
              Reject
            </button>
          </div>
        )}
        <details
          className="border-t border-border px-3 py-1.5"
          // While awaiting approval the input must be visible — the user is
          // deciding whether to run it. Otherwise collapsed by default.
          {...(status === "pending" ? { open: true } : {})}
        >
          <summary className="cursor-pointer text-on-surface-faint select-none">Details</summary>
          <div className="mt-1 space-y-2 pb-1">
            <div>
              <div className="text-on-surface-faint mb-0.5">Input</div>
              <pre className="whitespace-pre-wrap break-words text-on-surface-muted font-mono text-[11px]">
                {JSON.stringify(block.input, null, 2)}
              </pre>
            </div>
            {resultText != null && (
              <div>
                <div className="text-on-surface-faint mb-0.5">
                  Result{(pending?.isError ?? result?.isError) ? " (error)" : ""}
                </div>
                <pre className="whitespace-pre-wrap break-words text-on-surface-muted font-mono text-[11px]">
                  {resultText}
                </pre>
              </div>
            )}
          </div>
        </details>
      </div>
    );
  }
  // tool_result blocks render inside their tool card (see toolResultsById);
  // nothing to show standalone.
  return null;
}
