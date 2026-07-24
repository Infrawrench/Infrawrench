import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { apiGet, apiPost } from "@/lib/api";

interface SubscriptionStatus {
  status: string;
  seatCount: number;
  currentPeriodEnd: string | null;
  stripeCustomerId: string;
}

interface BillingStatus {
  complimentary: boolean;
  subscription: SubscriptionStatus | null;
}

export const Route = createFileRoute("/org/$orgId/settings/billing")({
  component: BillingPage,
});

function BillingPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/billing" });
  const [status, setStatus] = useState<BillingStatus | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<BillingStatus>(`/api/org/${orgId}/billing/status`).then(setStatus);
  }, []);

  async function handleUpgrade() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await apiPost<{ url: string }>(`/api/org/${orgId}/billing/checkout`);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start checkout");
      setLoading(false);
    }
  }

  async function handleManage() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await apiPost<{ url: string }>(`/api/org/${orgId}/billing/portal`);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to open billing portal");
      setLoading(false);
    }
  }

  if (status === undefined) {
    return <p className="text-sm text-on-surface-faint">Loading…</p>;
  }

  const sub = status.subscription;
  const complimentary = status.complimentary;
  const isActive = sub?.status === "active";
  const isFree = !complimentary && (!sub || sub.status === "trialing" || sub.status === "canceled");

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
                  : `${sub?.seatCount ?? 1} seat${(sub?.seatCount ?? 1) !== 1 ? "s" : ""} at $20/month each`}
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2 py-1 rounded-full ${
              complimentary
                ? "bg-purple-500/10 text-purple-400"
                : isActive
                  ? "bg-green-500/10 text-green-400"
                  : sub?.status === "past_due"
                    ? "bg-yellow-500/10 text-yellow-400"
                    : "bg-surface-overlay text-on-surface-tertiary"
            }`}
          >
            {complimentary
              ? "Complimentary"
              : isActive
                ? "Active"
                : sub?.status === "past_due"
                  ? "Past due"
                  : "Free"}
          </span>
        </div>

        {!complimentary && sub?.currentPeriodEnd && (
          <p className="text-xs text-on-surface-muted">
            Current period ends: {new Date(sub.currentPeriodEnd).toLocaleDateString()}
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {!complimentary && (
        <div className="flex gap-3">
          {isFree ? (
            <button
              type="button"
              onClick={() => void handleUpgrade()}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {loading ? "Redirecting..." : "Upgrade to Pro - $20/seat/month"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleManage()}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium border border-border-strong text-on-surface-secondary hover:text-on-surface hover:border-border-strong rounded-lg transition-colors"
            >
              {loading ? "Redirecting..." : "Manage subscription"}
            </button>
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
