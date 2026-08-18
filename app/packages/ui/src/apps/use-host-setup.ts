/**
 * The state machine behind `HostSetupPanel`: check, install, check again.
 *
 * Shared rather than written twice because only the two calls differ between
 * platforms — the desktop reaches the host through IPC, the web app through its
 * server — and everything around them (when to block the session, what happens
 * to the log across a re-check, what "done" means) is the same and is where the
 * subtleties are.
 *
 * `blocked` is the load-bearing one. It is false while the check is in flight,
 * so a host with everything installed pays for one short exec and then connects
 * normally; it goes true only once a check has come back short. That ordering is
 * deliberate: gating the session on a check that has not answered yet would add
 * a round trip to every launcher open, for a prompt almost nobody sees.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  HostPreflight,
  InstallOutcome,
  InstallPlan,
  RequirementId,
} from "@infrawrench/appstream-core";

export interface HostSetupTransport {
  /** Look at the host. Changes nothing. */
  check(): Promise<{ preflight: HostPreflight; plan: InstallPlan | null }>;
  /**
   * Install the named requirements and re-check.
   *
   * `onOutput` is called per line where the platform can stream; a platform
   * that cannot may call it once at the end with everything.
   */
  install(requirements: RequirementId[], onOutput: (line: string) => void): Promise<InstallOutcome>;
}

export interface HostSetupState {
  preflight: HostPreflight | null;
  plan: InstallPlan | null;
  /**
   * The launcher should show the prompt instead of the grid, and the caller
   * should not open a session yet.
   */
  blocked: boolean;
  installing: boolean;
  log: string[];
  error: string | null;
  install: (requirements: RequirementId[]) => Promise<void>;
  recheck: () => void;
  /** Stop blocking and let the session open, whatever the check said. */
  dismiss: () => void;
}

/**
 * Checks when `hostKey` changes, and holds `transport` in a ref.
 *
 * The identity of the transport object deliberately does not trigger anything.
 * Both callers build theirs inline from a config the router rebuilds every
 * render, and keying the check on that object would re-probe the host on every
 * paint — a loop that spends someone else's SSH connections. `hostKey` is the
 * host's identity as the caller understands it (key, login, address), which is
 * the thing a re-check should actually follow.
 *
 * A null `transport` — no key chosen yet, no address resolved — checks nothing.
 */
export function useHostSetup(
  transport: HostSetupTransport | null,
  hostKey: string | null,
): HostSetupState {
  const [preflight, setPreflight] = useState<HostPreflight | null>(null);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [nonce, setNonce] = useState(0);

  const latest = useRef(transport);
  latest.current = transport;

  useEffect(() => {
    // A different host is a different question: whatever the last one said, and
    // whether the user waved it away, does not carry over. Done here rather than
    // in an effect of its own so there is no ordering between two effects
    // writing the same state.
    setDismissed(false);
    setPreflight(null);
    setPlan(null);
    setError(null);

    const active = latest.current;
    if (!active || !hostKey) return;
    let cancelled = false;
    void active.check().then(
      (result) => {
        if (cancelled) return;
        setPreflight(result.preflight);
        setPlan(result.plan);
      },
      (cause: unknown) => {
        // A check that cannot run is not a host that is missing everything —
        // it is usually the SSH connection. Blocking the launcher on it would
        // replace a real error with a misleading checklist, so this is recorded
        // and the session is allowed to go ahead and produce the real message.
        if (cancelled) return;
        setPreflight(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [hostKey, nonce]);

  const recheck = useCallback(() => {
    setError(null);
    setLog([]);
    setNonce((value) => value + 1);
  }, []);

  const install = useCallback(async (requirements: RequirementId[]) => {
    const active = latest.current;
    if (!active) return;
    setInstalling(true);
    setError(null);
    // Cleared rather than appended to: the log belongs to this attempt, and a
    // second attempt's output reading as a continuation of the first is how
    // "did it work?" becomes unanswerable.
    setLog([]);
    try {
      const outcome = await active.install(requirements, (line) =>
        setLog((lines) => [...lines, line]),
      );
      // The outcome carries the whole log too. Trusting it over what streamed
      // means a platform that streams nothing still shows the output, and one
      // that streamed every line shows the same lines rather than doubling.
      if (outcome.log.length) setLog(outcome.log);
      setPreflight(outcome.preflight);
      // A plan is only meaningful against a fresh preflight, and the panel
      // needs one for whatever is still missing.
      const result = await active.check();
      setPreflight(result.preflight);
      setPlan(result.plan);
      if (outcome.failed.length) {
        setError(
          // Named rather than counted: which package a distribution spells
          // differently is the only thing that makes this fixable by hand.
          `Could not install: ${outcome.failed.join(", ")}`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInstalling(false);
    }
  }, []);

  const dismiss = useCallback(() => setDismissed(true), []);

  // A preflight that came back ready stops blocking on its own, so a successful
  // install drops the prompt and the launcher appears without another click.
  const blocked = !dismissed && preflight !== null && !preflight.ready;

  return useMemo(
    () => ({ preflight, plan, blocked, installing, log, error, install, recheck, dismiss }),
    [preflight, plan, blocked, installing, log, error, install, recheck, dismiss],
  );
}
