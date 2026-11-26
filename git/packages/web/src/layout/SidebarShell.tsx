/**
 * The frame of someone signed in: a sidebar the height of the window beside
 * the page, which has a bar of its own. What the sidebar holds follows the
 * reader's mode.
 *
 * - Agent mode: the workspace, Home, their work (Changes, Reviews,
 *   Mentions), each namespace's repositories with a mark on the ones an
 *   agent is working in, and themselves at the foot.
 * - Classic: Home, their pull requests and issues by the part they have in
 *   them, Explore, each namespace's repositories with how many there are and
 *   a way to add one, and themselves at the foot.
 *
 * Signed-out readers keep `AppShell`.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReviewMode, SessionUser } from "@infrawrench/git-contract";
import { api } from "../api/client";
import { AppLink } from "../components/AppLink";
import { ButtonLink } from "../components/Button";
import { Icon, type IconName } from "../components/icons";
import { Menu } from "../components/Menu";
import { Avatar } from "../components/people";
import { paths } from "../lib/paths";
import { SidebarShellContext } from "../lib/shell";
import { BrandMark, TopSearch } from "./AppShell";
import { accountName, useAccountMenuItems } from "./account-menu";
import { BarTitle, useBarSlot } from "./TopBar";
import { type Workspace, useStoredFlag, useWorkspaces } from "./workspace";

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
  count,
  action,
  children,
}: {
  id: string;
  title: string;
  initiallyOpen: boolean;
  /** How many it holds, said beside its title. */
  count?: number;
  /** A control at the end of its title row. */
  action?: ReactNode;
  /** The page shown is in it: it is open whatever was remembered. */
  holdsCurrent?: boolean;
  children: ReactNode;
}) {
  const [stored, setOpen] = useStoredFlag(`git-sidebar:${id}`, initiallyOpen);
  const open = stored || holdsCurrent;
  const panel = `sidebar-${id}`;
  return (
    <div className="mt-5">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          aria-label={title}
          onClick={() => setOpen(!open)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-xs text-on-surface-muted hover:text-on-surface"
        >
          <span className="truncate">{title}</span>
          {count !== undefined ? (
            <span className="text-on-surface-faint tabular-nums">{count}</span>
          ) : null}
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
        </button>
        {action}
      </div>
      {open ? (
        <ul id={panel} className="mt-0.5 space-y-px">
          {children}
        </ul>
      ) : null}
    </div>
  );
}

function WorkspaceSwitcher({
  workspaces,
  current,
  select,
}: {
  workspaces: ReadonlyArray<Workspace>;
  current: Workspace | null;
  select: (slug: string) => void;
}) {
  return (
    <Menu
      label="Workspace"
      className="w-56"
      trigger={({ props }) => (
        <button
          {...props}
          type="button"
          aria-haspopup="menu"
          aria-label={`Workspace: ${current?.name ?? "none"}`}
          className="flex h-8 min-w-0 items-center gap-2 rounded-md px-1.5 text-sm font-medium text-on-surface hover:bg-surface-sunken"
        >
          <BrandMark size={20} />
          <span className="truncate">{current?.name ?? "Git"}</span>
          <Icon name="chevronsUpDown" size={13} className="text-on-surface-muted" />
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
function useAgentRepositories(enabled: boolean): ReadonlySet<string> {
  const open = useQuery({
    queryKey: ["workspace", "changes", "sidebar-agents"],
    queryFn: () => api.workspace.changes({ query: { state: "open", limit: 100 } }),
    enabled,
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

function Sidebar({ user, appUrl, mode }: { user: SessionUser; appUrl: string; mode: ReviewMode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const view = new URLSearchParams(searchStr).get("view");
  const { workspaces, current, select } = useWorkspaces();
  const agent = mode === "agent";
  const working = useAgentRepositories(agent);
  const inRepository = (owner: string, name: string) => {
    const [first, second] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return (
      first?.toLowerCase() === owner.toLowerCase() && second?.toLowerCase() === name.toLowerCase()
    );
  };
  // The current workspace's repositories first, open; the others folded.
  const ordered = [...(workspaces ?? [])].sort(
    (a, b) => Number(b.slug === current?.slug) - Number(a.slug === current?.slug),
  );
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center justify-between gap-1 px-2.5">
        {agent ? (
          <WorkspaceSwitcher workspaces={workspaces ?? []} current={current} select={select} />
        ) : (
          <AppLink
            href={paths.home()}
            aria-label="Infrawrench Git, home"
            className="flex h-8 items-center gap-2 rounded-md px-1.5 text-sm font-semibold text-on-surface hover:bg-surface-sunken"
          >
            <BrandMark size={20} />
            <span>Git</span>
          </AppLink>
        )}
        <AppLink
          href={paths.explore()}
          aria-label="Search repositories"
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
        >
          <Icon name="search" size={16} />
        </AppLink>
      </div>
      <nav
        aria-label={agent ? "Workspace" : "Site"}
        className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4"
      >
        <ul className="mt-1">
          <NavItem href={paths.home()} icon="home" active={pathname === "/"}>
            Home
          </NavItem>
        </ul>
        {agent ? (
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
        ) : (
          <>
            <Group id="pulls" title="Pull requests" initiallyOpen>
              <NavItem
                href={paths.myPulls()}
                icon="gitPullRequest"
                active={pathname === "/pulls" && (view === null || view === "created")}
              >
                Created
              </NavItem>
              <NavItem
                href={paths.myPulls({ view: "review" })}
                icon="eye"
                active={pathname === "/pulls" && view === "review"}
              >
                Review requested
              </NavItem>
              <NavItem
                href={paths.myPulls({ view: "assigned" })}
                icon="user"
                active={pathname === "/pulls" && view === "assigned"}
              >
                Assigned
              </NavItem>
            </Group>
            <Group id="issues" title="Issues" initiallyOpen>
              <NavItem
                href={paths.myIssues()}
                icon="user"
                active={pathname === "/issues" && (view === null || view === "assigned")}
              >
                Assigned
              </NavItem>
              <NavItem
                href={paths.myIssues({ view: "created" })}
                icon="circleDot"
                active={pathname === "/issues" && view === "created"}
              >
                Created
              </NavItem>
              <NavItem
                href={paths.myIssues({ view: "mentioned" })}
                icon="atSign"
                active={pathname === "/issues" && view === "mentioned"}
              >
                Mentioned
              </NavItem>
            </Group>
            <ul className="mt-5">
              <NavItem href={paths.explore()} icon="globe" active={pathname === "/explore"}>
                Explore
              </NavItem>
            </ul>
          </>
        )}
        {ordered.map((workspace) => (
          <Group
            key={workspace.slug}
            id={`ns:${workspace.slug}`}
            title={workspace.name}
            initiallyOpen={workspace.slug === current?.slug}
            holdsCurrent={workspace.repositories.some((repository) =>
              inRepository(repository.owner.slug, repository.name),
            )}
            {...(agent
              ? {}
              : {
                  count: workspace.repositories.length,
                  action: (
                    <AppLink
                      href={paths.newRepository(workspace.slug)}
                      aria-label={`New repository in ${workspace.name}`}
                      title="New repository"
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
                    >
                      <Icon name="plus" size={13} />
                    </AppLink>
                  ),
                })}
          >
            {workspace.repositories.length === 0 ? (
              <li className="px-2 py-1 text-xs text-on-surface-muted">No repositories</li>
            ) : (
              workspace.repositories.map((repository) => {
                const active = inRepository(repository.owner.slug, repository.name);
                return (
                  <li key={repository.id}>
                    <AppLink
                      href={paths.repo({ owner: repository.owner.slug, repo: repository.name })}
                      aria-current={active ? "page" : undefined}
                      className={itemClass(active)}
                    >
                      <Avatar name={repository.name} size={18} square />
                      <span className="truncate">{repository.name}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {working.has(repository.id) ? (
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
                        {repository.visibility === "private" ? (
                          <Icon name="lock" size={11} className="text-on-surface-faint" />
                        ) : null}
                      </span>
                    </AppLink>
                  </li>
                );
              })
            )}
          </Group>
        ))}
      </nav>
      <div className="shrink-0 px-2.5 py-2">
        <AccountButton user={user} appUrl={appUrl} />
      </div>
    </div>
  );
}

/**
 * What the bar says on a page that does not say it itself: where the page
 * is. In classic a repository's page says that in its own header, so the bar
 * there is the search and the way to a new repository.
 */
function DefaultBar({ mode }: { mode: ReviewMode }) {
  const place = <Place classic={mode === "classic"} />;
  if (mode === "agent") return place;
  return (
    <>
      {place}
      <div className="flex-1" />
      <TopSearch />
      <ButtonLink href={paths.newRepository()} aria-label="New repository">
        <Icon name="plus" />
        <span className="hidden sm:inline">New</span>
      </ButtonLink>
    </>
  );
}

function Place({ classic }: { classic: boolean }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [first, second] = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (first === undefined) return <BarTitle>Home</BarTitle>;
  if (first === "settings") return <BarTitle>Settings</BarTitle>;
  if (first === "explore") return <BarTitle>Explore</BarTitle>;
  if (first === "new") return <BarTitle>New repository</BarTitle>;
  if (second === undefined) return <BarTitle>{first}</BarTitle>;
  if (classic) return null;
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

export function SidebarShell({
  user,
  appUrl,
  mode,
  children,
}: {
  user: SessionUser;
  appUrl: string;
  /** What the sidebar holds, and how the pages beside it are drawn. */
  mode: ReviewMode;
  children: ReactNode;
}) {
  const bar = useBarSlot();
  const pathname = useLocation({ select: (location) => location.pathname });
  // On a narrow window the sidebar is a drawer; going somewhere closes it.
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [pathname]);
  return (
    <div
      className={`flex min-h-screen text-on-surface ${mode === "agent" ? "bg-surface-raised" : "bg-surface"}`}
    >
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
        <Sidebar user={user} appUrl={appUrl} mode={mode} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={`sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 md:px-10 ${
            mode === "agent" ? "bg-surface-raised" : "bg-surface"
          }`}
        >
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
          {bar.claimed ? null : <DefaultBar mode={mode} />}
        </header>
        <main id="main" className="min-w-0 flex-1">
          {/* Classic pages are drawn as they are under the top nav: only agent mode's take the shell's chrome. */}
          <SidebarShellContext.Provider value={mode === "agent"}>
            {bar.provider(children)}
          </SidebarShellContext.Provider>
        </main>
      </div>
    </div>
  );
}
