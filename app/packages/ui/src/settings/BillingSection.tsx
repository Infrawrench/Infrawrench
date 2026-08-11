import { useState, useEffect } from "react";
import type { BillingStatus, CapacitySlot } from "../api-types.js";
import { useSettingsHost } from "./host.js";

/**
 * Largest quantity one purchase accepts. Mirrors `MAX_SLOTS_PER_PURCHASE` in
 * `web/src/api/routes/billing.ts`, which is the enforcing copy — this one only
 * keeps the input from offering a quantity the server would reject.
 */
const MAX_SLOTS_PER_PURCHASE = 25;

/** "24 months" reads worse than "2 years" for the terms we actually sell. */
function formatTerm(months: number): string {
  if (months % 12 !== 0) return `${months} months`;
  const years = months / 12;
  return `${years} year${years !== 1 ? "s" : ""}`;
}

/** Whether a purchase still grants seats: not refunded, not past its term. */
function slotIsLive(slot: CapacitySlot): boolean {
  return slot.status === "active" && new Date(slot.expiresAt).getTime() > Date.now();
}

function slotLabel(slot: CapacitySlot): string {
  if (slot.status === "refunded") return "Refunded";
  return slotIsLive(slot) ? "Active" : "Expired";
}

export function BillingSection() {
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
      setError(e instanceof Error ? e.message : "Failed to start checkout");
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
      setError(e instanceof Error ? e.message : "Failed to open billing portal");
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
      setError(e instanceof Error ? e.message : "Failed to start checkout");
      setLoading(false);
    }
  }

  if (status === undefined) {
    return <p className="text-sm text-on-surface-faint">Loading…</p>;
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
      ? `${monthlySeats} monthly seat${monthlySeats !== 1 ? "s" : ""} at $20 each`
      : null,
    prepaidSeats > 0 ? `${prepaidSeats} prepaid seat${prepaidSeats !== 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" + ");

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Billing</h1>

      <div className="border border-border rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-medium text-on-surface-secondary">
              {complimentary ? "Complimentary Plan" : isFree ? "Free Plan" : "Pro Plan"}
            </h2>
            <p className="text-xs text-on-surface-muted mt-1">
              {complimentary
                ? "All Pro features included, on the house — this organization is never billed"
                : isFree
                  ? "1 user, 3 accounts, no audit trail"
                  : `${totalSeats} seat${totalSeats !== 1 ? "s" : ""} — ${seatSummary}`}
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
              ? "Complimentary"
              : isActive
                ? "Active"
                : isTrial
                  ? "Trial"
                  : sub?.status === "past_due"
                    ? "Past due"
                    : prepaidSeats > 0
                      ? "Prepaid"
                      : "Free"}
          </span>
        </div>

        {!complimentary && sub?.currentPeriodEnd && subscriptionPaid && (
          <p className="text-xs text-on-surface-muted">
            Current period ends: {new Date(sub.currentPeriodEnd).toLocaleDateString()}
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
                ? "Redirecting..."
                : isFree
                  ? "Upgrade to Pro - $20/seat/month"
                  : "Add monthly seats - $20/seat/month"}
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
                ? "Redirecting..."
                : subscriptionPaid
                  ? "Manage subscription"
                  : "Invoices & payment methods"}
            </button>
          )}
        </div>
      )}

      {!complimentary && (capacity.purchasable || capacity.slots.length > 0) && (
        <div className="mt-8 border border-border rounded-xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-medium text-on-surface-secondary">Prepaid capacity</h3>
            <span className="text-xs text-on-surface-muted">
              {prepaidSeats} seat{prepaidSeats !== 1 ? "s" : ""} active
            </span>
          </div>
          <p className="text-xs text-on-surface-muted mb-4">
            A capacity slot is one seat bought outright for {formatTerm(capacity.termMonths)} — $
            {capacity.priceUsd} once, then nothing monthly for that seat. Slots add to any monthly
            seats you have, and stop counting when their term ends.
          </p>

          {capacity.purchasable && (
            <div className="flex items-end gap-3 mb-5">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-on-surface-muted">Slots</span>
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
                  ? "Redirecting..."
                  : `Buy for $${capacity.priceUsd * slotQuantity} — ${formatTerm(capacity.termMonths)}`}
              </button>
            </div>
          )}

          {capacity.slots.length > 0 && (
            <ul className="divide-y divide-border border-t border-border">
              {capacity.slots.map((slot) => (
                <li key={slot.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div>
                    <span className="text-on-surface-secondary">
                      {slot.quantity} seat{slot.quantity !== 1 ? "s" : ""}
                    </span>
                    <span className="text-xs text-on-surface-muted ml-2">
                      bought {new Date(slot.startsAt).toLocaleDateString()}
                      {slot.amountPaidCents != null &&
                        ` for $${(slot.amountPaidCents / 100).toFixed(2)}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-on-surface-muted">
                      {slotIsLive(slot) ? "expires" : "expired"}{" "}
                      {new Date(slot.expiresAt).toLocaleDateString()}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-1 rounded-full ${
                        slotIsLive(slot)
                          ? "bg-green-500/10 text-success"
                          : "bg-surface-overlay text-on-surface-tertiary"
                      }`}
                    >
                      {slotLabel(slot)}
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
          <h3 className="text-sm font-medium text-on-surface-secondary mb-3">Pro plan includes:</h3>
          <ul className="space-y-2 text-sm text-on-surface-tertiary">
            <li>Unlimited team members</li>
            <li>Unlimited cloud accounts</li>
            <li>Full audit trail</li>
            <li>API key management</li>
            <li>Desktop cloud sync</li>
            <li>Team management &amp; invitations</li>
          </ul>
        </div>
      )}
    </div>
  );
}
