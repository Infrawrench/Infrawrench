import { useEffect, useState } from "react";
import { Modal } from "@infrawrench/ui";
import type { HostKeyPromptPayload } from "@infrawrench/plugin-base";
import { invoke } from "../lib/invoke";

/**
 * Mount once at the root. Listens for `ssh_host_key_prompt` events from the
 * main process and shows a modal for each, letting the user accept or deny
 * the connection. Multiple prompts queue up — we show one at a time.
 */
export function SshHostKeyPromptHost() {
  const [queue, setQueue] = useState<HostKeyPromptPayload[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.electronAPI.on("ssh_host_key_prompt", (...args: unknown[]) => {
      const payload = args[0] as HostKeyPromptPayload | undefined;
      if (!payload || !payload.requestId) return;
      setQueue((prev) => [...prev, payload]);
    });
    return () => {
      window.electronAPI.offAll("ssh_host_key_prompt");
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  async function decide(accept: boolean) {
    if (!current || busy) return;
    setBusy(true);
    try {
      await invoke("ssh_host_key_decide", { requestId: current.requestId, accept });
    } catch (err) {
      console.error("[ssh-host-key-prompt] failed to send decision:", err);
    } finally {
      setQueue((prev) => prev.slice(1));
      setBusy(false);
    }
  }

  const isMismatch = current.kind === "mismatch";

  return (
    <Modal onClose={() => void decide(false)}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[520px] p-6">
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
              isMismatch ? "bg-red-500" : "bg-amber-400"
            }`}
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-on-surface">
              {isMismatch ? "SSH host key changed" : "Unknown SSH host"}
            </h2>
            <p className="text-xs text-on-surface-tertiary mt-1">
              {isMismatch
                ? `The host key for ${current.host}:${current.port} does not match the one previously pinned. ` +
                  "This could mean the server was rebuilt — or someone is intercepting the connection. " +
                  "Only accept if you expected the change."
                : `You're connecting to ${current.host}:${current.port} for the first time. ` +
                  "Confirm the fingerprint with the server admin before accepting."}
            </p>
          </div>
        </div>

        <div className="space-y-2 text-xs font-mono">
          <FingerprintRow label="Presented" value={current.presentedFingerprint} />
          {isMismatch && current.storedFingerprint && (
            <FingerprintRow label="Previously pinned" value={current.storedFingerprint} muted />
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={() => void decide(false)}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary transition-colors rounded-lg"
          >
            Deny
          </button>
          <button
            onClick={() => void decide(true)}
            disabled={busy}
            className={`px-3 py-1.5 text-xs text-white rounded-lg transition-colors disabled:opacity-40 ${
              isMismatch
                ? "bg-red-600 hover:bg-red-500 disabled:hover:bg-red-600"
                : "bg-emerald-600 hover:bg-emerald-500 disabled:hover:bg-emerald-600"
            }`}
          >
            {isMismatch ? "Replace pin and connect" : "Pin and connect"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FingerprintRow({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`text-[10px] uppercase tracking-wider w-24 flex-shrink-0 ${
          muted ? "text-on-surface-faint" : "text-on-surface-tertiary"
        }`}
      >
        {label}
      </span>
      <span
        className={`flex-1 px-2 py-1 rounded bg-surface-overlay border border-border break-all select-all ${
          muted ? "text-on-surface-tertiary" : "text-on-surface"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
