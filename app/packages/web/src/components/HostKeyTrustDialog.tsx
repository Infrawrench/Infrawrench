import { useState } from "react";
import { Modal, formatErrorMessage } from "@infrawrench/ui";
import { trustHostKey, type HostKeyTrustPayload } from "@/lib/host-key-trust";

interface HostKeyTrustDialogProps {
  payload: HostKeyTrustPayload;
  orgId: string;
  /** Called after POST /trust succeeds. Caller should retry the original action. */
  onAccepted: () => void;
  /** Called if the user dismisses or hits Cancel. */
  onCanceled: () => void;
}

/**
 * Modal shown when an SSH/SFTP/tunnel route returns 409
 * `ssh_host_key_trust_required`. Displays the presented fingerprint (plus
 * the previously stored one if the host key changed), and on confirm POSTs
 * to /ssh-host-keys/trust before signalling the caller to retry.
 */
export function HostKeyTrustDialog({
  payload,
  orgId,
  onAccepted,
  onCanceled,
}: HostKeyTrustDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<HostKeyTrustPayload>(payload);

  const isMismatch = current.kind === "mismatch";
  const hostLabel = current.port === 22 ? current.host : `${current.host}:${current.port}`;

  async function onConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      await trustHostKey(orgId, current);
      onAccepted();
    } catch (e) {
      // If a race produced a new presented fingerprint, swap into the
      // dialog and let the user accept the new value.
      const racePayload = (e as Error & { trustPayload?: HostKeyTrustPayload }).trustPayload;
      if (racePayload) {
        setCurrent(racePayload);
        setError(formatErrorMessage(e));
      } else {
        setError(formatErrorMessage(e));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal onClose={submitting ? () => {} : onCanceled}>
      <div className="bg-surface-raised border border-border-strong rounded-2xl shadow-2xl w-[520px] max-h-[90vh] overflow-auto">
        <div
          className={`p-6 border-b ${
            isMismatch ? "border-red-500/40 bg-red-500/5" : "border-border"
          }`}
        >
          <h2
            className={`text-base font-semibold ${isMismatch ? "text-red-400" : "text-on-surface"}`}
          >
            {isMismatch ? "Host key has changed!" : "Verify SSH host key"}
          </h2>
          <p className="text-xs text-on-surface-muted mt-1">
            Host: <span className="text-on-surface-secondary font-mono">{hostLabel}</span>
          </p>
        </div>

        <div className="p-6 space-y-4">
          {isMismatch ? (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-2">
              <p className="text-xs text-red-300 font-medium">
                The fingerprint of this host's SSH key does not match the one you previously
                trusted.
              </p>
              <p className="text-xs text-red-300/80">
                This can happen if the server was rebuilt or its key was rotated, but it can also
                indicate a man-in-the-middle attack. Only continue if you are certain the new key is
                legitimate (for example, you rotated it yourself or it matches the fingerprint your
                provider published).
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-border-strong bg-surface-overlay/50 p-3">
              <p className="text-xs text-on-surface-tertiary">
                You haven't connected to this host before. Confirm that the fingerprint below
                matches what you expect (for example, the value printed by your cloud provider or
                shown when you ran
                <span className="font-mono"> ssh-keygen -lf </span>
                on the host).
              </p>
            </div>
          )}

          {current.storedFingerprint && (
            <FingerprintRow
              label="Previously trusted"
              value={current.storedFingerprint}
              tone="muted"
            />
          )}
          <FingerprintRow
            label={current.storedFingerprint ? "Now presented" : "Presented fingerprint"}
            value={current.presentedFingerprint}
            tone={isMismatch ? "danger" : "neutral"}
          />

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-border flex justify-end gap-3">
          <button
            type="button"
            onClick={onCanceled}
            disabled={submitting}
            className="px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={submitting}
            className={`px-4 py-2 text-sm text-white rounded-lg transition-colors disabled:opacity-50 ${
              isMismatch ? "bg-red-600 hover:bg-red-500" : "bg-blue-600 hover:bg-blue-500"
            }`}
          >
            {submitting
              ? "Trusting..."
              : isMismatch
                ? "Replace key and continue"
                : "Trust this key and continue"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FingerprintRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "danger" | "muted";
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const valueClass =
    tone === "danger"
      ? "text-red-300"
      : tone === "muted"
        ? "text-on-surface-muted"
        : "text-on-surface-secondary";

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-on-surface-muted">{label}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div
        className={`bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 font-mono text-xs break-all ${valueClass}`}
      >
        {value}
      </div>
    </div>
  );
}
