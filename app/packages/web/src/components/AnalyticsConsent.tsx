import { useSyncExternalStore } from "react";
import { T, useGT } from "gt-react";
import {
  acceptAnalytics,
  consentPromptVisible,
  declineAnalytics,
  subscribeConsentPrompt,
} from "@infrawrench/analytics";

const BUTTON =
  "px-3 py-1.5 rounded-lg border border-border bg-surface-overlay text-on-surface text-sm font-medium hover:bg-surface-sunken transition-colors";

/**
 * The PostHog consent prompt, shown only to visitors in the EEA, UK and
 * Switzerland who have not answered yet (or who reopened it from Settings).
 * Accept and Decline are deliberately the same weight.
 */
export function AnalyticsConsent() {
  const gt = useGT();
  const visible = useSyncExternalStore(subscribeConsentPrompt, consentPromptVisible, () => false);
  if (!visible) return null;

  return (
    <section
      aria-label={gt("Cookie preferences")}
      className="fixed bottom-4 left-4 z-50 max-w-sm rounded-lg border border-border bg-surface-raised p-4 shadow-lg"
    >
      <T>
        <p className="text-sm text-on-surface-secondary">
          May we use cookies to understand how Infrawrench is used? This turns on PostHog product
          analytics and session replays, with on-screen text and inputs masked.{" "}
          <a
            href="https://infrawrench.com/privacy#telemetry"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-on-surface"
          >
            Privacy policy
          </a>
        </p>
      </T>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={declineAnalytics} className={BUTTON}>
          {gt("Decline")}
        </button>
        <button type="button" onClick={acceptAnalytics} className={BUTTON}>
          {gt("Accept")}
        </button>
      </div>
    </section>
  );
}
