import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { useUIStore } from "../store/ui.store.js";
import {
  CHAT_MODELS,
  emitChatConversationsChanged,
  microsToUsd,
  type ChatClient,
  type ChatConversationMessage,
  type ChatContentBlock,
  type ChatPendingAction,
  type ChatPendingSecretRequest,
  type ConversationSummary,
  type SpendStatus,
} from "./types.js";

interface Props {
  client: ChatClient;
  conversationId: string;
}

interface StreamingState {
  active: boolean;
  /**
   * Optimistic echo of the user message just sent, shown as a bubble until
   * the reload swaps in the persisted copy.
   */
  userText?: string | undefined;
  /** Buffered text for the in-flight assistant message. */
  text: string;
  toolUses: Array<{ id: string; name: string; input: string; executed?: boolean }>;
  error?: string | undefined;
}

interface ConversationViewState {
  conversation: ConversationSummary | null;
  messages: ChatConversationMessage[];
  pending: ChatPendingAction[];
  pendingSecrets: ChatPendingSecretRequest[];
  spend: SpendStatus | null;
  streaming: StreamingState;
  input: string;
  sleeping: number | null;
  activeSleepIds: ReadonlySet<string>;
}

type ConversationViewAction =
  | { patch: Partial<ConversationViewState> }
  | { update: (state: ConversationViewState) => Partial<ConversationViewState> };

function conversationViewReducer(
  state: ConversationViewState,
  action: ConversationViewAction,
): ConversationViewState {
  return { ...state, ...("patch" in action ? action.patch : action.update(state)) };
}

export function ConversationView({ client, conversationId }: Props): React.ReactElement {
  const [state, dispatch] = useReducer(conversationViewReducer, {
    conversation: null,
    messages: [],
    pending: [],
    pendingSecrets: [],
    spend: null,
    streaming: { active: false, text: "", toolUses: [] },
    input: "",
    sleeping: null,
    activeSleepIds: new Set<string>(),
  });
  const {
    conversation,
    messages,
    pending,
    pendingSecrets,
    spend,
    streaming,
    input,
    sleeping,
    activeSleepIds,
  } = state;
  /**
   * Sleep countdown plus the tool_use ids still waiting. Persisted "Slept N
   * seconds" markers stay hidden until the wait actually happened.
   */
  // Ref mirror for callbacks that must not resume mid-countdown (approving a
  // destructive action while a sleep from the same batch is still running).
  const sleepingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(
    async (opts?: { clearStreamingBuffer?: boolean }) => {
      const [data, s] = await Promise.all([
        client.getConversation(conversationId),
        client.getSpend(),
      ]);
      // All state updates in one synchronous block so React batches them into
      // a single render. Clearing the streaming buffer in a later microtask
      // than setMessages briefly showed the turn's text twice (persisted +
      // still-buffered) — a flash of duplicated text at the end of each turn.
      dispatch({
        update: (current) => ({
          conversation: data.conversation,
          messages: data.messages,
          pending: data.pendingActions,
          pendingSecrets: data.pendingSecretRequests,
          spend: s,
          ...(opts?.clearStreamingBuffer
            ? {
                streaming: {
                  ...current.streaming,
                  userText: undefined,
                  text: "",
                  toolUses: [],
                },
              }
            : {}),
        }),
      });
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
    },
    [client, conversationId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming.userText, streaming.text, streaming.toolUses.length]);

  const startStream = useCallback(
    async (body: { text?: string; resume?: boolean }) => {
      dispatch({
        patch: {
          streaming: { active: true, userText: body.text, text: "", toolUses: [] },
        },
      });
      // Longest sleep the agent requested this turn; the wait runs here on
      // the client after the stream suspends, then hands back to the server.
      let sleepSeconds = 0;

      try {
        for await (const ev of client.streamTurn(conversationId, body)) {
          if (ev.type === "text_delta") {
            const delta = ev["delta"] as string;
            dispatch({
              update: (current) => ({
                streaming: { ...current.streaming, text: current.streaming.text + delta },
              }),
            });
          } else if (ev.type === "sleep") {
            sleepSeconds = Math.max(sleepSeconds, Number(ev["seconds"]) || 0);
            const toolUseId = ev["toolUseId"] as string;
            dispatch({
              update: (current) => ({
                activeSleepIds: new Set(current.activeSleepIds).add(toolUseId),
              }),
            });
          } else if (ev.type === "tool_use_start") {
            // Sleep renders as its own indicator, not as a tool card.
            if (ev["name"] === "sleep") continue;
            dispatch({
              update: (current) => ({
                streaming: {
                  ...current.streaming,
                  toolUses: [
                    ...current.streaming.toolUses,
                    {
                      id: ev["toolUseId"] as string,
                      name: ev["name"] as string,
                      input: "",
                    },
                  ],
                },
              }),
            });
          } else if (ev.type === "tool_use_input") {
            const id = ev["toolUseId"] as string;
            const partial = ev["partialJson"] as string;
            dispatch({
              update: (current) => ({
                streaming: {
                  ...current.streaming,
                  toolUses: current.streaming.toolUses.map((t) =>
                    t.id === id ? { ...t, input: t.input + partial } : t,
                  ),
                },
              }),
            });
          } else if (ev.type === "tool_executed") {
            const id = ev["toolUseId"] as string;
            dispatch({
              update: (current) => ({
                streaming: {
                  ...current.streaming,
                  toolUses: current.streaming.toolUses.map((t) =>
                    t.id === id ? { ...t, executed: true } : t,
                  ),
                },
              }),
            });
          } else if (ev.type === "pending_action") {
            // Server has persisted the action; we'll see it after reload.
          } else if (ev.type === "turn_end") {
            if (ev["hasPending"]) break;
            // Not necessarily the end of the loop: after auto-run tools the
            // server feeds the results back to the model and streams another
            // assistant message. Swap the in-flight buffer for the persisted
            // messages (atomically — see reload) and keep reading; the stream
            // closes when the model really is done.
            await reload({ clearStreamingBuffer: true });
          } else if (ev.type === "spend_blocked") {
            const cap = microsToUsd(Number(ev["monthlyCapMicros"]));
            dispatch({
              update: (current) => ({
                streaming: {
                  ...current.streaming,
                  error: ev["freeTier"]
                    ? `Free-tier chat limit reached ($${cap}/month). Add a payment method in Settings → Billing to keep chatting, or wait for next month.`
                    : `Monthly chat spend cap reached ($${cap}). Increase the cap in org settings or wait for next month.`,
                },
              }),
            });
            break;
          } else if (ev.type === "error") {
            dispatch({
              update: (current) => ({
                streaming: { ...current.streaming, error: ev["message"] as string },
              }),
            });
            break;
          }
        }
      } catch (e) {
        dispatch({
          update: (current) => ({
            streaming: {
              ...current.streaming,
              error: e instanceof Error ? e.message : "Chat stream failed",
            },
          }),
        });
      }

      dispatch({
        update: (current) => ({
          streaming: { ...current.streaming, active: false },
        }),
      });
      // clearStreamingBuffer: the optimistic user bubble is swapped for the
      // persisted message in the same render.
      await reload({ clearStreamingBuffer: true });
      // A completed turn can rename the conversation and bumps updatedAt —
      // let session lists pick that up.
      emitChatConversationsChanged();

      if (sleepSeconds > 0) {
        // Client-side sleep: count down, then hand back to the server — but
        // only when nothing else is still awaiting approval (a sleep can land
        // in the same batch as a destructive tool).
        sleepingRef.current = true;
        try {
          for (let remaining = sleepSeconds; remaining > 0; remaining--) {
            dispatch({ patch: { sleeping: remaining } });
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } finally {
          sleepingRef.current = false;
          dispatch({ patch: { sleeping: null, activeSleepIds: new Set() } });
        }
        const data = await client.getConversation(conversationId);
        const unresolved = data.pendingActions.some(
          (p) => p.status === "pending" || p.status === "approved",
        );
        const secretUnresolved = data.pendingSecretRequests.some(
          (request) => request.status === "pending" || request.status === "submitting",
        );
        if (!unresolved && !secretUnresolved) await startStream({ resume: true });
      }
    },
    [client, conversationId, reload],
  );

  async function handleSend(): Promise<void> {
    const text = input.trim();
    if (!text || streaming.active || sleeping != null) return;
    dispatch({ patch: { input: "" } });
    await startStream({ text });
  }

  async function handleModelChange(model: string): Promise<void> {
    if (!conversation || model === conversation.model) return;
    // Optimistic — the select shouldn't snap back while the PATCH is in flight.
    dispatch({ patch: { conversation: { ...conversation, model } } });
    try {
      await client.setConversationModel(conversationId, model);
      emitChatConversationsChanged();
    } catch (e) {
      dispatch({
        update: (current) => ({
          conversation,
          streaming: {
            ...current.streaming,
            error: e instanceof Error ? e.message : "Failed to change model",
          },
        }),
      });
    }
  }

  const resumeIfResolved = useCallback(async () => {
    // A sleep from the same tool batch is still counting down — it will do
    // its own resolved-check and resume when it finishes.
    if (sleepingRef.current) return;
    const data = await client.getConversation(conversationId);
    const unresolved = data.pendingActions.some(
      (p) => p.status === "pending" || p.status === "approved",
    );
    const secretUnresolved = data.pendingSecretRequests.some(
      (request) => request.status === "pending" || request.status === "submitting",
    );
    if (
      !unresolved &&
      !secretUnresolved &&
      data.pendingActions.length + data.pendingSecretRequests.length > 0
    ) {
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

  async function handleSecretSubmit(requestId: string, value: string): Promise<void> {
    await client.submitSecretRequest(conversationId, requestId, value);
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

  const pendingSecretsByToolUseId = useMemo(
    () => new Map(pendingSecrets.map((request) => [request.toolUseId, request])),
    [pendingSecrets],
  );

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
            {spend?.freeTier ? " (free tier)" : spend?.complimentary ? " (complimentary)" : ""}
          </div>
          {spend?.exceeded && <div className="text-warning font-medium">Cap reached</div>}
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto space-y-3">
          {visibleMessages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              pendingActions={pendingByMessage.get(m.id) ?? []}
              pendingSecrets={pendingSecretsByToolUseId}
              toolResults={toolResultsById}
              activeSleepIds={activeSleepIds}
              onApprove={handleApprove}
              onReject={handleReject}
              onSubmitSecret={handleSecretSubmit}
            />
          ))}
          {streaming.userText && (
            <div className="flex justify-end">
              <div className="max-w-[75%] bg-blue-600 text-white rounded-2xl rounded-br-md px-4 py-2 text-sm whitespace-pre-wrap break-words">
                {streaming.userText}
              </div>
            </div>
          )}
          {streaming.active && (
            <div className="space-y-2">
              {streaming.text && <ChatMarkdown text={streaming.text} />}
              {streaming.toolUses.map((t) => (
                <div
                  key={t.id}
                  className="border border-border rounded-lg px-3 py-1.5 text-xs bg-surface-overlay flex items-center justify-between"
                >
                  <span className="font-mono text-on-surface-secondary">{t.name}</span>
                  <span className={t.executed ? "text-success" : "text-on-surface-muted"}>
                    {t.executed ? "Done" : "Running…"}
                  </span>
                </div>
              ))}
              {!streaming.text && streaming.toolUses.length === 0 && (
                <div className="text-on-surface-faint text-sm animate-pulse">Thinking…</div>
              )}
            </div>
          )}
          {sleeping != null && (
            <div className="text-on-surface-faint text-sm animate-pulse">
              Sleeping {sleeping} second{sleeping === 1 ? "" : "s"}…
            </div>
          )}
          {streaming.error && (
            <div className="text-danger text-sm whitespace-pre-wrap">{streaming.error}</div>
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <footer className="border-t border-border p-4">
        <div className="max-w-3xl mx-auto flex gap-2">
          <textarea
            value={input}
            onChange={(e) => dispatch({ patch: { input: e.target.value } })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            disabled={streaming.active || sleeping != null}
            placeholder="Ask anything about your infrastructure…"
            rows={2}
            className="flex-1 bg-surface-overlay border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            aria-label="Message"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={streaming.active || sleeping != null || input.trim().length === 0}
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
  pendingSecrets: Map<string, ChatPendingSecretRequest>;
  toolResults: Map<string, { text: string; isError: boolean }>;
  activeSleepIds: ReadonlySet<string>;
  onApprove(id: string): Promise<void>;
  onReject(id: string, reason?: string): Promise<void>;
  onSubmitSecret(id: string, value: string): Promise<void>;
}

function MessageBubble({
  message,
  pendingActions,
  pendingSecrets,
  toolResults,
  activeSleepIds,
  onApprove,
  onReject,
  onSubmitSecret,
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
          pendingSecret={block.type === "tool_use" ? pendingSecrets.get(block.id) : undefined}
          result={block.type === "tool_use" ? toolResults.get(block.id) : undefined}
          sleepInProgress={block.type === "tool_use" && activeSleepIds.has(block.id)}
          onApprove={onApprove}
          onReject={onReject}
          onSubmitSecret={onSubmitSecret}
        />
      ))}
    </div>
  );
}

interface BlockProps {
  block: ChatContentBlock;
  pending: ChatPendingAction | undefined;
  pendingSecret: ChatPendingSecretRequest | undefined;
  result: { text: string; isError: boolean } | undefined;
  /** True while this sleep tool_use is still counting down client-side. */
  sleepInProgress: boolean;
  onApprove(id: string): Promise<void>;
  onReject(id: string, reason?: string): Promise<void>;
  onSubmitSecret(id: string, value: string): Promise<void>;
}

function BlockView({
  block,
  pending,
  pendingSecret,
  result,
  sleepInProgress,
  onApprove,
  onReject,
  onSubmitSecret,
}: BlockProps): React.ReactElement | null {
  // Approve executes the tool synchronously server-side (a workflow run can
  // take minutes), so the buttons must lock and the label must say the action
  // is underway — otherwise the card looks hung and invites a second click.
  const [resolving, setResolving] = useState<"approve" | "reject" | null>(null);

  async function resolve(action: "approve" | "reject"): Promise<void> {
    if (!pending || resolving) return;
    setResolving(action);
    try {
      if (action === "approve") await onApprove(pending.id);
      else await onReject(pending.id);
    } finally {
      setResolving(null);
    }
  }

  if (block.type === "text") {
    return <ChatMarkdown text={block.text} />;
  }
  if (block.type === "tool_use") {
    // Sleep is not a real tool call — render it as a quiet marker, matching
    // the live "Sleeping N seconds…" indicator. While the countdown is still
    // running, show nothing here (the live indicator covers it): the past
    // tense would be a lie.
    if (block.name === "sleep") {
      if (sleepInProgress) return null;
      const secs = Number(block.input["seconds"]);
      return (
        <div className="text-xs text-on-surface-faint italic">
          Slept {Number.isFinite(secs) ? secs : "a few"} seconds
        </div>
      );
    }
    if (block.name === "write_workflow_secret") {
      return pendingSecret ? (
        <SecretRequestCard request={pendingSecret} onSubmit={onSubmitSecret} />
      ) : null;
    }
    const status = pending?.status ?? (result?.isError ? "errored" : "executed");
    const statusLabel =
      status === "pending"
        ? resolving === "approve"
          ? "Running…"
          : resolving === "reject"
            ? "Rejecting…"
            : "Pending approval"
        : status === "approved"
          ? "Running…"
          : status === "rejected"
            ? "Rejected"
            : status === "errored"
              ? "Errored"
              : "Done";
    const statusColor =
      status === "pending" && !resolving
        ? "text-warning"
        : status === "rejected" || status === "errored"
          ? "text-danger"
          : status === "executed"
            ? "text-success"
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
              disabled={resolving !== null}
              onClick={() => void resolve("approve")}
              className="px-2.5 py-1 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded transition-colors disabled:opacity-50 disabled:pointer-events-none"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={resolving !== null}
              onClick={() => void resolve("reject")}
              className="px-2.5 py-1 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-50 disabled:pointer-events-none"
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

function SecretRequestCard({
  request,
  onSubmit,
}: {
  request: ChatPendingSecretRequest;
  onSubmit(id: string, value: string): Promise<void>;
}): React.ReactElement {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = request.status === "stored";

  async function submit(): Promise<void> {
    if (submitting || resolved || value.length === 0) return;
    const submittedValue = value;
    setValue("");
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request.id, submittedValue);
    } catch {
      setError("Secret could not be stored. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border border-border rounded-lg bg-surface-overlay text-xs">
      <div className="px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-on-surface-secondary">
            {request.title ?? `Enter ${request.name}`}
          </span>
          <span className={resolved ? "text-success" : "text-warning"}>
            {resolved ? "Stored" : submitting ? "Storing…" : "Value required"}
          </span>
        </div>
        {request.description && <p className="mt-1 text-on-surface-muted">{request.description}</p>}
      </div>
      {!resolved && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          <div className="flex gap-2">
            <input
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              disabled={submitting || request.status === "submitting"}
              autoComplete="new-password"
              aria-label={request.title ?? `Secret value for ${request.name}`}
              className="min-w-0 flex-1 bg-surface border border-border rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="button"
              disabled={submitting || request.status === "submitting" || value.length === 0}
              onClick={() => void submit()}
              className="px-2.5 py-1 font-medium bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 disabled:pointer-events-none"
            >
              {submitting ? "Storing…" : "Store"}
            </button>
          </div>
          {error && <div className="text-danger">{error}</div>}
          <div className="text-on-surface-faint">
            Sent directly to encrypted secret storage. It is never shown to the model.
          </div>
        </div>
      )}
    </div>
  );
}
