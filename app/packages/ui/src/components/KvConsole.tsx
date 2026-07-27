import { useState, useEffect, useRef } from "react";
import { formatRedisResult, kvConsoleProfile, parseKvCommand } from "@infrawrench/client-core";
import { formatErrorMessage } from "../utils.js";

interface ConsoleLine {
  kind: "input" | "output" | "error";
  text: string;
}

export interface KvConsoleProps {
  driverName: string;
  connected?: boolean;
  onCommand: (command: string, args: (string | number)[]) => Promise<unknown>;
}

export function KvConsole({ driverName, connected = true, onCommand }: KvConsoleProps) {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [lines]);

  async function runCommand(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;

    setLines((prev) => [...prev, { kind: "input", text: `> ${trimmed}` }]);
    setHistory((prev) => [trimmed, ...prev.slice(0, 99)]);
    setHistoryIdx(-1);
    setInput("");
    setRunning(true);

    try {
      const { command, args } = parseKvCommand(trimmed);
      const result = await onCommand(command, args);
      const formatted = formatRedisResult(result);
      setLines((prev) => [...prev, { kind: "output", text: formatted }]);
    } catch (e) {
      setLines((prev) => [...prev, { kind: "error", text: formatErrorMessage(e) }]);
    } finally {
      setRunning(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      void runCommand(input);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const idx = historyIdx + 1;
      if (idx < history.length) {
        setHistoryIdx(idx);
        setInput(history[idx] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = historyIdx - 1;
      if (idx < 0) {
        setHistoryIdx(-1);
        setInput("");
      } else {
        setHistoryIdx(idx);
        setInput(history[idx] ?? "");
      }
    }
  }

  const profile = kvConsoleProfile(driverName);

  return (
    <div
      className="shrink-0 border-t border-border bg-surface flex flex-col"
      style={{ height: "220px" }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60">
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${connected ? "bg-blue-400" : "bg-surface-sunken"}`}
        />
        <span className="text-xs text-on-surface-muted font-medium">{profile.label} Console</span>
        {lines.length > 0 && (
          <button
            type="button"
            onClick={() => setLines([])}
            className="ml-auto text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Output */}
      <div
        ref={outputRef}
        className="flex-1 overflow-y-auto px-4 py-2 font-mono text-xs space-y-0.5"
      >
        {lines.length === 0 && (
          <span className="text-on-surface-faint">
            Type a {profile.label} command and press Enter, e.g. {profile.examples}
          </span>
        )}
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.kind === "input"
                ? "text-on-surface-tertiary"
                : line.kind === "error"
                  ? "text-red-400"
                  : "text-green-400"
            }
          >
            {line.text}
          </div>
        ))}
        {running && <div className="text-on-surface-faint animate-pulse">…</div>}
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-4 py-2 border-t border-border/60">
        <span className="text-on-surface-faint font-mono text-xs flex-shrink-0">{">"}</span>
        <input
          ref={inputRef}
          aria-label={`${profile.label} console command`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connected ? profile.placeholder : "connecting…"}
          disabled={!connected || running}
          className="flex-1 bg-transparent font-mono text-xs text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none disabled:opacity-40"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
