/**
 * The countdown an unclaimed trial workspace carries on every screen.
 *
 * Deliberately not dismissible. A dismissible banner is the right pattern for
 * something the reader can act on later; this one is counting down to the
 * deletion of everything they are looking at, and the failure mode of getting
 * it wrong is silent and total. It stops appearing when the workspace is
 * claimed, which is the only "dismiss" that means anything.
 */
import { useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";

export interface TrialBannerProps {
  /** Milliseconds until deletion. Null or undefined for a normal org. */
  expiresInMs: number | null | undefined;
  /** Where the claim page lives, so the host owns routing. */
  onClaim?: () => void;
}

function formatRemaining(gt: ReturnType<typeof useGT>, ms: number): string {
  if (ms <= 0) return gt("any moment now");
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours >= 1) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes >= 1) return gt("{n} minutes", { n: minutes });
  return gt("less than a minute");
}

export function TrialBanner({ expiresInMs, onClaim }: TrialBannerProps) {
  const gt = useGT();
  // Ticks locally rather than re-fetching: the deadline is fixed, so the only
  // thing that changes is the clock, and polling the server once a minute to be
  // told the same date would be a request per user per minute for nothing.
  const [remaining, setRemaining] = useState(expiresInMs ?? null);

  useEffect(() => {
    setRemaining(expiresInMs ?? null);
    if (expiresInMs === null || expiresInMs === undefined) return;
    const started = Date.now();
    const timer = setInterval(() => {
      setRemaining(Math.max(0, expiresInMs - (Date.now() - started)));
    }, 30_000);
    return () => clearInterval(timer);
  }, [expiresInMs]);

  if (remaining === null || remaining === undefined) return null;

  const urgent = remaining < 2 * 3_600_000;

  return (
    <div
      role="status"
      className={`flex items-center justify-between gap-4 px-4 py-2 text-sm border-b ${
        urgent
          ? "bg-danger/10 border-danger/30 text-danger"
          : "bg-warning/10 border-warning/30 text-warning"
      }`}
    >
      <T>
        <span>
          <strong className="font-medium">Trial workspace.</strong> Everything here is deleted in{" "}
          <Var>{formatRemaining(gt, remaining)}</Var> unless someone claims it.
        </span>
      </T>
      {onClaim && (
        <button
          type="button"
          onClick={onClaim}
          className="shrink-0 px-3 py-1 rounded-md font-medium bg-current/10 hover:bg-current/20 transition-colors"
        >
          {gt("Claim this workspace")}
        </button>
      )}
    </div>
  );
}
