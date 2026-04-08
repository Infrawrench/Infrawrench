"use client";

import { useState } from "react";
import { dockerCommand } from "@/actions/connection-features";
import { formatErrorMessage } from "@/lib/errors";

interface DockerActionsPanelProps {
  accountId: string;
  containerId: string;
}

type ActionState = "idle" | "running" | "success" | "error";

export function DockerActionsPanel({ accountId, containerId }: DockerActionsPanelProps) {
  const [state, setState] = useState<ActionState>("idle");
  const [lastOp, setLastOp] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  async function run(op: "startContainer" | "stopContainer" | "restartContainer", label: string) {
    setState("running");
    setLastOp(label);
    setError(null);
    try {
      await dockerCommand({ accountId, op, params: { id: containerId } });
      setState("success");
      setTimeout(() => setState("idle"), 2000);
    } catch (e) {
      setState("error");
      setError(formatErrorMessage(e));
    }
  }

  return (
    <div className="border-t border-gray-800 px-6 py-4">
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">Container Actions</h3>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => void run("startContainer", "Start")}
          disabled={state === "running"}
          className="px-3 py-1.5 text-xs bg-green-600/20 hover:bg-green-600/30 border border-green-600/40 text-green-400 rounded-lg transition-colors disabled:opacity-50"
        >
          Start
        </button>
        <button
          onClick={() => void run("stopContainer", "Stop")}
          disabled={state === "running"}
          className="px-3 py-1.5 text-xs bg-yellow-600/20 hover:bg-yellow-600/30 border border-yellow-600/40 text-yellow-400 rounded-lg transition-colors disabled:opacity-50"
        >
          Stop
        </button>
        <button
          onClick={() => void run("restartContainer", "Restart")}
          disabled={state === "running"}
          className="px-3 py-1.5 text-xs bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/40 text-blue-400 rounded-lg transition-colors disabled:opacity-50"
        >
          Restart
        </button>
      </div>

      {state === "running" && (
        <p className="text-xs text-gray-500 mt-2">{lastOp}…</p>
      )}
      {state === "success" && (
        <p className="text-xs text-green-400 mt-2">{lastOp} succeeded</p>
      )}
      {state === "error" && error && (
        <p className="text-xs text-red-400 mt-2">{error}</p>
      )}
    </div>
  );
}
