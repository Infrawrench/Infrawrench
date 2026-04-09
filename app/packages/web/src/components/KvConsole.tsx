import { useState, useEffect, useRef } from "react";
import { apiPost } from "@/lib/api";
import { formatErrorMessage } from "@/lib/errors";

interface ConsoleLine {
  kind: "input" | "output" | "error";
  text: string;
}

export function KvConsole({ accountId, driverName }: { accountId: string; driverName: string }) {
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
      const tokens = tokenize(trimmed);
      const [cmd, ...args] = tokens;
      const { result } = await apiPost<{ result: unknown }>("/api/kv/command", {
        accountId,
        command: cmd ?? "",
        args: args.map((a) => (isNaN(Number(a)) ? a : Number(a))),
      });
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

  return (
    <div className="shrink-0 border-t border-gray-800 bg-gray-950 flex flex-col" style={{ height: "220px" }}>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/60">
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-blue-400" />
        <span className="text-xs text-gray-500 font-medium">
          {driverName === "memcached" ? "Memcached" : driverName === "mongodb" ? "MongoDB" : "Redis"} Console
        </span>
        {lines.length > 0 && (
          <button
            onClick={() => setLines([])}
            className="ml-auto text-xs text-gray-700 hover:text-gray-400 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      <div ref={outputRef} className="flex-1 overflow-y-auto px-4 py-2 font-mono text-xs space-y-0.5">
        {lines.length === 0 && (
          <span className="text-gray-700">
            Type a {driverName === "memcached" ? "Memcached" : "Redis"} command and press Enter — e.g. PING, KEYS *, GET mykey
          </span>
        )}
        {lines.map((line, i) => (
          <div
            key={i}
            className={
              line.kind === "input"
                ? "text-gray-400"
                : line.kind === "error"
                  ? "text-red-400"
                  : "text-green-400"
            }
          >
            {line.text}
          </div>
        ))}
        {running && <div className="text-gray-600 animate-pulse">…</div>}
      </div>

      <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-800/60">
        <span className="text-gray-700 font-mono text-xs flex-shrink-0">{">"}</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={driverName === "memcached" ? "STATS" : "PING"}
          disabled={running}
          className="flex-1 bg-transparent font-mono text-xs text-gray-200 placeholder-gray-700 focus:outline-none disabled:opacity-40"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of cmd) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " ") {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function formatRedisResult(value: unknown): string {
  if (value === null) return "(nil)";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((v, i) => `${i + 1}) ${formatRedisResult(v)}`)
      .join("\n");
  }
  return JSON.stringify(value);
}
