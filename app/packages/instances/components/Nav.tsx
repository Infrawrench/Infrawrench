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
      className="rounded-md border border-[#1a1a1a] bg-transparent px-2 py-1.5 text-base text-[#9ca3af] sm:text-[13px] hover:border-[#333] focus-visible:outline-2 focus-visible:outline-[#2563eb]"
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
        <option key={code} value={code} className="bg-[#0b0b0b]">
          {nativeName(code)}
        </option>
      ))}
    </select>
  );
}

/** The infrawrench.com nav (app/packages/website/src/components/Nav.astro), for the instances site. */
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
          <div className="nav-logo">
            <a className="nav-logo" href="https://infrawrench.com">
              <img src="/icon.png" width={28} height={28} alt="" style={{ borderRadius: 6 }} />
              {/* i18n-ignore: product name */}
              <span className="nav-logo-text">Infrawrench</span>
            </a>
            {/* The site's own home: every service. */}
            <Link className="nav-badge" href={localePath(locale, "/")}>
              {gt("Instances")}
            </Link>
          </div>
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
            <LanguagePicker />
            <a className="btn-ghost" href="https://app.infrawrench.com">
              {gt("Open Cloud")}
            </a>
          </div>
        </div>
      </nav>
    </>
  );
}
