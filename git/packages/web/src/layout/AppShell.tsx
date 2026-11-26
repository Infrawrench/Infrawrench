/**
 * The frame every page sits in: the top bar (brand, search, the signed-in
 * menu or a sign-in link) and the page below it.
 */
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import type { SessionUser } from "@infrawrench/git-contract";
import { AppLink, useGo } from "../components/AppLink";
import { ButtonLink, buttonClass } from "../components/Button";
import { Icon } from "../components/icons";
import { Menu } from "../components/Menu";
import { Avatar } from "../components/people";
import { paths } from "../lib/paths";
import { signInHref, useSession } from "../lib/session";
import { accountName, useAccountMenuItems } from "./account-menu";

/** The Infrawrench mark (`brand/mark.svg`), drawn in the text colour. */
export function BrandMark({ size = 20 }: { size?: number }) {
  const mask = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className="shrink-0">
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="-300" y="-300" width="600" height="600">
          <rect x="-300" y="-300" width="600" height="600" fill="#fff" />
          <path d="M-34 -240H34V-112Q34 -98 20 -98H-20Q-34 -98 -34 -112Z" fill="#000" />
          <circle cx="0" cy="128" r="22" fill="#000" />
        </mask>
      </defs>
      <g transform="translate(256 256) rotate(45) translate(0 16)">
        <g mask={`url(#${mask})`} fill="currentColor">
          <circle cx="0" cy="-114" r="88" />
          <path d="M-34 100V20C-34 -10 -44 -34 -64 -60H64C44 -34 34 -10 34 20V100Z" />
          <circle cx="0" cy="128" r="48" />
        </g>
      </g>
    </svg>
  );
}

function TopSearch() {
  const go = useGo();
  const location = useLocation();
  const onExplore = location.pathname === "/explore";
  const fromUrl = onExplore ? (new URLSearchParams(location.searchStr).get("q") ?? "") : "";
  const [value, setValue] = useState(fromUrl);
  useEffect(() => setValue(fromUrl), [fromUrl]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    go(paths.explore({ q: value.trim() }));
  };
  return (
    <form role="search" onSubmit={submit} className="relative hidden w-64 sm:block">
      <Icon
        name="search"
        size={13}
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-on-surface-faint"
      />
      <input
        type="search"
        aria-label="Search repositories"
        placeholder="Search repositories"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="w-full rounded border border-border bg-surface px-2 py-1 pl-7 text-xs text-on-surface placeholder:text-on-surface-faint focus:border-border-strong"
      />
    </form>
  );
}

function UserMenu() {
  const session = useSession();
  if (session.data === undefined) return <div className="h-7 w-16" />;
  const { user, appUrl } = session.data;
  if (user === null) {
    return (
      <a href={signInHref()} className={buttonClass("primary")}>
        Sign in
      </a>
    );
  }
  return <SignedInMenu user={user} appUrl={appUrl} />;
}

function SignedInMenu({ user, appUrl }: { user: SessionUser; appUrl: string }) {
  const name = accountName(user);
  const items = useAccountMenuItems(user, appUrl);
  return (
    <div className="flex items-center gap-2">
      <ButtonLink href={paths.newRepository()} aria-label="New repository">
        <Icon name="plus" />
        <span className="hidden sm:inline">New</span>
      </ButtonLink>
      <Menu
        label="Account"
        align="end"
        header={
          <>
            <span className="block font-medium text-on-surface">{name}</span>
            {user.username !== null ? <span className="block">{user.username}</span> : null}
          </>
        }
        trigger={({ props }) => (
          <button
            {...props}
            type="button"
            aria-haspopup="menu"
            aria-label={`Account menu for ${name}`}
            className="flex items-center gap-1 rounded-full p-0.5 hover:bg-surface-sunken"
          >
            <Avatar name={name} src={user.avatarUrl} size={24} />
            <Icon name="chevronDown" size={12} className="text-on-surface-muted" />
          </button>
        )}
        items={items}
      />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface text-on-surface">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface-raised focus:px-3 focus:py-1.5 focus:text-xs"
      >
        Skip to content
      </a>
      <header className="surface-sidebar sticky top-0 z-40 border-b border-border bg-surface">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center gap-4 px-4">
          <AppLink
            href={paths.home()}
            aria-label="Infrawrench Git, home"
            className="flex items-center gap-2 text-sm font-semibold text-on-surface"
          >
            <BrandMark />
            <span>Git</span>
          </AppLink>
          <nav aria-label="Site" className="flex items-center gap-1 text-xs">
            <AppLink
              href={paths.explore()}
              className="rounded px-2 py-1 text-on-surface-secondary hover:bg-surface-sunken hover:text-on-surface"
            >
              Explore
            </AppLink>
          </nav>
          <div className="flex-1" />
          <TopSearch />
          <UserMenu />
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
