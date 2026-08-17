import { useCallback, useEffect, useState } from "react";
import { CarbonSection } from "../carbon/CarbonSection.js";
import type { CarbonEstimate } from "@infrawrench/client-core";
import type { CostsClient } from "./types.js";

/**
 * Fetching wrapper so the shared `CarbonSection` stays a pure renderer, the
 * same split every other section on this panel uses.
 *
 * A failure here is confined to the section: the carbon estimate walks the
 * whole inventory and asks each plugin for a size catalogue, which is the most
 * likely thing on the Costs page to be slow or to fail, and it must not be able
 * to take the spend charts with it.
 */
export function CarbonPanelSection({ client }: { client: CostsClient }) {
  const [data, setData] = useState<CarbonEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!client.getCarbonEstimate) return;
    let cancelled = false;
    setData(null);
    setError(null);
    client
      .getCarbonEstimate()
      .then((estimate) => {
        if (!cancelled) setData(estimate);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [client, reloadKey]);

  return <CarbonSection data={data} error={error} onRetry={retry} />;
}
