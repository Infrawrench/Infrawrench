"use client";

import { useState, useEffect } from "react";
import {
  getSubscriptionStatus,
  createCheckoutSession,
  createBillingPortalSession,
  type SubscriptionStatus,
} from "@/actions/billing";

export default function BillingPage() {
  const [sub, setSub] = useState<SubscriptionStatus | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getSubscriptionStatus().then(setSub);
  }, []);

  async function handleUpgrade() {
    setLoading(true);
    try {
      const { url } = await createCheckoutSession();
      window.location.href = url;
    } catch (e) {
      console.error("Checkout error:", e);
      setLoading(false);
    }
  }

  async function handleManage() {
    setLoading(true);
    try {
      const { url } = await createBillingPortalSession();
      window.location.href = url;
    } catch (e) {
      console.error("Portal error:", e);
      setLoading(false);
    }
  }

  if (sub === undefined) {
    return <p className="text-sm text-gray-600">Loading...</p>;
  }

  const isActive = sub?.status === "active";
  const isFree = !sub || sub.status === "trialing" || sub.status === "canceled";

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">Billing</h1>

      {/* Current plan */}
      <div className="border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-medium text-gray-200">
              {isFree ? "Free Plan" : "Pro Plan"}
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              {isFree
                ? "1 user, 3 accounts, no audit trail"
                : `${sub?.seatCount ?? 1} seat${(sub?.seatCount ?? 1) !== 1 ? "s" : ""} at $20/month each`}
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2 py-1 rounded-full ${
              isActive
                ? "bg-green-500/10 text-green-400"
                : sub?.status === "past_due"
                  ? "bg-yellow-500/10 text-yellow-400"
                  : "bg-gray-800 text-gray-400"
            }`}
          >
            {isActive ? "Active" : sub?.status === "past_due" ? "Past due" : "Free"}
          </span>
        </div>

        {sub?.currentPeriodEnd && (
          <p className="text-xs text-gray-500">
            Current period ends: {new Date(sub.currentPeriodEnd).toLocaleDateString()}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        {isFree ? (
          <button
            onClick={() => void handleUpgrade()}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {loading ? "Redirecting..." : "Upgrade to Pro - $20/seat/month"}
          </button>
        ) : (
          <button
            onClick={() => void handleManage()}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium border border-gray-700 text-gray-300 hover:text-gray-100 hover:border-gray-600 rounded-lg transition-colors"
          >
            {loading ? "Redirecting..." : "Manage subscription"}
          </button>
        )}
      </div>

      {/* Free tier info */}
      {isFree && (
        <div className="mt-8 border border-gray-800 rounded-xl p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Pro plan includes:</h3>
          <ul className="space-y-2 text-sm text-gray-400">
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
