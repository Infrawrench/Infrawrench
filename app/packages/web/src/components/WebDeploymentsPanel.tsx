import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { DeploymentsPanel, type BillingStatus, type DeploymentClient } from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

/**
 * Web wrapper around the shared DeploymentsPanel that gates the whole page
 * behind a paid plan. The server already refuses actual builds with a 402
 * (`requirePaidPlan` in the runner), but a free org landing on the page and
 * only finding out at the deploy button is a worse pitch than saying up front
 * what the feature is and what unlocks it. Desktop is not gated — local
 * deploys via the CLI are free — so this lives web-side, not in the panel.
 */

// Mirrors PAID_STATUSES in @infrawrench/server-core/entitlements: past_due
// still counts as paid while Stripe retries the card.
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

function isPaid(status: BillingStatus): boolean {
  if (status.complimentary) return true;
  const sub = status.subscription;
  return sub !== null && PAID_STATUSES.has(sub.status);
}

export function WebDeploymentsPanel({
  client,
  orgId,
  initialRepo,
}: {
  client: DeploymentClient;
  orgId: string;
  initialRepo?: string;
}) {
  const [paid, setPaid] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    apiGet<BillingStatus>(`/api/org/${orgId}/billing/status`)
      .then((status) => {
        if (!cancelled) setPaid(isPaid(status));
      })
      .catch(() => {
        // If the status can't be read, show the page: the server still gates
        // the deploy itself, and a transient error shouldn't lock the UI.
        if (!cancelled) setPaid(true);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  if (paid === undefined) {
    return null;
  }

  if (!paid) {
    return <DeploymentsUpsell orgId={orgId} />;
  }

  return <DeploymentsPanel client={client} {...(initialRepo ? { initialRepo } : {})} />;
}

function DeploymentsUpsell({ orgId }: { orgId: string }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8 text-on-surface">
      <div className="max-w-md w-full border border-border rounded-xl p-6">
        <span className="inline-block text-xs font-medium px-2 py-1 rounded-full bg-blue-500/10 text-blue-400 mb-4">
          Pro feature
        </span>
        <h1 className="text-lg font-semibold mb-2">Deploy from GitHub</h1>
        <p className="text-sm text-on-surface-secondary mb-4">
          Connect a repository with an Infrafile and ship it from here: pick a branch and
          environment, preview the plan, and watch the build and deploy live. Deploy-on-push keeps
          it shipping after every merge.
        </p>
        <ul className="space-y-2 text-sm text-on-surface-tertiary mb-6">
          <li>Hosted builds — no local Docker needed</li>
          <li>Deploy-on-push from GitHub</li>
          <li>Full run history with rollbacks</li>
        </ul>
        <Link
          to="/org/$orgId/settings/billing"
          params={{ orgId }}
          className="inline-block px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
        >
          Upgrade to Pro
        </Link>
        <p className="text-xs text-on-surface-muted mt-3">
          $20/seat/month. Local deploys with the <code>infrawrench</code> CLI stay free.
        </p>
      </div>
    </div>
  );
}
