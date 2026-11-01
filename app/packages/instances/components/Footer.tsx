"use client";

import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { usePathname } from "next/navigation";
import { splitLocale } from "@/lib/i18n/locales";
import { analyticsEnabled, openConsentPrompt } from "@infrawrench/analytics";
import { startAnalytics } from "@/lib/analytics";
import { AnalyticsConsent } from "./AnalyticsConsent";

/** The bulk instances API: the SDKs and HTTP endpoints this site's data is also available through. */
const API_DOCS = "https://infrawrench.com/docs/team-and-billing/bulk-instances-api";

/** Chat pages, where the question box floats at the bottom instead of the footer. */
function isChatPage(pathname: string): boolean {
  const { path } = splitLocale(pathname);
  return path.startsWith("/chat/") || path.startsWith("/v/");
}

export function Footer() {
  const gt = useGT();
  const chat = isChatPage(usePathname() ?? "/");
  // Every page renders the footer, so it is what starts PostHog. The link
  // appears after hydration: the server never knows whether analytics is on.
  const [analyticsOn, setAnalyticsOn] = useState(false);
  useEffect(() => {
    startAnalytics();
    setAnalyticsOn(analyticsEnabled());
  }, []);

  return (
    <>
      {/* Stays in view at the bottom of the window, like the nav at the top.
          z-10 keeps it under open pickers (z-30) and over page content. */}
      <footer
        className={`${chat ? "" : "sticky bottom-0 z-10"} border-t border-line bg-surface/90 backdrop-blur-md`}
      >
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-3 text-xs text-ink-3 sm:px-7">
          {/* On a phone the chat pages need the height more; the nav's logo
              links to infrawrench.com as well. */}
          <a
            className={`font-semibold text-ink-2 hover:text-ink ${chat ? "hidden sm:inline" : ""}`}
            href="https://infrawrench.com"
          >
            {gt("Infrawrench: every cloud account in one app")}
          </a>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <a className="hover:text-ink" href={API_DOCS}>
              {gt("Bulk instances API")}
            </a>
            <a className="hover:text-ink" href="https://app.infrawrench.com">
              {gt("Cloud")}
            </a>
            <a className="hover:text-ink" href="https://infrawrench.com/docs">
              {gt("Docs")}
            </a>
            <a className="hover:text-ink" href="https://infrawrench.com/privacy">
              {gt("Privacy")}
            </a>
            {analyticsOn && (
              <button type="button" className="hover:text-ink" onClick={openConsentPrompt}>
                {gt("Cookie preferences")}
              </button>
            )}
          </div>
        </div>
      </footer>
      <AnalyticsConsent />
    </>
  );
}
