/**
 * The frame of every repository page: the header (owner / name, visibility,
 * star and fork) and the tab bar. The active tab comes from the route. In
 * the sidebar shell there is no header: the same things are in the shell's
 * bar (`RepoBarFrame`).
 *
 * Pages under it read the repository with `useRepository()` rather than
 * fetching it again.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { REPOSITORY_NAME_MAX_LENGTH, type Repository } from "@infrawrench/git-contract";
import { api } from "../api/client";
import { invalidate, queries, queryClient } from "../api/queries";
import { AppLink, useGo } from "../components/AppLink";
import { Badge, VisibilityBadge } from "../components/Badge";
import { Dialog, LinkTabs, QuietTabs, type LinkTab } from "../components/controls";
import { Field, Input, Select } from "../components/forms";
import { Icon } from "../components/icons";
import { useLocation } from "@tanstack/react-router";
import { Page } from "../components/Panel";
import { ErrorState, InlineError, Loading, Skeleton } from "../components/states";
import { CodePageSkeleton } from "../features/code/CodePageSkeleton";
import { compactCount } from "../lib/format";
import { mayUseName, useNewNameAvailability } from "../lib/name-availability";
import { ownersOf, type Owner } from "../lib/owners";
import { paths, type RepoRef } from "../lib/paths";
import { formatHead } from "../lib/refs";
import { signInHref, useSession } from "../lib/session";
import { pageColumn, useSidebarShell } from "../lib/shell";
import { BarPortal } from "./TopBar";
import { isNotFound } from "../api/client";
import { Button, buttonClass } from "../components/Button";

const RepositoryContext = createContext<Repository | null>(null);

/** The repository of the current page. Only under the repository layout. */
export function useRepository(): Repository {
  const repository = useContext(RepositoryContext);
  if (repository === null) throw new Error("useRepository outside the repository layout");
  return repository;
}

/** `{ owner, repo }` of the current page, as the API and `paths` take it. */
export function useRepoRef(): RepoRef {
  const repository = useRepository();
  return { owner: repository.owner.slug, repo: repository.name };
}

/** The first path segments that belong to the Code tab. */
const CODE_SECTIONS = new Set([
  "",
  "tree",
  "blob",
  "blame",
  "commits",
  "commit",
  "branches",
  "tags",
  "compare",
]);

/** The page's section: the path segment after `/:owner/:repo`. */
export function repoSection(pathname: string): string {
  return pathname.split("/").filter(Boolean)[2] ?? "";
}

/**
 * A repository's sections. In the sidebar shell its pull requests are its
 * branches: each opens as a branch page there.
 */
function tabsFor(repository: Repository, repo: RepoRef, sidebar = false): LinkTab[] {
  const section = (name: string) => (pathname: string) => repoSection(pathname) === name;
  const tabs: LinkTab[] = [
    {
      label: "Code",
      href: paths.repo(repo),
      icon: <Icon name="code" />,
      match: (pathname) => CODE_SECTIONS.has(repoSection(pathname)),
    },
  ];
  if (repository.features.issues) {
    tabs.push({
      label: "Issues",
      href: paths.issues(repo),
      icon: <Icon name="circleDot" />,
      count: repository.openIssueCount,
      match: section("issues"),
    });
  }
  if (repository.features.pullRequests) {
    tabs.push({
      label: sidebar ? "Branches" : "Pull requests",
      href: paths.pulls(repo),
      icon: <Icon name={sidebar ? "gitBranch" : "gitPullRequest"} />,
      count: repository.openPullRequestCount,
      match: section("pulls"),
    });
  }
  tabs.push({
    label: "CI",
    href: paths.ci(repo),
    icon: <Icon name="listChecks" />,
    match: section("ci"),
  });
  if (repository.hasTerraform || repository.viewer.canAdminister) {
    tabs.push({
      label: "Infrastructure",
      href: paths.infrastructure(repo),
      icon: <Icon name="boxes" />,
      match: section("infrastructure"),
    });
  }
  if (repository.viewer.canAdminister) {
    tabs.push({
      label: "Settings",
      href: paths.repoSettings(repo),
      icon: <Icon name="settings" />,
      match: section("settings"),
    });
  }
  return tabs;
}

const countButton =
  "inline-flex items-center gap-1.5 border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-on-surface";
/** The same control in the sidebar shell's bar: its glyph and its count, no frame. */
const quietButton =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-on-surface-muted tabular-nums hover:bg-surface-sunken hover:text-on-surface disabled:opacity-60";

interface RepoControl {
  repository: Repository;
  repo: RepoRef;
  /** In the sidebar shell's bar. */
  quiet?: boolean;
}

function StarButton({ repository, repo, quiet = false }: RepoControl) {
  const session = useSession();
  const signedIn = session.data?.user != null;
  const starred = repository.viewer.hasStarred;
  const toggle = useMutation({
    mutationFn: () =>
      starred ? api.repositories.unstar({ params: repo }) : api.repositories.star({ params: repo }),
    onSuccess: () => {
      // Show the new state at once; the refetch then confirms the count.
      queryClient.setQueryData<Repository>(
        queries.repositories.get({ params: repo }).queryKey,
        (current) =>
          current && {
            ...current,
            starCount: current.starCount + (starred ? -1 : 1),
            viewerHasStarred: !starred,
            viewer: { ...current.viewer, hasStarred: !starred },
          },
      );
      void invalidate("repositoryLists");
    },
  });
  const count = (
    <span
      className={`${countButton} rounded-r border-l-0 font-normal text-on-surface-secondary`}
      aria-label={`${repository.starCount} stars`}
    >
      {compactCount(repository.starCount)}
    </span>
  );
  if (quiet) {
    const body = (
      <>
        <Icon name="star" filled={starred} className={starred ? "text-warning" : ""} />
        <span className="sr-only">{starred ? "Starred" : "Star"}</span>
        <span aria-label={`${repository.starCount} stars`}>
          {compactCount(repository.starCount)}
        </span>
      </>
    );
    return signedIn ? (
      <button
        type="button"
        aria-pressed={starred}
        title={starred ? "Starred" : "Star"}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate()}
        className={quietButton}
      >
        {body}
      </button>
    ) : (
      <a href={signInHref()} title="Star" className={quietButton}>
        {body}
      </a>
    );
  }
  if (!signedIn) {
    return (
      <div className="flex">
        <a href={signInHref()} className={`${countButton} rounded-l hover:bg-surface-sunken`}>
          <Icon name="star" />
          Star
        </a>
        {count}
      </div>
    );
  }
  return (
    <div className="flex">
      <button
        type="button"
        aria-pressed={starred}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate()}
        className={`${countButton} rounded-l hover:bg-surface-sunken disabled:opacity-60`}
      >
        <Icon name="star" filled={starred} className={starred ? "text-warning" : ""} />
        {starred ? "Starred" : "Star"}
      </button>
      {count}
    </div>
  );
}

/**
 * Where a fork of the repository can go: the namespaces the person can create
 * in. A private repository's fork stays in its owner's namespace, and one
 * more private repository has to fit the plan there.
 */
export function forkTargets(
  repository: Pick<Repository, "owner" | "visibility">,
  owners: ReadonlyArray<Owner>,
): Array<Owner & { readonly refusal: string | null }> {
  const isPrivate = repository.visibility === "private";
  return owners
    .filter(
      (owner) => !isPrivate || owner.slug.toLowerCase() === repository.owner.slug.toLowerCase(),
    )
    .map((owner) => ({ ...owner, refusal: isPrivate ? owner.privateRepositoryRefusal : null }));
}

/** Pick the namespace a fork goes to, and its name there. */
function ForkDialog({
  repository,
  repo,
  targets,
  onClose,
}: {
  repository: Repository;
  repo: RepoRef;
  targets: ReturnType<typeof forkTargets>;
  onClose: () => void;
}) {
  const go = useGo();
  const [ownerSlug, setOwnerSlug] = useState(
    (targets.find((target) => target.refusal === null) ?? targets[0])?.slug ?? "",
  );
  const [name, setName] = useState(repository.name);
  const owner = targets.find((target) => target.slug === ownerSlug);
  const availability = useNewNameAvailability(ownerSlug, name);
  const fork = useMutation({
    mutationFn: () => api.repositories.fork({ params: repo, payload: { owner: ownerSlug, name } }),
    onSuccess: (created) => {
      void invalidate("repositoryLists");
      void invalidate("repositories");
      go(paths.repo({ owner: created.owner.slug, repo: created.name }));
    },
  });
  const blocked =
    owner === undefined ||
    owner.refusal !== null ||
    !(mayUseName(availability) || availability.state === "checking");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!blocked) fork.mutate();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Fork ${repository.owner.slug}/${repository.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={fork.isPending}
            disabled={blocked}
            onClick={() => fork.mutate()}
          >
            Fork
          </Button>
        </>
      }
    >
      {targets.length === 0 ? (
        <p className="text-on-surface-muted">
          {repository.visibility === "private"
            ? `A private repository is forked within ${repository.owner.slug}, where you cannot create repositories`
            : "You have no namespace to fork into"}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <Field label="Owner" error={owner?.refusal ?? null}>
            {(control) => (
              <Select
                {...control}
                value={ownerSlug}
                onChange={(event) => {
                  setOwnerSlug(event.target.value);
                  if (fork.error) fork.reset();
                }}
              >
                {targets.map((target) => (
                  <option key={target.slug} value={target.slug}>
                    {target.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Name"
            error={
              availability.state === "taken" || availability.state === "invalid"
                ? availability.message
                : null
            }
          >
            {(control) => (
              <Input
                {...control}
                value={name}
                spellCheck={false}
                autoComplete="off"
                maxLength={REPOSITORY_NAME_MAX_LENGTH}
                onChange={(event) => {
                  setName(event.target.value);
                  if (fork.error) fork.reset();
                }}
              />
            )}
          </Field>
          <InlineError error={fork.error} />
        </form>
      )}
    </Dialog>
  );
}

function ForkButton({ repository, repo, quiet = false }: RepoControl) {
  const session = useSession();
  const user = session.data?.user ?? null;
  const [open, setOpen] = useState(false);
  const targets = session.data === undefined ? [] : forkTargets(repository, ownersOf(session.data));
  const count = (
    <span
      className={`${countButton} rounded-r border-l-0 font-normal text-on-surface-secondary`}
      aria-label={`${repository.forkCount} forks`}
    >
      {compactCount(repository.forkCount)}
    </span>
  );
  const dialog = open ? (
    <ForkDialog
      repository={repository}
      repo={repo}
      targets={targets}
      onClose={() => setOpen(false)}
    />
  ) : null;
  if (quiet) {
    const body = (
      <>
        <Icon name="gitFork" />
        <span className="sr-only">Fork</span>
        <span aria-label={`${repository.forkCount} forks`}>
          {compactCount(repository.forkCount)}
        </span>
      </>
    );
    return (
      <>
        {user === null ? (
          <a href={signInHref()} title="Fork" className={quietButton}>
            {body}
          </a>
        ) : (
          <button
            type="button"
            title="Fork"
            disabled={!repository.viewer.canFork || user.username === null}
            onClick={() => setOpen(true)}
            className={quietButton}
          >
            {body}
          </button>
        )}
        {dialog}
      </>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex">
        {user === null ? (
          <a href={signInHref()} className={`${countButton} rounded-l hover:bg-surface-sunken`}>
            <Icon name="gitFork" />
            Fork
          </a>
        ) : (
          <button
            type="button"
            disabled={!repository.viewer.canFork || user.username === null}
            onClick={() => setOpen(true)}
            className={`${countButton} rounded-l hover:bg-surface-sunken disabled:opacity-60`}
          >
            <Icon name="gitFork" />
            Fork
          </button>
        )}
        {count}
      </div>
      {dialog}
    </div>
  );
}

/**
 * A repository's page while the repository loads: its header band at the
 * height `RepoHeader` draws it (name, star and fork, the tabs), then the
 * outline of the tab being opened, so nothing moves when it arrives.
 */
function RepoSkeleton() {
  const { pathname } = useLocation();
  const section = pathname.split("/").filter(Boolean)[2];
  // In the sidebar shell the repository is named in the bar: there is no band.
  const sidebar = useSidebarShell();
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading repository</span>
      <div
        className={
          sidebar ? "hidden" : "h-[88px] overflow-hidden border-b border-border bg-surface-inset"
        }
        aria-hidden="true"
      >
        <div className="mx-auto w-full max-w-6xl px-4 pt-4">
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="h-[30px]" width={200} />
            <span className="flex gap-2">
              <Skeleton className="h-[30px]" width={112} />
              <Skeleton className="h-[30px]" width={94} />
            </span>
          </div>
          <div className="mt-4 flex gap-6">
            {[56, 72, 112, 32, 96, 72].map((width, index) => (
              <Skeleton key={index} className="h-4" width={width} />
            ))}
          </div>
        </div>
      </div>
      {section === undefined || section === "tree" ? (
        <CodePageSkeleton kind="table" root={section === undefined} />
      ) : section === "blob" || section === "blame" ? (
        <CodePageSkeleton kind="file" />
      ) : (
        <Page>
          <Loading />
        </Page>
      )}
    </div>
  );
}

/** Where a fork came from, and how it differs. Nothing for a repository that is not one. */
function ForkedFrom({
  repository,
  repo,
  className = "",
}: {
  repository: Repository;
  repo: RepoRef;
  className?: string;
}) {
  if (repository.parent === null) return null;
  const parent = { owner: repository.parent.owner, repo: repository.parent.name };
  return (
    <p className={`text-xs text-on-surface-muted ${className}`}>
      Forked from{" "}
      <AppLink href={paths.repo(parent)} className="text-on-surface-secondary hover:underline">
        {parent.owner}/{parent.repo}
      </AppLink>
      {repository.isEmpty ? null : (
        <>
          {" · "}
          <AppLink
            href={paths.compareHead(
              parent,
              formatHead(parent, { repository: repo, ref: repository.defaultBranch }),
            )}
            className="text-on-surface-secondary hover:underline"
          >
            Compare with it
          </AppLink>
        </>
      )}
    </p>
  );
}

interface RepoBarSlots {
  /** Where a page's own name goes, after the repository's. */
  readonly crumb: HTMLElement | null;
  /** Where a page's own controls go, before the repository's. */
  readonly actions: HTMLElement | null;
  /** Says a page names itself in the bar, until the returned function is called. */
  readonly nameIt: () => () => void;
}

const RepoBarContext = createContext<RepoBarSlots | null>(null);

/**
 * The page's name as the last part of the bar's breadcrumb, after the
 * repository: `acme / infra / Peer with the shared services VPC`. Nothing
 * outside the sidebar shell, where the page's own heading says it.
 */
export function RepoBarCrumb({ children }: { children: ReactNode }) {
  const slots = useContext(RepoBarContext);
  const nameIt = slots?.nameIt;
  useEffect(() => nameIt?.(), [nameIt]);
  if (slots === null || slots.crumb === null) return null;
  return createPortal(
    <>
      <span aria-hidden="true" className="shrink-0 text-on-surface-faint">
        /
      </span>
      <span aria-current="page" className="min-w-0 truncate font-medium text-on-surface">
        {children}
      </span>
    </>,
    slots.crumb,
  );
}

/** A page's own controls on the right of the bar. Nothing outside the sidebar shell. */
export function RepoBarActions({ children }: { children: ReactNode }) {
  const slots = useContext(RepoBarContext);
  if (slots === null || slots.actions === null) return null;
  return createPortal(children, slots.actions);
}

/**
 * A repository in the sidebar shell: no header of its own. The shell's bar
 * says where the page is (namespace / repository / page), holds the
 * repository's sections as quiet links, and its star and fork at the end.
 */
function RepoBarFrame({
  repository,
  repo,
  children,
}: {
  repository: Repository;
  repo: RepoRef;
  children: ReactNode;
}) {
  const [crumb, setCrumb] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [named, setNamed] = useState(0);
  const slots = useMemo<RepoBarSlots>(
    () => ({
      crumb,
      actions,
      nameIt: () => {
        setNamed((count) => count + 1);
        return () => setNamed((count) => count - 1);
      },
    }),
    [crumb, actions],
  );
  return (
    <RepositoryContext.Provider value={repository}>
      <RepoBarContext.Provider value={slots}>
        <BarPortal>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <AppLink
              href={paths.namespace(repository.owner.slug)}
              className="shrink-0 text-on-surface-muted hover:text-on-surface"
            >
              {repository.owner.slug}
            </AppLink>
            <span aria-hidden="true" className="shrink-0 text-on-surface-faint">
              /
            </span>
            <AppLink
              href={paths.repo(repo)}
              className={`max-w-56 shrink-0 truncate hover:text-on-surface ${
                named > 0 ? "text-on-surface-muted" : "font-medium text-on-surface"
              }`}
            >
              {repository.name}
            </AppLink>
            {repository.visibility === "private" ? (
              <span role="img" aria-label="Private" title="Private" className="inline-flex">
                <Icon name="lock" size={12} className="text-on-surface-faint" />
              </span>
            ) : null}
            {repository.isFork ? (
              <span role="img" aria-label="Fork" title="Fork" className="inline-flex">
                <Icon name="gitFork" size={12} className="text-on-surface-faint" />
              </span>
            ) : null}
            {repository.archived ? (
              <Badge tone="warning">
                <Icon name="archive" size={10} />
                Archived
              </Badge>
            ) : null}
            <span ref={setCrumb} className="contents" />
          </nav>
          <div className="flex-1" />
          <QuietTabs
            label="Repository"
            compact
            tabs={tabsFor(repository, repo, true)}
            className="shrink-0"
          />
          <span ref={setActions} className="flex shrink-0 items-center gap-3 empty:hidden" />
          <span className="flex shrink-0 items-center border-l border-border pl-2">
            <StarButton repository={repository} repo={repo} quiet />
            <ForkButton repository={repository} repo={repo} quiet />
          </span>
        </BarPortal>
        {repository.parent !== null ? (
          <div className={`${pageColumn(true)} !pb-0`}>
            <ForkedFrom repository={repository} repo={repo} />
          </div>
        ) : null}
        {children}
      </RepoBarContext.Provider>
    </RepositoryContext.Provider>
  );
}

function RepoHeader({ repository, repo }: { repository: Repository; repo: RepoRef }) {
  return (
    <div className="border-b border-border bg-surface-inset">
      <div className="mx-auto w-full max-w-6xl px-4 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-base">
              <Icon
                name={repository.isFork ? "gitFork" : "book"}
                size={16}
                className="text-on-surface-muted"
              />
              <AppLink
                href={paths.namespace(repository.owner.slug)}
                className="text-on-surface-secondary hover:underline"
              >
                {repository.owner.slug}
              </AppLink>
              <span aria-hidden="true" className="text-on-surface-faint">
                /
              </span>
              <AppLink
                href={paths.repo(repo)}
                className="font-semibold text-on-surface hover:underline"
              >
                {repository.name}
              </AppLink>
              <span className="ml-1 flex items-center gap-1.5">
                <VisibilityBadge visibility={repository.visibility} />
                {repository.archived ? (
                  <Badge tone="warning">
                    <Icon name="archive" size={10} />
                    Archived
                  </Badge>
                ) : null}
              </span>
            </h1>
            <ForkedFrom repository={repository} repo={repo} className="mt-1" />
          </div>
          <div className="flex items-start gap-2">
            <StarButton repository={repository} repo={repo} />
            <ForkButton repository={repository} repo={repo} />
          </div>
        </div>
        <LinkTabs label="Repository" tabs={tabsFor(repository, repo)} className="mt-3" />
      </div>
    </div>
  );
}

export function RepoLayout({
  owner,
  name,
  children,
}: {
  owner: string;
  name: string;
  children: ReactNode;
}) {
  const repo: RepoRef = { owner, repo: name };
  const query = useQuery(queries.repositories.get({ params: repo }));
  const session = useSession();
  const sidebar = useSidebarShell();

  if (query.data === undefined) {
    if (query.error) {
      const signedOut = session.data !== undefined && session.data.user === null;
      return (
        <Page>
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          {isNotFound(query.error) && signedOut ? (
            <p className="text-center">
              <a href={signInHref()} className={buttonClass("primary")}>
                Sign in
              </a>
            </p>
          ) : null}
        </Page>
      );
    }
    return <RepoSkeleton />;
  }
  const repository = query.data;
  // The API matches names case-insensitively; link with the repository's own spelling.
  const canonical: RepoRef = { owner: repository.owner.slug, repo: repository.name };
  if (sidebar) {
    return (
      <RepoBarFrame repository={repository} repo={canonical}>
        {children}
      </RepoBarFrame>
    );
  }
  return (
    <RepositoryContext.Provider value={repository}>
      <RepoHeader repository={repository} repo={canonical} />
      {children}
    </RepositoryContext.Provider>
  );
}
