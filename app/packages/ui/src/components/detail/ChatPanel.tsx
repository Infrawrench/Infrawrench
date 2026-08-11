import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatPanelCapability, ChatStreamEvent } from "@infrawrench/plugin-base";

interface Props {
  capability: ChatPanelCapability;
  /**
   * Open a stream against the plugin. Returns an async iterable of stream
   * events. The host wraps the plugin's `streamChatMessage` (Electron IPC
   * for desktop, NDJSON over fetch for web). On the host side this should
   * propagate cancellation via AbortSignal so background streams stop when
   * the user navigates away. `options.model` carries the picker selection when
   * the capability declares `models`.
   */
  onStream: (
    messages: ChatMessage[],
    signal: AbortSignal,
    options?: { model?: string },
  ) => AsyncIterable<ChatStreamEvent>;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  /** True while the stream is still pumping deltas into this turn. */
  pending?: boolean;
  /** Set when the stream ended with an error. */
  error?: string;
  /** Populated from the terminal `done` event. */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export function ChatPanel({ capability, onStream }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string>(
    () => capability.defaultModel ?? capability.models?.[0] ?? "",
  );
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-scroll to the bottom on every delta. The user can scroll up to
  // pause auto-follow — checked by comparing scroll position to the
  // pre-update height before applying the new content.
  const userPausedRef = useRef(false);
  useEffect(() => {
    if (userPausedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userPausedRef.current = !nearBottom;
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    userPausedRef.current = false;

    // Lock in the prior history (excluding any pending turn) plus the new
    // user turn, then add an empty pending assistant turn we can append
    // deltas to. React state batching keeps the rendered transitions clean.
    const history: Turn[] = [...turns.filter((t) => !t.pending), { role: "user", content: text }];
    setTurns([...history, { role: "assistant", content: "", pending: true }]);

    const messages: ChatMessage[] = history.map((t) => ({
      role: t.role,
      content: t.content,
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    let assembled = "";
    let error: string | undefined;
    let usage: Turn["usage"] | undefined;

    try {
      for await (const event of onStream(
        messages,
        controller.signal,
        model ? { model } : undefined,
      )) {
        if (controller.signal.aborted) break;
        if (event.kind === "delta") {
          assembled += event.text;
          // Live update — replace the trailing pending turn with the
          // current accumulator on each token.
          setTurns((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.pending) {
              next[next.length - 1] = { ...last, content: assembled };
            }
            return next;
          });
        } else if (event.kind === "done") {
          // The plugin sends the assembled message in the terminal event;
          // prefer it over our locally-accumulated copy in case the server
          // post-processed the final text (e.g. trimming trailing whitespace).
          assembled = event.message.content;
          usage = event.usage;
        } else if (event.kind === "error") {
          error = event.message;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      setStreaming(false);
      abortRef.current = null;
      setTurns((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.pending) {
          next[next.length - 1] = {
            role: "assistant",
            content: assembled,
            ...(error ? { error } : {}),
            ...(usage ? { usage } : {}),
          };
        }
        return next;
      });
    }
  }, [input, streaming, turns, onStream, model]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    if (streaming) abortRef.current?.abort();
    setTurns([]);
    setInput("");
  }, [streaming]);

  // Submit on Cmd/Ctrl+Enter, plain Enter for newline (matches OpenAI
  // playground convention — long prompts want easy multi-line editing).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  // Auto-grow the textarea up to a reasonable cap.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  const disabled = !!capability.disabledReason;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          {capability.tabLabel ?? "Playground"}
        </span>
        {capability.subtitle && (
          <span className="text-xs text-on-surface-tertiary truncate">{capability.subtitle}</span>
        )}
        {capability.models && capability.models.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-on-surface-tertiary">
            <span className="sr-only">{capability.modelLabel ?? "Model"}</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={streaming}
              aria-label={capability.modelLabel ?? "Model"}
              className="max-w-[18rem] bg-surface-overlay text-on-surface text-xs border border-border-strong rounded-md px-2 py-1 focus:outline-none focus:border-accent-blue disabled:opacity-60"
            >
              {capability.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-2">
          {streaming && (
            <button
              type="button"
              onClick={stop}
              className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
            >
              Stop
            </button>
          )}
          {turns.length > 0 && !streaming && (
            <button
              type="button"
              onClick={reset}
              className="px-3 py-1 text-xs text-on-surface-tertiary hover:text-white border border-border-strong hover:border-border-strong rounded-md transition-colors"
            >
              New chat
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto p-4 space-y-4"
      >
        {turns.length === 0 && capability.greeting && (
          <div className="text-sm text-on-surface-tertiary italic max-w-2xl">
            {capability.greeting}
          </div>
        )}
        {turns.map((turn, i) => (
          <ChatTurn key={i} turn={turn} />
        ))}
      </div>

      <div className="border-t border-border bg-surface shrink-0 px-3 py-2">
        {disabled ? (
          <div className="text-xs text-on-surface-tertiary py-2 px-1">
            {capability.disabledReason}
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              aria-label="Message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={capability.inputPlaceholder ?? "Send a message…"}
              rows={1}
              className="flex-1 resize-none bg-surface-overlay text-on-surface text-sm border border-border-strong rounded-md px-3 py-2 focus:outline-none focus:border-accent-blue placeholder:text-on-surface-faint"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim() || streaming}
              className="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-md hover:bg-accent-blue/90 disabled:bg-surface-overlay disabled:text-on-surface-faint disabled:cursor-not-allowed transition-colors"
            >
              {streaming ? "…" : "Send"}
            </button>
          </div>
        )}
        <div className="text-[11px] text-on-surface-faint mt-1 px-1">
          {streaming ? "Streaming…" : "Cmd/Ctrl + Enter to send"}
        </div>
      </div>
    </div>
  );
}

function ChatTurn({ turn }: { turn: Turn }) {
  const isUser = turn.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
          isUser
            ? "bg-accent-blue text-white"
            : "bg-surface-overlay text-on-surface border border-border"
        }`}
      >
        {turn.error ? (
          <div className="text-danger font-mono text-xs">
            <div className="font-semibold mb-1">Error</div>
            {turn.error}
          </div>
        ) : turn.content ? (
          turn.content
        ) : turn.pending ? (
          <span className="text-on-surface-faint italic">Thinking…</span>
        ) : (
          <span className="text-on-surface-faint italic">(empty response)</span>
        )}
        {turn.usage && !turn.pending && (
          <div className="text-[10px] text-on-surface-faint mt-1 font-mono">
            {[
              turn.usage.inputTokens != null ? `${turn.usage.inputTokens} in` : null,
              turn.usage.outputTokens != null ? `${turn.usage.outputTokens} out` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}
