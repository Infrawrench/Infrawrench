import { useState, useEffect } from "react";
import { useGT } from "gt-react";
import type { BillingStatus, CapacitySlot } from "../api-types.js";
import { useSettingsHost } from "./host.js";

/**
 * Largest quantity one purchase accepts. Mirrors `MAX_SLOTS_PER_PURCHASE` in
 * `web/src/api/routes/billing.ts`, which is the enforcing copy — this one only
 * keeps the input from offering a quantity the server would reject.
 */
const MAX_SLOTS_PER_PURCHASE = 25;

/** "24 months" reads worse than "2 years" for the terms we actually sell. */
function formatTerm(months: number, gt: ReturnType<typeof useGT>): string {
  if (months % 12 !== 0) return gt("{months} months", { months });
  const years = months / 12;
  return gt("{years} year{plural}", { years, plural: years !== 1 ? "s" : "" });
}

/** Whether a purchase still grants seats: not refunded, not past its term. */
function slotIsLive(slot: CapacitySlot): boolean {
  return slot.status === "active" && new Date(slot.expiresAt).getTime() > Date.now();
}

function slotLabel(slot: CapacitySlot, gt: ReturnType<typeof useGT>): string {
  if (slot.status === "refunded") return gt("Refunded");
  return slotIsLive(slot) ? gt("Active") : gt("Expired");
}

export function BillingSection() {
  const gt = useGT();
  const { orgId, api, openExternal } = useSettingsHost();
  const [status, setStatus] = useState<BillingStatus | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slotQuantity, setSlotQuantity] = useState(1);

  useEffect(() => {
    api.get<BillingStatus>(`/api/org/${orgId}/billing/status`).then(setStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleUpgrade() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(`/api/org/${orgId}/billing/checkout`);
      openExternal(url, { sameTab: true });
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to start checkout"));
      setLoading(false);
    }
  }

  async function handleManage() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(`/api/org/${orgId}/billing/portal`);
      openExternal(url, { sameTab: true });
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to open billing portal"));
      setLoading(false);
    }
  }

  async function handleBuyCapacity() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(
        `/api/org/${orgId}/billing/capacity/checkout`,
        { quantity: slotQuantity },
      );
      openExternal(url, { sameTab: true });
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to start checkout"));
      setLoading(false);
    }
  }

  if (status === undefined) {
    return <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>;
  }

  const sub = status.subscription;
  const complimentary = status.complimentary;
  const capacity = status.capacity;
  const prepaidSeats = capacity.seats;
  const isActive = sub?.status === "active";
  // "trialing" with no billing period is the placeholder row from a checkout
  // that was never completed — that org is on the free plan. A trial Stripe
  // itself reported (the webhooks set the period) is a paid plan mid-trial.
  const isTrial = sub?.status === "trialing" && sub.currentPeriodEnd != null;
  const subscriptionPaid = !!sub && (isActive || isTrial || sub.status === "past_due");
  // Prepaid capacity is a paid plan on its own — an org can hold slots with no
  // subscription at all, and calling that "Free" would contradict both the
  // server's entitlement check and the invoice the org is holding.
  const isFree = !complimentary && !subscriptionPaid && prepaidSeats === 0;
  const monthlySeats = subscriptionPaid ? (sub?.seatCount ?? 0) : 0;
  const totalSeats = monthlySeats + prepaidSeats;

  const seatSummary = [
    monthlySeats > 0
      ? gt("{count} monthly seat{plural} at $20 each", {
          count: monthlySeats,
          plural: monthlySeats !== 1 ? "s" : "",
        })
      : null,
    prepaidSeats > 0
      ? gt("{count} prepaid seat{plural}", {
          count: prepaidSeats,
          plural: prepaidSeats !== 1 ? "s" : "",
        })
      : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">{gt("Billing")}</h1>

      <div className="border border-border rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-medium text-on-surface-secondary">
              {complimentary ? gt("Complimentary Plan") : isFree ? gt("Free Plan") : gt("Pro Plan")}
            </h2>
            <p className="text-xs text-on-surface-muted mt-1">
              {complimentary
                ? gt("All Pro features included, on the house — this organization is never billed")
                : isFree
                  ? gt("1 user, 3 accounts, no audit trail")
                  : gt("{count} seat{plural} — {summary}", {
                      count: totalSeats,
                      plural: totalSeats !== 1 ? "s" : "",
                      summary: seatSummary,
                    })}
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2 py-1 rounded-full ${
              complimentary
                ? "bg-purple-500/10 text-notice"
                : isActive || isTrial || (!subscriptionPaid && prepaidSeats > 0)
                  ? "bg-green-500/10 text-success"
                  : sub?.status === "past_due"
                    ? "bg-yellow-500/10 text-warning"
                    : "bg-surface-overlay text-on-surface-tertiary"
            }`}
          >
            {complimentary
              ? gt("Complimentary")
              : isActive
                ? gt("Active")
                : isTrial
                  ? gt("Trial")
                  : sub?.status === "past_due"
                    ? gt("Past due")
                    : prepaidSeats > 0
                      ? gt("Prepaid")
                      : gt("Free")}
          </span>
        </div>

        {!complimentary && sub?.currentPeriodEnd && subscriptionPaid && (
          <p className="text-xs text-on-surface-muted">
            {gt("Current period ends: {date}", {
              date: new Date(sub.currentPeriodEnd).toLocaleDateString(),
            })}
          </p>
        )}
      </div>

      {error && <p className="text-sm text-danger mb-3">{error}</p>}

      {!complimentary && (
        <div className="flex gap-3">
          {!subscriptionPaid && (
            <button
              type="button"
              onClick={() => void handleUpgrade()}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {loading
                ? gt("Redirecting...")
                : isFree
                  ? gt("Upgrade to Pro - $20/seat/month")
                  : gt("Add monthly seats - $20/seat/month")}
            </button>
          )}
          {/* The portal is only offered once there is something in it. A free
              org's placeholder row is an abandoned checkout, not a plan. */}
          {(subscriptionPaid || prepaidSeats > 0) && (
            <button
              type="button"
              onClick={() => void handleManage()}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium border border-border-strong text-on-surface-secondary hover:text-on-surface hover:border-border-strong rounded-lg transition-colors"
            >
              {loading
                ? gt("Redirecting...")
                : subscriptionPaid
                  ? gt("Manage subscription")
                  : gt("Invoices & payment methods")}
            </button>
          )}
        </div>
      )}

      {!complimentary && (capacity.purchasable || capacity.slots.length > 0) && (
        <div className="mt-8 border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-medium text-on-surface-secondary">
              {gt("Prepaid capacity")}
            </h3>
            <span className="text-xs text-on-surface-muted">
              {gt("{count} seat{plural} active", {
                count: prepaidSeats,
                plural: prepaidSeats !== 1 ? "s" : "",
              })}
            </span>
          </div>
          <p className="text-xs text-on-surface-muted mb-4">
            {gt(
              "A capacity slot is one seat bought outright for {term} — ${price} once, then nothing monthly for that seat. Slots add to any monthly seats you have, and stop counting when their term ends.",
              { term: formatTerm(capacity.termMonths, gt), price: capacity.priceUsd },
            )}
          </p>

          {capacity.purchasable && (
            <div className="flex items-end gap-3 mb-5">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-on-surface-muted">{gt("Slots")}</span>
                <input
                  type="number"
                  min={1}
                  max={MAX_SLOTS_PER_PURCHASE}
                  value={slotQuantity}
                  onChange={(e) =>
                    setSlotQuantity(
                      Math.min(
                        MAX_SLOTS_PER_PURCHASE,
                        Math.max(1, Math.trunc(Number(e.target.value) || 1)),
                      ),
                    )
                  }
                  className="w-20 px-2 py-1.5 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleBuyCapacity()}
                disabled={loading}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {loading
                  ? gt("Redirecting...")
                  : gt("Buy for ${price} — {term}", {
                      price: capacity.priceUsd * slotQuantity,
                      term: formatTerm(capacity.termMonths, gt),
                    })}
              </button>
            </div>
          )}

          {capacity.slots.length > 0 && (
            <ul className="divide-y divide-border border-t border-border">
              {capacity.slots.map((slot) => (
                <li key={slot.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <span className="text-on-surface-secondary">
                      {gt("{count} seat{plural}", {
                        count: slot.quantity,
                        plural: slot.quantity !== 1 ? "s" : "",
                      })}
                    </span>
                    <span className="text-xs text-on-surface-muted ml-2">
                      {gt("bought {date}", {
                        date: new Date(slot.startsAt).toLocaleDateString(),
                      })}
                      {slot.amountPaidCents != null &&
                        gt(" for ${amount}", {
                          amount: (slot.amountPaidCents / 100).toFixed(2),
                        })}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-on-surface-muted">
                      {slotIsLive(slot)
                        ? gt("expires {date}", {
                            date: new Date(slot.expiresAt).toLocaleDateString(),
                          })
                        : gt("expired {date}", {
                            date: new Date(slot.expiresAt).toLocaleDateString(),
                          })}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-1 rounded-full ${
                        slotIsLive(slot)
                          ? "bg-green-500/10 text-success"
                          : "bg-surface-overlay text-on-surface-tertiary"
                      }`}
                    >
                      {slotLabel(slot, gt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isFree && (
        <div className="mt-8 border border-border rounded-xl p-5">
          <h3 className="text-sm font-medium text-on-surface-secondary mb-3">
            {gt("Pro plan includes:")}
          </h3>
          <ul className="space-y-2 text-sm text-on-surface-tertiary">
            <li>{gt("Unlimited team members")}</li>
            <li>{gt("Unlimited cloud accounts")}</li>
            <li>{gt("Full audit trail")}</li>
            <li>{gt("API key management")}</li>
            <li>{gt("Desktop cloud sync")}</li>
            <li>{gt("Team management & invitations")}</li>
          </ul>
        </div>
      )}
    </div>
  );
}
