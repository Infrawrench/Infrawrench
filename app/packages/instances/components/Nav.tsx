"use client";

import Link from "next/link";
import { useGT, useLocale } from "gt-react";
import { LOCALES, LOCALE_COOKIE, localePath, splitLocale } from "@/lib/i18n/locales";

/** Each language named in itself: "Deutsch", "日本語". */
function nativeName(code: string): string {
  const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}

function LanguagePicker() {
  const gt = useGT();
  const locale = useLocale();
  return (
    <select
      aria-label={gt("Language")}
      className="rounded-lg border border-line bg-surface px-2 py-1.5 text-base text-ink-2 sm:text-[13px] hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-accent"
      value={locale}
      onChange={(e) => {
        const next = e.target.value;
        // Remembered so proxy.ts can send English links to this language.
        document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        const { path } = splitLocale(window.location.pathname);
        window.location.assign(
          `${localePath(next, path)}${window.location.search}${window.location.hash}`,
        );
      }}
    >
      {LOCALES.map((code) => (
        <option key={code} value={code}>
          {nativeName(code)}
        </option>
      ))}
    </select>
  );
}

/** The infrawrench.com home page nav (`.hm-nav` in app/packages/website/src/pages/index.astro), for the instances site. */
export function Nav() {
  const gt = useGT();
  const locale = useLocale();
  return (
    <>
      <a className="skip-link" href="#main-content">
        {gt("Skip to main content")}
      </a>
      <nav className="nav-bar" aria-label={gt("Primary")}>
        <div className="nav-inner">
          {/* The site's own home: every service. Logo and name are one link to it. */}
          <Link className="nav-logo" href={localePath(locale, "/")}>
            <img src="/icon.svg" width={28} height={28} alt="" />
            {/* i18n-ignore: product name */}
            <span className="nav-logo-text">Infrawrench</span>
            <span className="nav-logo-sub">{gt("Instances")}</span>
          </Link>
          <div className="nav-links">
            <a className="nav-link" href="https://infrawrench.com/docs">
              {gt("Docs")}
            </a>
            <a
              className="nav-link"
              href="https://join.slack.com/t/infrawrenchllc/shared_invite/zt-3x6hs7pyf-riCnQeurmX_EDkv5Nan_Ig"
            >
              {gt("Community")}
            </a>
            <a className="nav-link" href="https://app.infrawrench.com">
              {gt("Open Cloud")}
            </a>
            <LanguagePicker />
            {/* infrawrench.com opens its download dialog for #download. */}
            <a className="nav-cta" href="https://infrawrench.com/#download">
              {gt("Get Infrawrench")}
            </a>
          </div>
        </div>
      </nav>
    </>
  );
}
