"use client";

import { useEffect } from "react";
import { useGT, useLocale } from "gt-react";
import { captureAnalytics } from "@infrawrench/analytics";
import { startEmbedAnalytics } from "@/lib/analytics";
import { getInfrawrenchUrl, type EmbedKind } from "@/lib/embed";
import { localePath } from "@/lib/i18n/locales";

const SECONDARY =
  "whitespace-nowrap rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-2";
const PRIMARY =
  "whitespace-nowrap rounded-md bg-accent-fill px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-accent-fill-hover";

type CtaTarget = "get_infrawrench" | "full_page" | "brand" | "specs";

export function clicked(kind: EmbedKind, target: CtaTarget) {
  captureAnalytics("embed_cta_clicked", { embed: kind, target });
}

/**
 * The site's logo and name, as in its nav, for the embed's top corner. Ink
 * tokens rather than the nav's own colors: the nav is always dark, an embed
 * follows the reader's theme.
 */
export function EmbedBrand({ kind }: { kind: EmbedKind }) {
  const gt = useGT();
  const locale = useLocale();
  return (
    <a
      className="flex shrink-0 items-center gap-1.5 text-[15px] tracking-[-0.04em] whitespace-nowrap"
      href={localePath(locale, "/")}
      target="_blank"
      rel="noopener"
      onClick={() => clicked(kind, "brand")}
    >
      <img src="/icon.svg" width={22} height={22} alt="" />
      {/* i18n-ignore: product name */}
      <span className="font-extrabold text-ink">Infrawrench</span>
      <span className="font-medium text-ink-2">{gt("Instances")}</span>
    </a>
  );
}

/**
 * An X Player Card's page: the content, scrolling if the frame is short, above
 * a call to action that is always in view. Every link opens a new tab, because
 * the sandbox blocks navigating X itself and a link followed inside the frame
 * would leave the reader on the full site in a 640px box.
 */
export function EmbedShell({
  kind,
  fullHref,
  fullLabel,
  children,
}: {
  kind: EmbedKind;
  /** The full page, carrying what the reader selected here. */
  fullHref: string;
  fullLabel: string;
  children: React.ReactNode;
}) {
  const gt = useGT();
  useEffect(() => startEmbedAnalytics(), []);

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-line bg-surface px-3 py-2">
        <div className="flex min-w-0 items-center gap-3 text-xs text-ink-2">
          <span className="hidden min-[520px]:inline">{gt("Every cloud account in one app")}</span>
          <a
            className="underline underline-offset-2 hover:text-ink"
            href="https://infrawrench.com/privacy#posthog"
            target="_blank"
            rel="noopener"
          >
            {gt("Privacy")}
          </a>
        </div>
        <div className="flex items-center gap-2">
          <a
            className={SECONDARY}
            href={fullHref}
            target="_blank"
            rel="noopener"
            onClick={() => clicked(kind, "full_page")}
          >
            {fullLabel}
          </a>
          <a
            className={PRIMARY}
            href={getInfrawrenchUrl(kind)}
            target="_blank"
            rel="noopener"
            onClick={() => clicked(kind, "get_infrawrench")}
          >
            {gt("Get Infrawrench")}
          </a>
        </div>
      </footer>
    </div>
  );
}
