import { useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  formatBurn,
  formatCreditAmount,
  formatRunway,
  type CreditBurndown,
  type CreditPot,
  type RunwayUrgency,
} from "@infrawrench/client-core";

import { useDataString } from "../i18n/data-strings.js";
import type { CostsClient } from "./types.js";

const URGENCY_CLASS: Record<RunwayUrgency, string> = {
  critical: "text-danger bg-red-500/10",
  warning: "text-warning bg-amber-500/10",
  ok: "text-on-surface-tertiary bg-surface-overlay",
  unknown: "text-on-surface-tertiary bg-surface-overlay",
};

export interface CreditBurndownSectionProps {
  client: CostsClient;
  /** Opens a URL outside the app shell — the provider's top-up page. */
  onOpenExternal?: (url: string) => void;
}

/**
 * Prepaid credit balances and how long they last at the current burn.
 *
 * Lives on the Costs panel rather than in its own screen because it answers a
 * cost question — but it is not the same question the graphs answer. A
 * provider that bills in arrears sends an invoice you can argue with; a
 * prepaid pot that empties simply stops answering, which makes this an
 * availability number wearing a finance costume.
 *
 * The section renders nothing at all when no account is on a credit-capable
 * plugin. That is the common case, and a permanently empty card teaches people
 * to scroll past this part of the page.
 */
export function CreditBurndownSection({ client, onOpenExternal }: CreditBurndownSectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [feed, setFeed] = useState<CreditBurndown | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getCredits = client.getCreditBurndown;
    if (!getCredits) return;
    let cancelled = false;
    // Awaited inside try/catch rather than chained: a host implementation may
    // throw *synchronously* (desktop's requires cloud mode), and a synchronous
    // throw escapes a promise chain entirely — see CostAnomaliesSection.
    void (async () => {
      try {
        const result = await getCredits();
        if (!cancelled) {
          setFeed(result);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!client.getCreditBurndown) return null;
  // Nothing tracked and nothing broken: the org has no prepaid providers, and
  // an empty card would be pure furniture.
  if (!error && feed && feed.pots.length === 0 && feed.failures.length === 0) return null;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-on-surface-secondary">{gt("Credit burndown")}</h2>
        <T>
          <p className="text-xs text-on-surface-muted mt-1">
            Prepaid balances and how long they last at the burn measured over the last{" "}
            <Var>{feed?.burnWindowDays ?? 30}</Var> days. Running a prepaid pot to zero is an
            outage, not an invoice.
          </p>
        </T>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {feed && feed.pots.length > 0 && (
        <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
          {feed.pots.map((pot) => (
            <PotRow
              key={`${pot.accountId}:${pot.potKey}`}
              pot={pot}
              {...(onOpenExternal ? { onOpenExternal } : {})}
            />
          ))}
        </ul>
      )}

      {feed?.failures.map((failure) => (
        <p key={failure.accountId} className="text-xs text-warning">
          {failure.accountName}: {failure.error}
          {failure.helpUrl && failure.helpLabel && (
            <>
              {" "}
              <button
                type="button"
                className="underline"
                onClick={() => onOpenExternal?.(failure.helpUrl!)}
              >
                {gtData(failure.helpLabel)}
              </button>
            </>
          )}
        </p>
      ))}
    </section>
  );
}

function PotRow({
  pot,
  onOpenExternal,
}: {
  pot: CreditPot;
  onOpenExternal?: (url: string) => void;
}) {
  const gt = useGT();
  return (
    <li className="p-3 flex items-center gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-on-surface-secondary">
          <span className="font-medium">{pot.accountName}</span>{" "}
          <span className="text-on-surface-muted">· {pot.label}</span>
        </p>
        <p className="text-xs text-on-surface-muted mt-0.5">
          {formatCreditAmount(pot.remaining, pot.currency)}
          {pot.granted !== null && pot.granted > 0 && (
            <T>
              <> of <Var>{formatCreditAmount(pot.granted, pot.currency)}</Var></>
            </T>
          )}{" "}
          · {formatBurn(pot)}
          {pot.topUps > 0 && (
            // Said out loud because a top-up inside the window is the thing
            // that makes a naive burn calculation lie, and a reader comparing
            // this to their own arithmetic deserves to know one happened.
            <T>
              <>
                {" "}
                · <Var>{pot.topUps}</Var> top-up<Var>{pot.topUps === 1 ? "" : "s"}</Var> in the
                window
              </>
            </T>
          )}
        </p>
        {pot.limitedByExpiry && (
          <p className="text-xs text-warning mt-0.5">
            {gt("Limited by the credit’s own expiry, not the burn rate.")}
          </p>
        )}
      </div>

      <span
        className={`text-xs px-2 py-0.5 rounded-md whitespace-nowrap ${URGENCY_CLASS[pot.urgency]}`}
      >
        {formatRunway(pot)}
      </span>

      {pot.topUpUrl && onOpenExternal && (
        <button
          type="button"
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay text-on-surface-secondary rounded-lg transition-colors"
          onClick={() => onOpenExternal(pot.topUpUrl!)}
        >
          {gt("Add credit")}
        </button>
      )}
    </li>
  );
}
