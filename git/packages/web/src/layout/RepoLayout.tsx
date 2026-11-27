/**
 * The frame of every repository page. A repository has no header of its own:
 * the shell's bar says where the page is (namespace / repository / page),
 * holds the repository's sections as quiet links, and its star and fork at
 * the end (`RepoBarFrame`). The active section comes from the route.
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
import { Badge } from "../components/Badge";
import { Dialog, QuietTabs, type LinkTab } from "../components/controls";
import { Field, Input, Select } from "../components/forms";
import { Icon } from "../components/icons";
import { useLocation } from "@tanstack/react-router";
import { Page } from "../components/Panel";
import { ErrorState, InlineError, Loading } from "../components/states";
import { CodePageSkeleton } from "../features/code/CodePageSkeleton";
import { compactCount } from "../lib/format";
import { mayUseName, useNewNameAvailability } from "../lib/name-availability";
import { ownersOf, type Owner } from "../lib/owners";
import { paths, type RepoRef } from "../lib/paths";
import { formatHead } from "../lib/refs";
import { signInHref, useSession } from "../lib/session";
import { pageColumn } from "../lib/shell";
import { BarPortal } from "./TopBar";
import { isNotFound } from "../api/client";
import { Button, buttonClass } from "../components/Button";
import { ProposeButton } from "../features/branch-page/ProposeButton";

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
  const owner = repository.owner.slug;
  const name = repository.name;
  // The same object while the repository is the same, so it can sit in an effect's dependencies.
  return useMemo(() => ({ owner, repo: name }), [owner, name]);
}

/** The first path segments that belong to the Code tab. */
const CODE_SECTIONS = new Set([
  "",
  "tree",
  "blob",
  "blame",
  "commits",
  "commit",
  "tags",
  "compare",
]);

/** The page's section: the path segment after `/:owner/:repo`. */
export function repoSection(pathname: string): string {
  return pathname.split("/").filter(Boolean)[2] ?? "";
}

/** A repository's sections. Start work is a page of the Branches tab. */
function tabsFor(repository: Repository, repo: RepoRef): LinkTab[] {
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
  tabs.push({
    label: "Branches",
    href: paths.branches(repo),
    icon: <Icon name="gitBranch" />,
    count: repository.openBranchCount,
    match: (pathname) => ["branches", "start"].includes(repoSection(pathname)),
  });
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

/** A control in the shell's bar: its glyph and its count, no frame. */
const quietButton =
  "inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-on-surface-muted tabular-nums hover:bg-surface-sunken hover:text-on-surface disabled:opacity-60";

interface RepoControl {
  repository: Repository;
  repo: RepoRef;
}

function StarButton({ repository, repo }: RepoControl) {
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
  const body = (
    <>
      <Icon name="star" filled={starred} className={starred ? "text-warning" : ""} />
      <span className="sr-only">{starred ? "Starred" : "Star"}</span>
      <span aria-label={`${repository.starCount} stars`}>{compactCount(repository.starCount)}</span>
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

function ForkButton({ repository, repo }: RepoControl) {
  const session = useSession();
  const user = session.data?.user ?? null;
  const [open, setOpen] = useState(false);
  const targets = session.data === undefined ? [] : forkTargets(repository, ownersOf(session.data));
  const dialog = open ? (
    <ForkDialog
      repository={repository}
      repo={repo}
      targets={targets}
      onClose={() => setOpen(false)}
    />
  ) : null;
  const body = (
    <>
      <Icon name="gitFork" />
      <span className="sr-only">Fork</span>
      <span aria-label={`${repository.forkCount} forks`}>{compactCount(repository.forkCount)}</span>
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

/** A repository's page while the repository loads: the outline of the tab being opened. */
function RepoSkeleton() {
  const { pathname } = useLocation();
  const section = pathname.split("/").filter(Boolean)[2];
  // The repository is named in the bar: there is no band to hold a place for.
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading repository</span>
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

/**
 * Where a fork came from, how it differs, and its default branch proposed
 * there. Nothing for a repository that is not one.
 */
function ForkedFrom({ repository, repo }: { repository: Repository; repo: RepoRef }) {
  if (repository.parent === null) return null;
  const parent = { owner: repository.parent.owner, repo: repository.parent.name };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-on-surface-muted">
      <p>
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
      {repository.isEmpty ? null : (
        <ProposeButton fork={repository} branch={repository.defaultBranch} />
      )}
    </div>
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
 * repository: `acme / infra / Peer with the shared services VPC`.
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

/** A page's own controls on the right of the bar. */
export function RepoBarActions({ children }: { children: ReactNode }) {
  const slots = useContext(RepoBarContext);
  if (slots === null || slots.actions === null) return null;
  return createPortal(children, slots.actions);
}

/**
 * A repository has no header of its own. The shell's bar says where the page
 * is (namespace / repository / page), holds the repository's sections as
 * quiet links, and its star and fork at the end.
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
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-1.5 overflow-hidden text-sm"
          >
            <AppLink
              href={paths.namespace(repository.owner.slug)}
              className="max-w-40 shrink truncate text-on-surface-muted hover:text-on-surface"
            >
              {repository.owner.slug}
            </AppLink>
            <span aria-hidden="true" className="shrink-0 text-on-surface-faint">
              /
            </span>
            <AppLink
              href={paths.repo(repo)}
              className={`max-w-56 min-w-8 shrink truncate hover:text-on-surface ${
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
          <div className="flex-1 max-sm:hidden" />
          <QuietTabs
            label="Repository"
            compact
            tabs={tabsFor(repository, repo)}
            className="no-scrollbar shrink-0 max-sm:col-span-full max-sm:row-start-2 max-sm:-mx-2 max-sm:overflow-x-auto"
          />
          <span ref={setActions} className="flex shrink-0 items-center gap-3 empty:hidden" />
          <span className="flex shrink-0 items-center border-l border-border pl-2">
            <StarButton repository={repository} repo={repo} />
            <ForkButton repository={repository} repo={repo} />
          </span>
        </BarPortal>
        {repository.parent !== null ? (
          <div className={`${pageColumn()} !pb-0`}>
            <ForkedFrom repository={repository} repo={repo} />
          </div>
        ) : null}
        {children}
      </RepoBarContext.Provider>
    </RepositoryContext.Provider>
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

  if (query.data === undefined) {
    if (query.error) {
      const signedOut = session.data !== undefined && session.data.user === null;
      return (
        <Page>
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            className="!pt-20 !pb-4"
          />
          {isNotFound(query.error) ? (
            <p className="text-center">
              {signedOut ? (
                <a href={signInHref()} className={buttonClass("primary")}>
                  Sign in
                </a>
              ) : (
                <AppLink href={paths.home()} className={buttonClass("secondary")}>
                  Home
                </AppLink>
              )}
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
  return (
    <RepoBarFrame repository={repository} repo={canonical}>
      {children}
    </RepoBarFrame>
  );
}
