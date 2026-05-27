import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import {
  microsToUsd,
  type ChatMessage,
  type ContentBlock,
  type ConversationSummary,
  type PendingAction,
  type SpendStatus,
} from "./types";

interface Props {
  orgId: string;
  conversationId: string;
}

interface StreamingState {
  active: boolean;
  /** Buffered text for the in-flight assistant message (assistantId → text). */
  text: string;
  toolUses: Array<{ id: string; name: string; input: string; executed?: boolean }>;
  error?: string | undefined;
}

export function ConversationView({ orgId, conversationId }: Props): React.ReactElement {
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [spend, setSpend] = useState<SpendStatus | null>(null);
  const [streaming, setStreaming] = useState<StreamingState>({
    active: false,
    text: "",
    toolUses: [],
  });
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    const data = await apiGet<{
      conversation: ConversationSummary;
      messages: ChatMessage[];
      pendingActions: PendingAction[];
    }>(`/api/org/${orgId}/chat/conversations/${conversationId}`);
    setConversation(data.conversation);
    setMessages(data.messages);
    setPending(data.pendingActions);
    const s = await apiGet<SpendStatus>(`/api/org/${orgId}/chat/spend`);
    setSpend(s);
  }, [orgId, conversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming.text, streaming.toolUses.length]);

  const startStream = useCallback(
    async (body: { text?: string; resume?: boolean }) => {
      setStreaming({ active: true, text: "", toolUses: [] });

      const res = await fetch(`/api/org/${orgId}/chat/conversations/${conversationId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        setStreaming({ active: false, text: "", toolUses: [], error: text });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let stopped = false;

      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          // Parse SSE frame: event:<name>\ndata:<json>
          const lines = frame.split("\n");
          let dataLine = "";
          for (const ln of lines) {
            if (ln.startsWith("data:")) dataLine += ln.slice(5).trimStart();
          }
          if (!dataLine) continue;
          let ev: { type: string; [key: string]: unknown };
          try {
            ev = JSON.parse(dataLine) as { type: string; [key: string]: unknown };
          } catch {
            continue;
          }
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
            stopped = true;
            break;
          } else if (ev.type === "spend_blocked") {
            setStreaming((s) => ({
              ...s,
              error: `Monthly chat spend cap reached ($${microsToUsd(
                Number(ev["monthlyCapMicros"]),
              )}). Increase the cap in org settings or wait for next month.`,
            }));
            stopped = true;
            break;
          } else if (ev.type === "error") {
            setStreaming((s) => ({ ...s, error: ev["message"] as string }));
            stopped = true;
            break;
          }
        }
      }

      setStreaming((s) => ({ ...s, active: false }));
      await reload();
    },
    [conversationId, orgId, reload],
  );

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (!text || streaming.active) return;
    setInput("");
    await startStream({ text });
  }

  async function handleApprove(pendingId: string): Promise<void> {
    await apiPost(`/api/org/${orgId}/chat/conversations/${conversationId}/pending/${pendingId}`, {
      action: "approve",
    });
    await reload();
    // If all pending actions for the latest assistant message are now resolved,
    // resume the model loop with the tool results.
    const data = await apiGet<{ pendingActions: PendingAction[] }>(
      `/api/org/${orgId}/chat/conversations/${conversationId}`,
    );
    const unresolved = data.pendingActions.some(
      (p) => p.status === "pending" || p.status === "approved",
    );
    if (!unresolved && data.pendingActions.length > 0) {
      await startStream({ resume: true });
    }
  }

  async function handleReject(pendingId: string, reason?: string): Promise<void> {
    await apiPost(`/api/org/${orgId}/chat/conversations/${conversationId}/pending/${pendingId}`, {
      action: "reject",
      ...(reason ? { reason } : {}),
    });
    await reload();
    const data = await apiGet<{ pendingActions: PendingAction[] }>(
      `/api/org/${orgId}/chat/conversations/${conversationId}`,
    );
    const unresolved = data.pendingActions.some(
      (p) => p.status === "pending" || p.status === "approved",
    );
    if (!unresolved && data.pendingActions.length > 0) {
      await startStream({ resume: true });
    }
  }

  const pendingByMessage = useMemo(() => {
    const m = new Map<string, PendingAction[]>();
    for (const p of pending) {
      const list = m.get(p.messageId) ?? [];
      list.push(p);
      m.set(p.messageId, list);
    }
    return m;
  }, [pending]);

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold">{conversation?.title ?? "Chat"}</h1>
          <p className="text-xs text-on-surface-faint">{conversation?.model}</p>
        </div>
        <div className="text-xs text-on-surface-muted text-right">
          <div>
            Spend: ${spend ? microsToUsd(spend.monthToDateMicros) : "0.00"}
            {spend?.monthlyCapMicros != null ? ` / $${microsToUsd(spend.monthlyCapMicros)}` : ""}
          </div>
          {spend?.exceeded && <div className="text-amber-500 font-medium">Cap reached</div>}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            pendingActions={pendingByMessage.get(m.id) ?? []}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        ))}
        {streaming.active && (
          <div className="text-on-surface-secondary text-sm">
            <div className="text-xs text-on-surface-faint mb-1">Assistant</div>
            <div className="whitespace-pre-wrap">{streaming.text}</div>
            {streaming.toolUses.map((t) => (
              <div
                key={t.id}
                className="mt-2 border border-border rounded-md px-3 py-1.5 text-xs text-on-surface-muted bg-surface-overlay"
              >
                <span className="font-mono">{t.name}</span>
                {t.executed ? " ✓" : " …"}
              </div>
            ))}
          </div>
        )}
        {streaming.error && (
          <div className="text-red-500 text-sm whitespace-pre-wrap">{streaming.error}</div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className="border-t border-border p-4">
        <div className="flex gap-2">
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
  message: ChatMessage;
  pendingActions: PendingAction[];
  onApprove(id: string): Promise<void>;
  onReject(id: string, reason?: string): Promise<void>;
}

function MessageBubble({
  message,
  pendingActions,
  onApprove,
  onReject,
}: BubbleProps): React.ReactElement {
  const isAssistant = message.role === "assistant";
  const pendingByToolUseId = new Map<string, PendingAction>(
    pendingActions.map((p) => [p.toolUseId, p]),
  );

  return (
    <div className={isAssistant ? "" : "pl-8"}>
      <div className="text-xs text-on-surface-faint mb-1">{isAssistant ? "Assistant" : "You"}</div>
      <div className="space-y-2">
        {message.content.map((block, i) => (
          <BlockView
            key={i}
            block={block}
            pending={block.type === "tool_use" ? pendingByToolUseId.get(block.id) : undefined}
            onApprove={onApprove}
            onReject={onReject}
          />
        ))}
      </div>
    </div>
  );
}

interface BlockProps {
  block: ContentBlock;
  pending: PendingAction | undefined;
  onApprove(id: string): Promise<void>;
  onReject(id: string, reason?: string): Promise<void>;
}

function BlockView({ block, pending, onApprove, onReject }: BlockProps): React.ReactElement | null {
  if (block.type === "text") {
    return (
      <div className="text-sm whitespace-pre-wrap text-on-surface-secondary">{block.text}</div>
    );
  }
  if (block.type === "tool_use") {
    const status = pending?.status ?? "executed";
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

    return (
      <div className="border border-border rounded-md p-3 bg-surface-overlay text-xs">
        <div className="flex items-center justify-between">
          <span className="font-mono text-on-surface-secondary">{block.name}</span>
          <span className={statusColor}>{statusLabel}</span>
        </div>
        <pre className="mt-2 whitespace-pre-wrap break-words text-on-surface-muted font-mono text-[11px]">
          {JSON.stringify(block.input, null, 2)}
        </pre>
        {pending?.status === "pending" && (
          <div className="flex gap-2 mt-2">
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
        {pending?.result && (
          <details className="mt-2">
            <summary className="cursor-pointer text-on-surface-faint">Result</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words text-on-surface-muted text-[11px]">
              {pending.result}
            </pre>
          </details>
        )}
      </div>
    );
  }
  if (block.type === "tool_result") {
    const txt = Array.isArray(block.content)
      ? block.content.map((c) => c.text).join("\n")
      : block.content;
    return (
      <details className="text-xs">
        <summary className="cursor-pointer text-on-surface-faint">
          Tool result {block.is_error ? "(error)" : ""}
        </summary>
        <pre className="mt-1 whitespace-pre-wrap break-words text-on-surface-muted font-mono text-[11px]">
          {txt}
        </pre>
      </details>
    );
  }
  return null;
}
