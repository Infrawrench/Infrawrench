import { useState } from "react";
import { formatErrorMessage } from "../utils.js";

interface DockerActionsPanelProps {
  containerId: string;
  onCommand: (
    op: "startContainer" | "stopContainer" | "restartContainer",
    params: { id: string },
  ) => Promise<unknown>;
}

type ActionState = "idle" | "running" | "success" | "error";

export function DockerActionsPanel({ containerId, onCommand }: DockerActionsPanelProps) {
  const [state, setState] = useState<ActionState>("idle");
  const [lastOp, setLastOp] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  async function run(op: "startContainer" | "stopContainer" | "restartContainer", label: string) {
    setState("running");
    setLastOp(label);
    setError(null);
    try {
      await onCommand(op, { id: containerId });
      setState("success");
      setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setState("error");
      setError(formatErrorMessage(e));
    }
  }

  return (
    <div className="border-t border-border px-6 py-4">
      <h3 className="text-xs font-medium text-on-surface-muted uppercase tracking-wide mb-3">
        Container Actions
      </h3>
      <div className="flex gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => void run("startContainer", "Start")}
          disabled={state === "running"}
          className="px-3 py-1.5 text-xs bg-green-600/20 hover:bg-green-600/30 border border-green-400 dark:border-green-600/40 text-success rounded-lg transition-colors disabled:opacity-50"
        >
          Start
        </button>
        <button
          type="button"
          onClick={() => void run("stopContainer", "Stop")}
          disabled={state === "running"}
          className="px-3 py-1.5 text-xs bg-yellow-600/20 hover:bg-yellow-600/30 border border-yellow-600/40 text-warning rounded-lg transition-colors disabled:opacity-50"
        >
          Stop
        </button>
        <button
          type="button"
          onClick={() => void run("restartContainer", "Restart")}
          disabled={state === "running"}
          className="px-3 py-1.5 text-xs bg-accent-muted hover:bg-accent-muted border border-accent-muted-border text-accent rounded-lg transition-colors disabled:opacity-50"
        >
          Restart
        </button>
      </div>

      {state === "running" && <p className="text-xs text-on-surface-muted mt-2">{lastOp}…</p>}
      {state === "success" && <p className="text-xs text-success mt-2">{lastOp} succeeded</p>}
      {state === "error" && error && <p className="text-xs text-danger mt-2">{error}</p>}
    </div>
  );
}
