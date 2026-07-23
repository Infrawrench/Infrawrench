import { useEffect, useId, useRef, useState } from "react";
import { Modal } from "@infrawrench/ui";
import type { MetricValue } from "@infrawrench/workflow-runtime/client";
import {
  WORKFLOW_PROMPT_EVENT,
  resolveWorkflowPrompt,
  type WorkflowPromptRequest,
} from "../lib/workflow-prompt";

/**
 * Mount once at the root. Renders a modal for each `infra.prompt()` raised by a
 * running workflow (Electron's window.prompt is a no-op). One at a time;
 * additional prompts queue. Resolving/canceling feeds the answer back to the
 * waiting workflow via {@link resolveWorkflowPrompt}.
 */
export function WorkflowPromptHost() {
  const [queue, setQueue] = useState<WorkflowPromptRequest[]>([]);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null);
  const messageId = useId();

  useEffect(() => {
    function onPrompt(e: Event) {
      const detail = (e as CustomEvent<WorkflowPromptRequest>).detail;
      if (!detail?.id) return;
      setQueue((prev) => [...prev, detail]);
    }
    window.addEventListener(WORKFLOW_PROMPT_EVENT, onPrompt);
    return () => window.removeEventListener(WORKFLOW_PROMPT_EVENT, onPrompt);
  }, []);

  const current = queue[0];

  // Seed the input with the prompt's default each time a new prompt surfaces.
  useEffect(() => {
    if (!current) return;
    setText(
      current.spec.kind === "select"
        ? (current.spec.defaultValue ?? current.spec.options?.[0]?.value ?? "")
        : (current.spec.defaultValue ?? ""),
    );
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [current]);

  if (!current) return null;

  const { spec } = current;
  const kind = spec.kind ?? "text";

  function answer(value: MetricValue) {
    resolveWorkflowPrompt(current!.id, value);
    setQueue((prev) => prev.slice(1));
  }

  function submitText() {
    if (kind === "number") {
      const trimmed = text.trim();
      const n = Number(trimmed);
      answer(trimmed === "" || Number.isNaN(n) ? null : n);
    } else {
      answer(text);
    }
  }

  return (
    <Modal onClose={() => answer(null)} ariaLabel="Workflow input">
      <div
        className={`bg-surface-raised border border-border-strong rounded-xl shadow-2xl p-6 ${
          kind === "code" ? "w-[640px] max-w-[90vw]" : "w-[440px]"
        }`}
      >
        <h2 className="text-sm font-semibold text-on-surface mb-1">Workflow input</h2>
        <p id={messageId} className="text-sm text-on-surface-secondary whitespace-pre-wrap mb-4">
          {spec.message}
        </p>

        {kind === "boolean" ? (
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => answer(null)}
              className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-on-surface-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => answer(false)}
              className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-on-surface-secondary"
            >
              No
            </button>
            <button
              type="button"
              onClick={() => answer(true)}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white"
            >
              Yes
            </button>
          </div>
        ) : (
          <>
            {kind === "code" ? (
              <textarea
                ref={(el) => {
                  inputRef.current = el;
                }}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-labelledby={messageId}
                spellCheck={false}
                onKeyDown={(e) => {
                  // ⌘/Ctrl+Enter submits; plain Enter inserts a newline.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitText();
                    return;
                  }
                  // Tab inserts two spaces instead of moving focus.
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const el = e.currentTarget;
                    const { selectionStart: s, selectionEnd: en } = el;
                    const next = text.slice(0, s) + "  " + text.slice(en);
                    setText(next);
                    requestAnimationFrame(() => {
                      el.selectionStart = el.selectionEnd = s + 2;
                    });
                  }
                }}
                className="w-full h-64 bg-surface-overlay border border-border-strong rounded px-2 py-1.5 text-xs font-mono text-on-surface placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500 mb-2 resize-y"
              />
            ) : kind === "select" ? (
              <select
                ref={(el) => {
                  inputRef.current = el;
                }}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-labelledby={messageId}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitText();
                }}
                className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 mb-4"
              >
                {(spec.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                ref={(el) => {
                  inputRef.current = el;
                }}
                type={kind === "password" ? "password" : kind === "number" ? "number" : "text"}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-labelledby={messageId}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitText();
                }}
                className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1.5 text-sm text-on-surface placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500 mb-4"
              />
            )}
            <div className="flex items-center justify-end gap-2">
              {kind === "code" && (
                <span className="mr-auto text-[11px] text-on-surface-faint">
                  <kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>↵</kbd> to submit
                </span>
              )}
              <button
                type="button"
                onClick={() => answer(null)}
                className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-on-surface-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitText}
                className="text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white"
              >
                Submit
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
