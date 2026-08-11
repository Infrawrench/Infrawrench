import { useEffect, useState } from "react";
import type { BlastRadiusReport } from "@infrawrench/client-core";
import { formatErrorMessage } from "../utils.js";
import type { BlastRadiusClient } from "./types.js";

export interface BlastRadiusState {
  report: BlastRadiusReport | null;
  loading: boolean;
  /** Set when the fetch itself failed — distinct from a report with gaps. */
  error: string | null;
}

/**
 * Load one resource's impact report.
 *
 * Deliberately starts in `loading` and resolves later rather than being
 * awaited by whatever renders it: the delete confirmation dialog mounts this
 * and **must open immediately**. Somebody who already knows what they are
 * deleting should never wait on an org-wide graph walk to be allowed to
 * confirm.
 *
 * A failure sets `error` and leaves `report` null. That is a third state, not
 * an empty report — "we could not check" and "nothing depends on it" are the
 * two answers this feature exists to keep apart, and collapsing a failed fetch
 * into a clean result is the one bug that would make it dangerous.
 */
export function useBlastRadius(
  client: BlastRadiusClient | undefined,
  resourceId: string,
): BlastRadiusState {
  const [state, setState] = useState<BlastRadiusState>({
    report: null,
    loading: !!client,
    error: null,
  });

  useEffect(() => {
    if (!client) {
      setState({ report: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ report: null, loading: true, error: null });
    client
      .getBlastRadius(resourceId)
      .then((report) => {
        if (!cancelled) setState({ report, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ report: null, loading: false, error: formatErrorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, resourceId]);

  return state;
}
