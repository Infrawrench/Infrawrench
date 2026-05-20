import { useEffect, useState } from "react";
import { Modal } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";

interface UpdatePromptPayload {
  version: string;
}

export function UpdatePromptHost() {
  const [pending, setPending] = useState<UpdatePromptPayload | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.electronAPI.on("update_available_prompt", (...args: unknown[]) => {
      const payload = args[0] as UpdatePromptPayload | undefined;
      if (!payload || typeof payload.version !== "string") return;
      setPending(payload);
    });
    return () => {
      window.electronAPI.offAll("update_available_prompt");
    };
  }, []);

  if (!pending) return null;

  async function restartNow() {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("update_install_now");
    } catch (err) {
      console.error("[updater] failed to trigger install:", err);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={() => setPending(null)}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[460px] p-6">
        <h2 className="text-sm font-semibold text-on-surface">
          Infrawrench {pending.version} is ready to install
        </h2>
        <p className="text-xs text-on-surface-tertiary mt-2">
          Restart now to apply the update, or it will install the next time you quit Infrawrench.
        </p>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={() => setPending(null)}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary transition-colors rounded-lg"
          >
            Later
          </button>
          <button
            onClick={() => void restartNow()}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-white rounded-lg transition-colors bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600"
          >
            Restart now
          </button>
        </div>
      </div>
    </Modal>
  );
}
