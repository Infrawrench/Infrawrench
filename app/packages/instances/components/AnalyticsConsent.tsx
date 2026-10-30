"use client";

import { useSyncExternalStore } from "react";
import { T, useGT } from "gt-react";
import {
  acceptAnalytics,
  consentPromptVisible,
  declineAnalytics,
  subscribeConsentPrompt,
} from "@infrawrench/analytics";

const BUTTON =
  "rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-2";

/**
 * The PostHog consent prompt, shown only to visitors in the EEA, UK and
 * Switzerland who have not answered yet (or who reopened it from the footer).
 * Accept and Decline are deliberately the same weight.
 */
export function AnalyticsConsent() {
  const gt = useGT();
  const visible = useSyncExternalStore(subscribeConsentPrompt, consentPromptVisible, () => false);
  if (!visible) return null;

  return (
    <section
      aria-label={gt("Cookie preferences")}
      className="fixed bottom-16 left-4 right-4 z-40 rounded-lg border border-line bg-surface p-4 text-xs text-ink-2 shadow-lg sm:right-auto sm:max-w-sm"
    >
      <T>
        <p>
          May we use cookies to understand how this site is used? This turns on PostHog analytics
          and session replays, with form inputs masked.{" "}
          <a className="text-ink underline" href="https://infrawrench.com/privacy#telemetry">
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
