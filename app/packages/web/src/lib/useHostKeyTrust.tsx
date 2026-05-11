import { useCallback, useRef, useState } from "react";
import { HostKeyTrustDialog } from "@/components/HostKeyTrustDialog";
import { type HostKeyTrustPayload } from "@/lib/host-key-trust";
import { HostKeyTrustRequiredClientError } from "@/lib/api";

interface PendingPrompt {
  payload: HostKeyTrustPayload;
  resolve: (didTrust: boolean) => void;
}

interface UseHostKeyTrust {
  /**
   * If `responseOrPayload` is a host-key-trust 409 (or a `Response` whose
   * body matches that shape), prompt the user, await their decision, and
   * return whether they accepted. If they accepted, the helper has already
   * called the trust endpoint; the caller is responsible for retrying the
   * original action.
   *
   * Returns `false` if the response is not a host-key-trust 409 (the
   * caller should handle the error normally) or if the user cancelled.
   */
  promptIfNeeded: (payload: HostKeyTrustPayload) => Promise<boolean>;
  /**
   * Wrap an async action so that if it throws a `HostKeyTrustRequiredClientError`,
   * the dialog is shown and the action is retried once on accept. Other
   * errors propagate untouched. The action may run up to twice — once
   * normally, and a single retry after the user trusts the key.
   */
  withTrustPrompt: <T>(action: () => Promise<T>) => Promise<T>;
  /** JSX that must be mounted somewhere in the consuming component. */
  dialog: React.ReactNode;
}

/**
 * Centralizes the "prompt to trust a presented SSH host key" flow. A
 * component that makes API calls which may 409 with
 * `ssh_host_key_trust_required` calls `promptIfNeeded(payload)` and, on
 * `true`, retries the original action.
 */
export function useHostKeyTrust(orgId: string): UseHostKeyTrust {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  // Track the latest pending resolver via a ref so dialog callbacks always
  // resolve the right promise, even across re-renders.
  const pendingRef = useRef<PendingPrompt | null>(null);

  const promptIfNeeded = useCallback((payload: HostKeyTrustPayload): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const entry: PendingPrompt = { payload, resolve };
      pendingRef.current = entry;
      setPending(entry);
    });
  }, []);

  const finish = useCallback((didTrust: boolean) => {
    const entry = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    if (entry) entry.resolve(didTrust);
  }, []);

  const withTrustPrompt = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (err instanceof HostKeyTrustRequiredClientError) {
          const accepted = await promptIfNeeded(err.payload);
          if (accepted) return await action();
        }
        throw err;
      }
    },
    [promptIfNeeded],
  );

  const dialog = pending ? (
    <HostKeyTrustDialog
      payload={pending.payload}
      orgId={orgId}
      onAccepted={() => finish(true)}
      onCanceled={() => finish(false)}
    />
  ) : null;

  return { promptIfNeeded, withTrustPrompt, dialog };
}
