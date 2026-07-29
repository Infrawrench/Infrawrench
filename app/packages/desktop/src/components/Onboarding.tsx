import { useEffect, useRef, useState } from "react";
import { getCloudAuthStatus, getCloudOrgs, startCloudAuth, type CloudOrg } from "../lib/cloud-api";
import { invoke } from "../lib/invoke";
import { CLOUD_URL } from "../../env";

const ONBOARDING_STORAGE_KEY = "infrawrench:onboarding-complete";

export function isOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  } catch {
    // Storage being unavailable just means the welcome shows again next launch.
  }
}

type Step = "welcome" | "signing-in" | "pick-org";

interface OnboardingProps {
  /** Sign-in finished in the browser; hand the fetched orgs to the sidebar. */
  onSignedIn: (orgs: CloudOrg[]) => void;
  /** The user picked an organization (or null for local-only mode). */
  onSelectOrg: (orgId: string | null) => void;
  /** The flow is finished — mark it complete and unmount. */
  onDone: () => void;
}

const PERKS: { title: string; description: string; icon: React.ReactNode }[] = [
  {
    title: "Take it everywhere",
    description: "Your accounts, dashboards, and workspaces sync to the web app and your phone.",
    icon: <PerkIcon d="M12 3v10m0 0l-4-4m4 4l4-4M4 17h16v3H4z" />,
  },
  {
    title: "Bring your team",
    description:
      "Create an organization, invite teammates, and share dashboards, resources, and SSH keys with role-based access.",
    icon: (
      <PerkIcon d="M9 11a3 3 0 100-6 3 3 0 000 6zm-5 8a5 5 0 0110 0M17 9a2.5 2.5 0 100-5m3 15a4.5 4.5 0 00-4-4.4" />
    ),
  },
  {
    title: "Automate in the cloud",
    description:
      "Workflows, deployments, and agents run server-side and keep going after your laptop sleeps.",
    icon: <PerkIcon d="M7 17a4 4 0 01-.6-7.95A5.5 5.5 0 0117.2 8.6 3.75 3.75 0 0116.75 17H7z" />,
  },
  {
    title: "Budgets and alerts",
    description: "Track spend across every provider and get notified before costs surprise you.",
    icon: <PerkIcon d="M4 19V5m0 14h16M8 15v-4m4 4V8m4 7v-6" />,
  },
];

function PerkIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5 text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/**
 * First-run welcome screen. Pitches what signing in to Infrawrench Cloud adds
 * on top of local mode, runs the browser OAuth flow, and — once signed in —
 * lets the user pick which organization to start in. Skippable at every step:
 * the app is fully usable locally without an account.
 */
export function Onboarding({ onSignedIn, onSelectOrg, onDone }: OnboardingProps) {
  const [step, setStep] = useState<Step>("welcome");
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshingOrgs, setRefreshingOrgs] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
  }

  useEffect(() => stopPolling, []);

  async function loadOrgs(): Promise<CloudOrg[]> {
    const fetched = await getCloudOrgs();
    setOrgs(fetched);
    onSignedIn(fetched);
    return fetched;
  }

  function handleSignIn() {
    setError(null);
    setStep("signing-in");
    startCloudAuth()
      .then(() => {
        // Same poll the sidebar sign-in button uses: the main process has no
        // push event for a completed OAuth callback.
        pollRef.current = setInterval(() => {
          getCloudAuthStatus()
            .then((status) => {
              if (!status.authenticated) return;
              stopPolling();
              loadOrgs()
                .then(() => setStep("pick-org"))
                .catch((e) => {
                  console.error("[onboarding] failed to load orgs:", e);
                  setError("Signed in, but loading your organizations failed. Try again.");
                  setStep("welcome");
                });
            })
            .catch(console.error);
        }, 2000);
        timeoutRef.current = setTimeout(() => {
          stopPolling();
          setError("Sign-in timed out. Finish signing in in your browser, then try again.");
          setStep("welcome");
        }, 120_000);
      })
      .catch((e) => {
        console.error("[onboarding] failed to start sign-in:", e);
        setError("Couldn't open the sign-in page. Check your connection and try again.");
        setStep("welcome");
      });
  }

  function handleCancelSignIn() {
    stopPolling();
    setStep("welcome");
  }

  function finish(orgId: string | null) {
    onSelectOrg(orgId);
    onDone();
  }

  function handleRefreshOrgs() {
    setRefreshingOrgs(true);
    loadOrgs()
      .catch(console.error)
      .finally(() => setRefreshingOrgs(false));
  }

  return (
    <div
      role="dialog"
      aria-label="Welcome to Infrawrench"
      className="fixed inset-0 z-[90] bg-surface flex flex-col select-none"
    >
      {/* Keep the window draggable while the overlay covers the title bar. */}
      <div
        className="h-8 flex-shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />
      <div className="flex-1 overflow-y-auto flex items-center justify-center px-6 py-8">
        {step === "welcome" && (
          <div className="w-full max-w-lg">
            <h1 className="text-xl font-semibold text-on-surface">Welcome to Infrawrench</h1>
            <p className="mt-1.5 text-sm text-on-surface-tertiary">
              All your infrastructure in one place. Sign in to Infrawrench Cloud to get the most out
              of it:
            </p>

            <ul className="mt-6 flex flex-col gap-4">
              {PERKS.map((perk) => (
                <li key={perk.title} className="flex gap-3">
                  <div className="mt-0.5 flex-shrink-0">{perk.icon}</div>
                  <div>
                    <div className="text-sm font-medium text-on-surface-secondary">
                      {perk.title}
                    </div>
                    <div className="text-xs text-on-surface-muted mt-0.5">{perk.description}</div>
                  </div>
                </li>
              ))}
            </ul>

            {error && (
              <div className="mt-5 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <div className="mt-7 flex flex-col gap-2">
              <button
                type="button"
                autoFocus
                onClick={handleSignIn}
                className="w-full px-4 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                Sign in to Infrawrench Cloud
              </button>
              <button
                type="button"
                onClick={() => finish(null)}
                className="w-full px-4 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
              >
                Continue without an account
              </button>
            </div>
            <p className="mt-4 text-[11px] text-on-surface-faint text-center">
              Infrawrench works fully offline too — you can sign in any time from the sidebar.
            </p>
          </div>
        )}

        {step === "signing-in" && (
          <div className="w-full max-w-sm text-center">
            <div
              className="mx-auto size-8 rounded-full border-2 border-border-strong border-t-accent animate-spin"
              aria-hidden="true"
            />
            <h1 className="mt-5 text-base font-semibold text-on-surface">
              Waiting for your browser…
            </h1>
            <p className="mt-1.5 text-xs text-on-surface-muted">
              Finish signing in in the browser window we just opened. This screen updates
              automatically.
            </p>
            <button
              type="button"
              onClick={handleCancelSignIn}
              className="mt-6 px-4 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {step === "pick-org" && (
          <div className="w-full max-w-md">
            <h1 className="text-xl font-semibold text-on-surface">
              {orgs.length > 0 ? "Choose an organization" : "You're signed in"}
            </h1>
            <p className="mt-1.5 text-sm text-on-surface-tertiary">
              {orgs.length > 0
                ? "Pick where you want to start. You can switch any time from the sidebar."
                : "You're not in an organization yet. Create one on the web, then pick it up here."}
            </p>

            {orgs.length > 0 ? (
              <ul className="mt-6 flex flex-col gap-2">
                {orgs.map((org, i) => (
                  <li key={org.id}>
                    <button
                      type="button"
                      autoFocus={i === 0}
                      onClick={() => finish(org.id)}
                      className="w-full flex items-center justify-between px-4 py-3 rounded-lg bg-surface-raised border border-border-strong hover:border-accent hover:bg-surface-overlay transition-colors text-left"
                    >
                      <span className="text-sm font-medium text-on-surface-secondary truncate">
                        {org.displayName}
                      </span>
                      <span className="ml-3 flex-shrink-0 text-[11px] text-on-surface-faint uppercase tracking-wide">
                        {org.role}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-6 flex flex-col gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={() =>
                    void invoke("open_external_url", { url: `${CLOUD_URL}/onboarding` })
                  }
                  className="w-full px-4 py-2.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
                >
                  Create an organization
                </button>
                <button
                  type="button"
                  onClick={handleRefreshOrgs}
                  disabled={refreshingOrgs}
                  className="w-full px-4 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors disabled:opacity-50"
                >
                  {refreshingOrgs ? "Checking…" : "I created one — check again"}
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => finish(null)}
              className="mt-4 w-full px-4 py-2 rounded-lg text-xs text-on-surface-muted hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
            >
              Use locally for now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
