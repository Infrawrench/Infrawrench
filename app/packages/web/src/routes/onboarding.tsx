import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { msg, useGT, useMessages } from "gt-react";
import { readRevnuMeasurement } from "@infrawrench/analytics";
import { AppPicker } from "@infrawrench/ui";
import { SWITCHABLE_PRODUCTS, type ProductId } from "@infrawrench/client-core";
import { apiPost, apiPut } from "@/lib/api";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

type OnboardingStep = "create" | "apps" | "plan";

const FREE_FEATURES = [
  msg("1 user, 3 connected accounts"),
  msg("All 152 plugins"),
  msg("Dashboards, SSH terminal & SQL editor"),
  msg("$5/mo of AI chat included"),
];

const PRO_FEATURES = [
  msg("Unlimited team members"),
  msg("Unlimited cloud accounts"),
  msg("Full audit trail"),
  msg("Custom graphs & deploy from GitHub"),
  msg("API key management"),
];

function OnboardingPage() {
  const navigate = useNavigate();
  const gt = useGT();
  const m = useMessages();
  const [step, setStep] = useState<OnboardingStep>("create");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [orgId, setOrgId] = useState<string | null>(null);
  // Which apps the organization expects to use. All of them to begin with:
  // the question is what to leave out, and nothing is lost by skipping it.
  const [apps, setApps] = useState<ProductId[]>([...SWITCHABLE_PRODUCTS]);
  const [savingApps, setSavingApps] = useState(false);
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
      setStep("apps");
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to create organization"));
      setCreating(false);
    }
  }

  // The apps left unpicked are turned off for the organization, exactly as
  // Settings > Apps would. Nothing is written when every app is kept.
  async function handleApps() {
    if (!orgId) return;
    const disabled = SWITCHABLE_PRODUCTS.filter((id) => !apps.includes(id));
    if (disabled.length === 0) {
      setStep("plan");
      return;
    }
    setSavingApps(true);
    setError(null);
    try {
      await apiPut(`/api/org/${orgId}/products`, { disabled });
      setStep("plan");
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save your apps"));
    } finally {
      setSavingApps(false);
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
      const measurement = readRevnuMeasurement();
      const { url } = await apiPost<{ url: string }>(
        `/api/org/${orgId}/billing/checkout`,
        measurement ? { measurement } : undefined,
      );
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to start checkout"));
      setUpgrading(false);
    }
  }

  if (step === "apps") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
        <div className="w-full max-w-2xl px-6">
          <h1 className="text-2xl font-bold mb-2">{gt("Which apps will you use?")}</h1>
          <p className="text-sm text-on-surface-tertiary mb-6">
            {gt(
              "Infrastructure is always on. The apps you leave out stay out of the way, and you can change this any time in Settings.",
            )}
          </p>

          <AppPicker selected={apps} onChange={setApps} disabled={savingApps} />

          {error && <p className="text-xs text-danger mt-4">{error}</p>}

          <button
            type="button"
            onClick={() => void handleApps()}
            disabled={savingApps}
            className="mt-6 w-full px-4 py-3 text-sm font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-on-accent rounded-lg transition-colors"
          >
            {savingApps ? gt("Saving...") : gt("Continue")}
          </button>
        </div>
      </div>
    );
  }

  if (step === "plan") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
        <div className="w-full max-w-2xl px-6">
          <h1 className="text-2xl font-bold mb-2">{gt("Choose your plan")}</h1>
          <p className="text-sm text-on-surface-tertiary mb-8">
            {gt(
              "Your organization is ready. Start free, or unlock the full platform for your team.",
            )}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div className="border border-border rounded-xl p-5 flex flex-col">
              <h2 className="text-sm font-medium text-on-surface-secondary">{gt("Free")}</h2>
              <p className="text-2xl font-bold mt-1 mb-4">
                $0
                <span className="text-sm font-normal text-on-surface-muted"> {gt("/ month")}</span>
              </p>
              <ul className="space-y-2 text-sm text-on-surface-tertiary mb-6 flex-1">
                {FREE_FEATURES.map((feature) => (
                  <li key={feature}>{m(feature)}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={handleContinueFree}
                disabled={upgrading}
                className="w-full px-4 py-2.5 text-sm font-medium border border-border-strong text-on-surface-secondary hover:text-on-surface disabled:opacity-50 rounded-lg transition-colors"
              >
                {gt("Continue with Free")}
              </button>
            </div>

            <div className="border border-accent rounded-xl p-5 flex flex-col">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-on-surface-secondary">{gt("Pro")}</h2>
                <span className="text-xs font-medium px-2 py-1 rounded-md bg-accent/10 text-info">
                  {gt("Recommended")}
                </span>
              </div>
              <p className="text-2xl font-bold mt-1 mb-4">
                $20
                <span className="text-sm font-normal text-on-surface-muted">
                  {" "}
                  {gt("/ seat / month")}
                </span>
              </p>
              <ul className="space-y-2 text-sm text-on-surface-tertiary mb-6 flex-1">
                {PRO_FEATURES.map((feature) => (
                  <li key={feature}>{m(feature)}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void handleUpgrade()}
                disabled={upgrading}
                className="w-full px-4 py-2.5 text-sm font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-on-accent rounded-lg transition-colors"
              >
                {upgrading ? gt("Redirecting...") : gt("Upgrade to Pro")}
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-danger mb-4">{error}</p>}

          <p className="text-xs text-on-surface-muted text-center">
            {gt("You can upgrade any time from Settings → Billing.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
      <div className="w-full max-w-md px-6">
        <h1 className="text-2xl font-bold mb-2">{gt("Create your organization")}</h1>
        <p className="text-sm text-on-surface-tertiary mb-8">
          {gt("Organizations let you manage infrastructure and collaborate with your team.")}
        </p>

        <label
          id="onboarding-org-name-label"
          htmlFor="onboarding-org-name"
          className="block text-sm font-medium text-on-surface-secondary mb-2"
        >
          {gt("Organization name")}
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
          placeholder={gt("My Company")}
          className="w-full bg-surface-overlay border border-border-strong rounded-lg px-4 py-3 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong mb-4"
        />

        {error && <p className="text-xs text-danger mb-4">{error}</p>}

        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim()}
          className="w-full px-4 py-3 text-sm font-medium bg-accent hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-on-accent rounded-lg transition-colors"
        >
          {creating ? gt("Creating...") : gt("Create Organization")}
        </button>
      </div>
    </div>
  );
}
