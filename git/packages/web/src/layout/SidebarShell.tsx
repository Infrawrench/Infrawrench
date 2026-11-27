/**
 * The frame of every page: a sidebar the height of the window beside the
 * page, which has a bar of its own.
 *
 * - Someone signed in with a username: the workspace, Home, their work
 *   (Changes, Reviews, Mentions), the selected workspace's repositories with
 *   a mark on the ones an agent is working in, and themselves at the foot.
 * - Anyone else (signed out, or still choosing a username): the site's name,
 *   Explore, the repository being read and its namespace, and Sign in (or
 *   the account menu) at the foot.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { SessionUser } from "@infrawrench/git-contract";
import { api } from "../api/client";
import { queries } from "../api/queries";
import { AppLink } from "../components/AppLink";
import { Badge } from "../components/Badge";
import { buttonClass } from "../components/Button";
import { Icon, type IconName } from "../components/icons";
import { Menu } from "../components/Menu";
import { Avatar } from "../components/people";
import { paths } from "../lib/paths";
import { signInHref, type SessionData } from "../lib/session";
import { accountName, useAccountMenuItems } from "./account-menu";
import { BarTitle, useBarSlot } from "./TopBar";
import { type Workspace, useStoredFlag, useWorkspaces, workspaceOwning } from "./workspace";

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

const itemClass = (active: boolean): string =>
  `flex h-8 items-center gap-2.5 rounded-md px-2 text-sm ${
    active
      ? "bg-accent-muted font-medium text-accent-on-muted"
      : "text-on-surface hover:bg-surface-sunken"
  }`;

function NavItem({
  href,
  icon,
  active,
  children,
}: {
  href: string;
  icon: IconName;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <li>
      <AppLink href={href} aria-current={active ? "page" : undefined} className={itemClass(active)}>
        <Icon
          name={icon}
          size={16}
          className={active ? "text-accent-on-muted" : "text-on-surface-muted"}
        />
        <span className="truncate">{children}</span>
      </AppLink>
    </li>
  );
}

/** A titled part of the sidebar that folds to its title. */
function Group({
  id,
  title,
  initiallyOpen,
  holdsCurrent = false,
  children,
}: {
  id: string;
  title: string;
  initiallyOpen: boolean;
  /** The page shown is in it: it is open whatever was remembered. */
  holdsCurrent?: boolean;
  children: ReactNode;
}) {
  const [stored, setOpen] = useStoredFlag(`git-sidebar:${id}`, initiallyOpen);
  const open = stored || holdsCurrent;
  const panel = `sidebar-${id}`;
  return (
    <div className="mt-5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        aria-label={title}
        onClick={() => setOpen(!open)}
        className="flex h-7 w-full min-w-0 items-center gap-1 rounded-md px-2 text-xs text-on-surface-muted hover:text-on-surface"
      >
        <span className="truncate">{title}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
      </button>
      {open ? (
        <ul id={panel} className="mt-0.5 space-y-px">
          {children}
        </ul>
      ) : null}
    </div>
  );
}

/** A titled part of the sidebar that does not fold: the workspace's repositories. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId();
  return (
    <div className="mt-5">
      <h2
        id={heading}
        title={title}
        className="flex h-7 items-center px-2 text-xs font-normal text-on-surface-muted"
      >
        <span className="truncate">{title}</span>
      </h2>
      <ul aria-labelledby={heading} className="mt-0.5 space-y-px">
        {children}
      </ul>
    </div>
  );
}

/** How many of each a selected repository lists under its name. */
const RECENT_COUNT = 5;

/** One folding list under the selected repository: a small heading and up to five links. */
function RecentList({
  id,
  title,
  items,
  loading,
  empty,
}: {
  id: string;
  title: string;
  items: ReadonlyArray<{ key: string; href: string; label: string; active: boolean }>;
  loading: boolean;
  empty: string;
}) {
  const [open, setOpen] = useStoredFlag(`git-sidebar:recent:${id}`, true);
  const panel = useId();
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="flex h-6 w-full min-w-0 items-center gap-1 rounded-md pl-9 pr-2 text-xs text-on-surface-muted hover:text-on-surface"
      >
        <span className="truncate">{title}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {open ? (
        <ul id={panel} className="space-y-px">
          {loading ? (
            <li className="pl-9 pr-2 py-1 text-xs text-on-surface-faint">Loading</li>
          ) : items.length === 0 ? (
            <li className="pl-9 pr-2 py-1 text-xs text-on-surface-faint">{empty}</li>
          ) : (
            items.map((item) => (
              <li key={item.key}>
                <AppLink
                  href={item.href}
                  aria-current={item.active ? "page" : undefined}
                  title={item.label}
                  className={`flex h-7 min-w-0 items-center rounded-md pl-9 pr-2 text-[13px] ${
                    item.active
                      ? "bg-accent-muted font-medium text-accent-on-muted"
                      : "text-on-surface-secondary hover:bg-surface-sunken hover:text-on-surface"
                  }`}
                >
                  <span className="truncate">{item.label}</span>
                </AppLink>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

/** Under the selected repository: its recently updated issues and branches. */
function RepositoryRecent({ owner, name }: { owner: string; name: string }) {
  const { pathname } = useLocation();
  const repo = { owner, repo: name };
  const recent = { sort: "updated", direction: "desc", limit: RECENT_COUNT } as const;
  const issues = useQuery({
    ...queries.issues.list({ params: repo, query: { ...recent, state: "open" } }),
    staleTime: 30_000,
  });
  const branches = useQuery({
    ...queries.branches.list({ params: repo, query: { ...recent, state: "all" } }),
    staleTime: 30_000,
  });
  return (
    <ul aria-label={`Recent in ${name}`} className="mt-0.5 space-y-px">
      <RecentList
        id="issues"
        title="Recent issues"
        loading={issues.isPending}
        empty="No open issues"
        items={(issues.data?.items ?? []).map((issue) => {
          const href = paths.issue(repo, issue.number);
          return { key: href, href, label: issue.title, active: pathname === href };
        })}
      />
      <RecentList
        id="branches"
        title="Recently edited branches"
        loading={branches.isPending}
        empty="No branches yet"
        items={(branches.data?.items ?? []).map((page) => {
          const href = paths.branchPage(repo, page.key);
          return {
            key: href,
            href,
            label: page.title !== "" ? page.title : page.headRef,
            active: pathname === href || pathname.startsWith(`${href}/`),
          };
        })}
      />
    </ul>
  );
}

/** A repository in the sidebar: its name, a mark while an agent works in it, a lock when private. */
function RepositoryItem({
  owner,
  name,
  visibility,
  active,
  working = false,
}: {
  owner: string;
  name: string;
  visibility: "public" | "private";
  active: boolean;
  working?: boolean;
}) {
  return (
    <li>
      <AppLink
        href={paths.repo({ owner, repo: name })}
        aria-current={active ? "page" : undefined}
        className={itemClass(active)}
      >
        <Avatar name={name} size={18} square />
        <span className="truncate">{name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {working ? (
            // Beside the name, not part of it: the link is still named by the repository.
            <span
              aria-hidden="true"
              data-agent-working
              title="An agent is working"
              className="inline-flex text-notice"
            >
              <Icon name="bot" size={12} />
            </span>
          ) : null}
          {visibility === "private" ? (
            <Icon name="lock" size={11} className="text-on-surface-faint" />
          ) : null}
        </span>
      </AppLink>
      {active ? <RepositoryRecent owner={owner} name={name} /> : null}
    </li>
  );
}

function WorkspaceSwitcher({
  workspaces,
  current,
  select,
  unclaimed,
}: {
  workspaces: ReadonlyArray<Workspace>;
  current: Workspace | null;
  select: (slug: string) => void;
  /** An organisation of the reader's that they can give a name here. */
  unclaimed: boolean;
}) {
  return (
    <Menu
      label="Workspace"
      className="w-56"
      rootClassName="min-w-0"
      trigger={({ props }) => (
        <button
          {...props}
          type="button"
          aria-haspopup="menu"
          aria-label={`Workspace: ${current?.name ?? "none"}`}
          className="flex h-8 max-w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-sm font-medium text-on-surface hover:bg-surface-sunken"
        >
          <span className="shrink-0">
            <BrandMark size={20} />
          </span>
          <span className="truncate">{current?.name ?? "Git"}</span>
          <Icon name="chevronsUpDown" size={13} className="shrink-0 text-on-surface-muted" />
        </button>
      )}
      items={[
        ...workspaces.map((workspace) => ({
          label: workspace.name,
          checked: workspace.slug === current?.slug,
          onSelect: () => select(workspace.slug),
          icon: (
            <Avatar
              name={workspace.name}
              src={workspace.avatarUrl}
              size={16}
              square={workspace.kind === "org"}
            />
          ),
        })),
        ...(current !== null
          ? [
              {
                label: `Open ${current.slug}`,
                href: paths.namespace(current.slug),
                icon: <Icon name={current.kind === "org" ? "building" : "user"} />,
                separated: true,
              },
            ]
          : []),
        {
          label: "New repository",
          href: paths.newRepository(current?.slug),
          icon: <Icon name="plus" />,
          separated: current === null,
        },
        ...(unclaimed
          ? [
              {
                label: "Add an organisation",
                href: paths.settings("organisations"),
                icon: <Icon name="building" />,
              },
            ]
          : []),
        { label: "Explore", href: paths.explore(), icon: <Icon name="globe" /> },
      ]}
    />
  );
}

function AccountButton({ user, appUrl }: { user: SessionUser; appUrl: string }) {
  const name = accountName(user);
  const items = useAccountMenuItems(user, appUrl);
  return (
    <Menu
      label="Account"
      side="top"
      className="w-56"
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
          className="flex h-9 max-w-full items-center gap-2 rounded-md px-1.5 text-sm text-on-surface hover:bg-surface-sunken"
        >
          <Avatar name={name} src={user.avatarUrl} size={22} />
          <span className="truncate">{user.displayName?.split(" ")[0] ?? name}</span>
          <Icon name="chevronsUpDown" size={13} className="text-on-surface-muted" />
        </button>
      )}
      items={items}
    />
  );
}

/**
 * The repositories an agent is working in now, by id: the open branches in
 * `agent_working`. Asked again every half minute while the sidebar is shown.
 */
function useAgentRepositories(): ReadonlySet<string> {
  const open = useQuery({
    queryKey: ["workspace", "changes", "sidebar-agents"],
    queryFn: () => api.workspace.changes({ query: { state: "open", limit: 100 } }),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
  return new Set(
    (open.data?.items ?? [])
      .filter((change) => change.state === "agent_working")
      .map((change) => change.repository.id),
  );
}

/** The first two segments of a page under a repository, or null for a page of the site. */
const NOT_A_NAMESPACE = new Set(["settings", "onboarding"]);
function repositoryOf(pathname: string): { owner: string; repo: string } | null {
  const [owner, repo] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (owner === undefined || repo === undefined || NOT_A_NAMESPACE.has(owner)) return null;
  return { owner, repo };
}

const isIn = (pathname: string, owner: string, name: string): boolean => {
  const here = repositoryOf(pathname);
  return (
    here !== null &&
    here.owner.toLowerCase() === owner.toLowerCase() &&
    here.repo.toLowerCase() === name.toLowerCase()
  );
};

function SearchLink() {
  return (
    <AppLink
      href={paths.explore()}
      aria-label="Search repositories"
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
    >
      <Icon name="search" size={16} />
    </AppLink>
  );
}

/** The sidebar of someone signed in with a name to work under. */
function MemberSidebar({
  user,
  appUrl,
  unclaimed,
}: {
  user: SessionUser;
  appUrl: string;
  unclaimed: boolean;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { workspaces, current: chosen, select } = useWorkspaces();
  const working = useAgentRepositories();
  const here = repositoryOf(pathname);
  // A repository of another of the reader's workspaces: the sidebar is that workspace's.
  const owning = here !== null ? workspaceOwning(workspaces ?? [], here.owner) : null;
  const current = owning ?? chosen;
  const follow = owning !== null && owning.slug !== chosen?.slug ? owning.slug : null;
  useEffect(() => {
    if (follow !== null) select(follow);
  }, [follow, select]);
  // Somebody else's repository: shown above the list, from the cache its layout fills.
  const foreign = here !== null && workspaces !== undefined && owning === null;
  const viewed = useQuery({
    ...queries.repositories.get({ params: here ?? { owner: "", repo: "" } }),
    enabled: foreign,
    retry: false,
  });
  const viewing = foreign ? viewed.data : undefined;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-1 px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <WorkspaceSwitcher
            workspaces={workspaces ?? []}
            current={current}
            select={select}
            unclaimed={unclaimed}
          />
          <Badge tone="outline" className="shrink-0">
            Beta
          </Badge>
        </div>
        <SearchLink />
      </div>
      <nav aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        <ul className="mt-1">
          <NavItem href={paths.home()} icon="home" active={pathname === "/"}>
            Home
          </NavItem>
        </ul>
        <Group id="work" title="Your work" initiallyOpen>
          <NavItem href={paths.changes()} icon="fileDiff" active={pathname === "/changes"}>
            Changes
          </NavItem>
          <NavItem href={paths.reviews()} icon="messageCircle" active={pathname === "/reviews"}>
            Reviews
          </NavItem>
          <NavItem href={paths.mentions()} icon="atSign" active={pathname === "/mentions"}>
            Mentions
          </NavItem>
        </Group>
        {viewing !== undefined ? (
          <Section title="Viewing">
            <RepositoryItem
              owner={viewing.owner.slug}
              name={viewing.name}
              visibility={viewing.visibility}
              active
            />
          </Section>
        ) : null}
        {current !== null ? (
          <Section title={current.name}>
            {current.repositories.length === 0 ? (
              <>
                <li className="px-2 py-1 text-xs text-on-surface-muted">No repositories</li>
                <NavItem href={paths.newRepository(current.slug)} icon="plus" active={false}>
                  New repository
                </NavItem>
              </>
            ) : (
              current.repositories.map((repository) => (
                <RepositoryItem
                  key={repository.id}
                  owner={repository.owner.slug}
                  name={repository.name}
                  visibility={repository.visibility}
                  active={isIn(pathname, repository.owner.slug, repository.name)}
                  working={working.has(repository.id)}
                />
              ))
            )}
          </Section>
        ) : null}
      </nav>
      <div className="shrink-0 px-2.5 py-2">
        <AccountButton user={user} appUrl={appUrl} />
      </div>
    </div>
  );
}

/**
 * The sidebar of a reader with nothing of their own here: the site, Explore,
 * the repository they are reading and its namespace, and the way in.
 */
function VisitorSidebar({ user, appUrl }: { user: SessionUser | null; appUrl: string }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const here = repositoryOf(pathname);
  // The repository's layout asks for the same thing: this is its answer from the cache.
  const repository = useQuery({
    ...queries.repositories.get({ params: here ?? { owner: "", repo: "" } }),
    enabled: here !== null,
    retry: false,
  });
  const shown = here !== null ? repository.data : undefined;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-1 px-2.5">
        <AppLink
          href={paths.home()}
          aria-label="Infrawrench Git, home"
          className="flex h-8 items-center gap-2 rounded-md px-1.5 text-sm font-semibold text-on-surface hover:bg-surface-sunken"
        >
          <BrandMark size={20} />
          <span>Git</span>
          <Badge tone="outline" className="shrink-0">
            Beta
          </Badge>
        </AppLink>
        <SearchLink />
      </div>
      <nav aria-label="Site" className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        <ul className="mt-1">
          <NavItem href={paths.explore()} icon="globe" active={pathname === "/explore"}>
            Explore
          </NavItem>
        </ul>
        {shown !== undefined ? (
          <Group
            id={`visit:${shown.owner.slug}`}
            title={shown.owner.displayName ?? shown.owner.slug}
            initiallyOpen
            holdsCurrent
          >
            <RepositoryItem
              owner={shown.owner.slug}
              name={shown.name}
              visibility={shown.visibility}
              active
            />
          </Group>
        ) : null}
      </nav>
      <div className="shrink-0 px-2.5 py-2">
        {user === null ? (
          <a href={signInHref()} className={`${buttonClass("primary")} w-full justify-center`}>
            Sign in
          </a>
        ) : (
          <AccountButton user={user} appUrl={appUrl} />
        )}
      </div>
    </div>
  );
}

/** What the bar says on a page that does not say it itself: where the page is. */
function Place() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [first, second] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (first === undefined) return <BarTitle>Home</BarTitle>;
  if (first === "settings") return <BarTitle>Settings</BarTitle>;
  if (first === "explore") return <BarTitle>Explore</BarTitle>;
  if (first === "new") return <BarTitle>New repository</BarTitle>;
  if (first === "onboarding") return <BarTitle>Choose a username</BarTitle>;
  if (second === undefined) return <BarTitle>{first}</BarTitle>;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      <AppLink href={paths.namespace(first)} className="text-on-surface-muted hover:underline">
        {first}
      </AppLink>
      <span aria-hidden="true" className="text-on-surface-faint">
        /
      </span>
      <AppLink
        href={paths.repo({ owner: first, repo: second })}
        className="truncate font-medium text-on-surface hover:underline"
      >
        {second}
      </AppLink>
    </nav>
  );
}

export function SidebarShell({ session, children }: { session: SessionData; children: ReactNode }) {
  const bar = useBarSlot();
  const pathname = useLocation({ select: (location) => location.pathname });
  // On a narrow window the sidebar is a drawer; going somewhere closes it.
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [pathname]);
  const user = session.user;
  const member = user !== null && user.username !== null;
  return (
    <div className="flex min-h-screen bg-surface-raised text-on-surface">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface-raised focus:px-3 focus:py-1.5 focus:text-xs"
      >
        Skip to content
      </a>
      {drawer ? (
        <button
          type="button"
          aria-label="Close the sidebar"
          onClick={() => setDrawer(false)}
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
        />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-60 border-r border-border bg-surface md:sticky md:top-0 md:z-auto md:h-screen md:shrink-0 ${
          drawer ? "block" : "hidden md:block"
        }`}
      >
        {member ? (
          <MemberSidebar
            user={user}
            appUrl={session.appUrl}
            unclaimed={session.organizations.some((organization) => organization.canClaimNamespace)}
          />
        ) : (
          <VisitorSidebar user={user} appUrl={session.appUrl} />
        )}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Below `sm` the bar is a grid: the menu, where the page is and what it
            keeps beside that, then a second row for a page's sections or filters. */}
        <header className="sticky top-0 z-30 grid min-h-12 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1.5 border-b border-border bg-surface-raised px-4 py-2 sm:flex sm:h-12 sm:py-0 md:px-10">
          <button
            type="button"
            aria-label="Open the sidebar"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
            className="-ml-1.5 flex size-8 items-center justify-center rounded-md text-on-surface-muted hover:bg-surface-sunken md:hidden"
          >
            <Icon name="menu" size={16} />
          </button>
          <div ref={bar.mount} className="contents" />
          {bar.claimed ? null : <Place />}
        </header>
        <main id="main" className="min-w-0 flex-1">
          {bar.provider(children)}
        </main>
      </div>
    </div>
  );
}
