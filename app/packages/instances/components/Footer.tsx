"use client";

import { useGT } from "gt-react";

/** The bulk instances API: the SDKs and HTTP endpoints this site's data is also available through. */
const API_DOCS = "https://infrawrench.com/docs/team-and-billing/bulk-instances-api";

export function Footer() {
  const gt = useGT();
  return (
    // Stays in view at the bottom of the window, like the nav at the top.
    // z-10 keeps it under open pickers (z-30) and over page content.
    <footer className="sticky bottom-0 z-10 border-t border-line bg-surface/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-x-8 gap-y-2 px-4 py-3 text-xs text-ink-3 sm:px-7">
        <a className="font-semibold text-ink-2 hover:text-ink" href="https://infrawrench.com">
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
        </div>
      </div>
    </footer>
  );
}
