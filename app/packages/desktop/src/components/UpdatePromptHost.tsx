import { useEffect, useState } from "react";
import { Modal } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";

interface UpdatePromptPayload {
  version: string;
}

interface UpdateErrorPayload {
  version: string;
  message: string;
}

export function UpdatePromptHost() {
  const [pending, setPending] = useState<UpdatePromptPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UpdateErrorPayload | null>(null);

  useEffect(() => {
    window.electronAPI.on("update_available_prompt", (...args: unknown[]) => {
      const payload = args[0] as UpdatePromptPayload | undefined;
      if (!payload || typeof payload.version !== "string") return;
      setError(null);
      setPending(payload);
    });
    // Main only reports errors once a version is downloaded, so either the user
    // is waiting on a prompt that will never arrive or is sitting in front of
    // one that can't finish. Both cases need the reason on screen.
    window.electronAPI.on("update_error", (...args: unknown[]) => {
      const payload = args[0] as UpdateErrorPayload | undefined;
      if (!payload || typeof payload.message !== "string") return;
      setBusy(false);
      setError(payload);
    });
    return () => {
      window.electronAPI.offAll("update_available_prompt");
      window.electronAPI.offAll("update_error");
    };
  }, []);

  const version = pending?.version ?? error?.version;
  if (!version) return null;

  async function restartNow() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("update_install_now");
    } catch (err) {
      console.error("[updater] failed to trigger install:", err);
      setBusy(false);
      setError({
        version: version ?? "",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function dismiss() {
    setPending(null);
    setError(null);
  }

  const title = error
    ? `Infrawrench ${version} couldn't be installed`
    : `Infrawrench ${version} is ready to install`;

  return (
    <Modal onClose={dismiss} ariaLabel={title}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[460px] p-6">
        <h2 className="text-sm font-semibold text-on-surface">{title}</h2>
        <p className="text-xs text-on-surface-tertiary mt-2">
          {error
            ? error.message
            : "Restart now to apply the update, or it will install the next time you quit Infrawrench."}
        </p>

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={dismiss}
            className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary transition-colors rounded-lg"
          >
            {error ? "Close" : "Later"}
          </button>
          {pending ? (
            <button
              type="button"
              onClick={() => void restartNow()}
              disabled={busy}
              className="px-3 py-1.5 text-xs text-white rounded-lg transition-colors bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600"
            >
              {busy ? "Restarting…" : "Restart now"}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
