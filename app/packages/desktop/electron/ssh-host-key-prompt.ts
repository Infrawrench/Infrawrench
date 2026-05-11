/**
 * Interactive SSH host-key prompt — sends a `ssh_host_key_prompt` event to
 * the renderer and awaits the user's accept/deny decision via the
 * `ssh_host_key_decide` IPC channel.
 *
 * Used by ssh-host-keys.ts when a connection is to an unknown host (first
 * connect) or when the presented fingerprint differs from the stored pin
 * (mismatch).
 */
import * as crypto from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";

export type HostKeyPromptKind = "first-connect" | "mismatch";

export interface HostKeyPromptPayload {
  requestId: string;
  host: string;
  port: number;
  kind: HostKeyPromptKind;
  presentedFingerprint: string;
  /** Set when `kind === "mismatch"`. */
  storedFingerprint?: string;
}

interface Pending {
  resolve: (accept: boolean) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();

/**
 * How long we wait for the user to respond before treating the prompt as
 * denied. Long enough that a user who steps away briefly still gets to make
 * the call, short enough that abandoned prompts don't pin a tunnel open.
 */
const PROMPT_TIMEOUT_MS = 60_000;

ipcMain.handle(
  "ssh_host_key_decide",
  (_e, { requestId, accept }: { requestId: string; accept: boolean }): { ok: true } => {
    const entry = pending.get(requestId);
    if (!entry) return { ok: true };
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.resolve(Boolean(accept));
    return { ok: true };
  },
);

function broadcast(payload: HostKeyPromptPayload): boolean {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length === 0) return false;
  let delivered = false;
  for (const win of wins) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("ssh_host_key_prompt", payload);
      delivered = true;
    }
  }
  return delivered;
}

export function promptHostKeyDecision(input: {
  host: string;
  port: number;
  kind: HostKeyPromptKind;
  presentedFingerprint: string;
  storedFingerprint?: string;
}): Promise<boolean> {
  const requestId = crypto.randomUUID();
  const payload: HostKeyPromptPayload = { ...input, requestId };

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) {
        console.warn(`[ssh] host-key prompt for ${input.host}:${input.port} timed out — denying.`);
        resolve(false);
      }
    }, PROMPT_TIMEOUT_MS);

    pending.set(requestId, { resolve, timer });

    const ok = broadcast(payload);
    if (!ok) {
      // No window to ask. Fail closed so the connection is rejected rather
      // than silently trusting an unknown key.
      clearTimeout(timer);
      pending.delete(requestId);
      console.warn(
        `[ssh] no renderer window available to confirm host key for ${input.host}:${input.port} — denying.`,
      );
      resolve(false);
    }
  });
}
