import { useCallback, useEffect, useState } from "react";
import {
  WALLBOARD_LIMITS,
  WallboardSection,
  clampWallboardSeconds,
  type WallboardResponse,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

interface WebWallboardPanelProps {
  orgId: string;
  /** From the URL, so a television can be pointed at a bookmark. */
  refreshSeconds?: number | undefined;
  rotateSeconds?: number | undefined;
}

/**
 * Web host for the wallboard.
 *
 * A failed poll deliberately does **not** clear the last reading: a television
 * that blanks on one bad request is worse than one showing a minute-old wall
 * with the section's own stale marker on it. The section decides when a reading
 * has aged out of usefulness.
 */
export function WebWallboardPanel({
  orgId,
  refreshSeconds,
  rotateSeconds,
}: WebWallboardPanelProps) {
  const [data, setData] = useState<WallboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const refresh = clampWallboardSeconds(refreshSeconds, {
    min: WALLBOARD_LIMITS.minRefreshSeconds,
    max: WALLBOARD_LIMITS.maxRefreshSeconds,
    fallback: WALLBOARD_LIMITS.defaultRefreshSeconds,
  });
  const rotate = clampWallboardSeconds(rotateSeconds, {
    min: WALLBOARD_LIMITS.minRotateSeconds,
    max: WALLBOARD_LIMITS.maxRotateSeconds,
    fallback: WALLBOARD_LIMITS.defaultRotateSeconds,
  });

  const togglePaused = useCallback(() => setPaused((value) => !value), []);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    function load() {
      apiGet<WallboardResponse>(`/api/org/${orgId}/wallboard`)
        .then((response) => {
          if (cancelled) return;
          setData(response);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          // The reading is left in place on purpose; see the component note.
          setError(e instanceof Error ? e.message : "Could not reach Infrawrench");
        });
    }
    load();
    const timer = setInterval(load, refresh * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orgId, refresh]);

  return (
    <WallboardSection
      data={data}
      error={error}
      refreshSeconds={refresh}
      rotateSeconds={rotate}
      paused={paused}
      onTogglePaused={togglePaused}
    />
  );
}
