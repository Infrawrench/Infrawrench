import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { apiPost } from "@/lib/api";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

type OnboardingStep = "create" | "plan";

const FREE_FEATURES = [
  "1 user, 3 connected accounts",
  "All 47 plugins",
  "Dashboards, SSH terminal & SQL editor",
  "$5/mo of AI chat included",
];

const PRO_FEATURES = [
  "Unlimited team members",
  "Unlimited cloud accounts",
  "Full audit trail",
  "Custom graphs & deploy from GitHub",
  "API key management",
];

function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<OnboardingStep>("create");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const org = await apiPost<{ id: string; displayName: string }>("/api/orgs", {
        displayName: trimmed,
      });
      setOrgId(org.id);
      setCreating(false);
      setStep("plan");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create organization");
      setCreating(false);
    }
  }

  function handleContinueFree() {
    if (!orgId) return;
    void navigate({ to: "/org/$orgId", params: { orgId } });
  }

  async function handleUpgrade() {
    if (!orgId) return;
    setUpgrading(true);
    setError(null);
    try {
      const { url } = await apiPost<{ url: string }>(`/api/org/${orgId}/billing/checkout`);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start checkout");
      setUpgrading(false);
    }
  }

  if (step === "plan") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
        <div className="w-full max-w-2xl px-6">
          <h1 className="text-2xl font-bold mb-2">Choose your plan</h1>
          <p className="text-sm text-on-surface-tertiary mb-8">
            Your organization is ready. Start free, or unlock the full platform for your team.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div className="border border-border rounded-xl p-5 flex flex-col">
              <h2 className="text-sm font-medium text-on-surface-secondary">Free</h2>
              <p className="text-2xl font-bold mt-1 mb-4">
                $0
                <span className="text-sm font-normal text-on-surface-muted"> / month</span>
              </p>
              <ul className="space-y-2 text-sm text-on-surface-tertiary mb-6 flex-1">
                {FREE_FEATURES.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleContinueFree}
                disabled={upgrading}
                className="w-full px-4 py-2.5 text-sm font-medium border border-border-strong text-on-surface-secondary hover:text-on-surface disabled:opacity-50 rounded-lg transition-colors"
              >
                Continue with Free
              </button>
            </div>

            <div className="border border-blue-600 rounded-xl p-5 flex flex-col">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-on-surface-secondary">Pro</h2>
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-blue-500/10 text-blue-400">
                  Recommended
                </span>
              </div>
              <p className="text-2xl font-bold mt-1 mb-4">
                $20
                <span className="text-sm font-normal text-on-surface-muted"> / seat / month</span>
              </p>
              <ul className="space-y-2 text-sm text-on-surface-tertiary mb-6 flex-1">
                {PRO_FEATURES.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void handleUpgrade()}
                disabled={upgrading}
                className="w-full px-4 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
              >
                {upgrading ? "Redirecting..." : "Upgrade to Pro"}
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-red-400 mb-4">{error}</p>}

          <p className="text-xs text-on-surface-muted text-center">
            You can upgrade any time from Settings &rarr; Billing.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
      <div className="w-full max-w-md px-6">
        <h1 className="text-2xl font-bold mb-2">Create your organization</h1>
        <p className="text-sm text-on-surface-tertiary mb-8">
          Organizations let you manage infrastructure and collaborate with your team.
        </p>

        <label
          id="onboarding-org-name-label"
          htmlFor="onboarding-org-name"
          className="block text-sm font-medium text-on-surface-secondary mb-2"
        >
          Organization name
        </label>
        <input
          ref={nameInputRef}
          id="onboarding-org-name"
          aria-labelledby="onboarding-org-name-label"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
          placeholder="My Company"
          className="w-full bg-surface-overlay border border-border-strong rounded-lg px-4 py-3 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong mb-4"
        />

        {error && <p className="text-xs text-red-400 mb-4">{error}</p>}

        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim()}
          className="w-full px-4 py-3 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {creating ? "Creating..." : "Create Organization"}
        </button>
      </div>
    </div>
  );
}
