/** What the code pages share: resolving a URL's ref, breadcrumbs, the last-commit strip, the clone box. */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  archivePath,
  type CommitSummary,
  type Repository,
  type ResolvedRef,
} from "@infrawrench/git-contract";
import { queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { CommitChecks } from "../../components/CommitChecks";
import { buttonClass } from "../../components/Button";
import { Breadcrumbs, CopyButton, Segmented, type Crumb } from "../../components/controls";
import { CodePageSkeleton } from "./CodePageSkeleton";
import { prefetchEntry } from "./requests";
import { Icon } from "../../components/icons";
import { Popover } from "../../components/Menu";
import { CommitAuthors, RelativeTime } from "../../components/people";
import { RefPicker } from "../../components/RefPicker";
import { ErrorState } from "../../components/states";
import { shortOid } from "../../lib/format";
import { paths, type RepoRef } from "../../lib/paths";
import { pathCrumbs, splitRefPath, type RefAndPath } from "../../lib/refs";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { showBidi } from "../../lib/bidi";

/**
 * Splits a route's splat (`feature/x/src/a.ts`) into its ref and path against
 * the repository's ref names, and renders `children` with them. An empty
 * splat is the default branch at the root.
 */
export function WithRefAndPath({
  repo,
  repository,
  splat,
  children,
}: {
  repo: RepoRef;
  repository: Repository;
  splat: string;
  children: (resolved: RefAndPath) => ReactNode;
}) {
  const refs = useQuery(queries.contents.listRefs({ params: repo, query: { limit: 100 } }));
  if (splat === "") return <>{children({ ref: repository.defaultBranch, path: "" })}</>;
  if (refs.data === undefined) {
    return refs.error ? <ErrorState error={refs.error} /> : <CodePageSkeleton kind="table" />;
  }
  const names = [...refs.data.branches, ...refs.data.tags].map((ref) => ref.name);
  return <>{children(splitRefPath(splat, names))}</>;
}

/** {@link WithRefAndPath} for a route under the repository layout: `<RefRoute splat={_splat}>`. */
export function RefRoute({
  splat,
  children,
}: {
  splat: string | undefined;
  children: (resolved: RefAndPath) => ReactNode;
}) {
  const repository = useRepository();
  const repo = useRepoRef();
  return (
    <WithRefAndPath repo={repo} repository={repository} splat={splat ?? ""}>
      {children}
    </WithRefAndPath>
  );
}

/** `repo / dir / dir / file`, each but the last a link to that directory. */
export function PathBreadcrumbs({
  repo,
  refName,
  path,
}: {
  repo: RepoRef;
  refName: string;
  path: string;
}) {
  // Each folder starts loading when the pointer rests on it (`requests.ts`).
  const folder = (folderPath: string) => () =>
    prefetchEntry(repo, refName, { type: "tree", path: folderPath });
  const crumbs: Crumb[] = [
    { label: repo.repo, href: paths.tree(repo, refName), onIntent: folder("") },
  ];
  const parts = pathCrumbs(path);
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    crumbs.push(
      last
        ? { label: part.name }
        : {
            label: part.name,
            href: paths.tree(repo, refName, part.path),
            onIntent: folder(part.path),
          },
    );
  });
  if (parts.length === 0) crumbs[0] = { label: repo.repo };
  return <Breadcrumbs crumbs={crumbs} label="File path" />;
}

/** The ref picker of a code page: picking a ref goes to the same path on it. */
export function CodeRefPicker({
  repo,
  resolved,
  to,
}: {
  repo: RepoRef;
  resolved: ResolvedRef | { name: string; kind: "branch" | "tag" | "commit" };
  /** The URL of this page on another ref. */
  to: (refName: string) => string;
}) {
  const go = useGo();
  return (
    <RefPicker
      repo={repo}
      value={resolved.name}
      kind={resolved.kind}
      onSelect={(name) => go(to(name))}
    />
  );
}

/** One line about a commit: who, what, its checks, its id and when. */
export function CommitStrip({
  repo,
  commit,
  children,
}: {
  repo: RepoRef;
  commit: CommitSummary;
  /** After the time: a link to the history. */
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
      <CommitAuthors commit={commit} />
      <AppLink
        href={paths.commit(repo, commit.oid)}
        className="min-w-0 flex-1 truncate text-on-surface-secondary hover:underline"
        title={showBidi(commit.summary)}
      >
        {showBidi(commit.summary)}
      </AppLink>
      <CommitChecks repo={repo} oid={commit.oid} state={commit.status} live />
      <AppLink
        href={paths.commit(repo, commit.oid)}
        className="font-mono text-on-surface-muted hover:underline"
      >
        {shortOid(commit.oid)}
      </AppLink>
      <RelativeTime
        iso={commit.committer.when}
        className="whitespace-nowrap text-on-surface-muted"
      />
      {children}
    </div>
  );
}

export type Transport = "https" | "ssh";

/** The repository's clone URL for a transport: HTTPS while SSH is turned off. */
export const cloneUrlOf = (repository: Repository, transport: Transport): string =>
  transport === "ssh" && repository.sshCloneUrl !== null
    ? repository.sshCloneUrl
    : repository.httpCloneUrl;

/**
 * The HTTPS/SSH switch and the URL it picks. Pass `transport` and `onChange`
 * when something beside it (the empty repository's commands) follows the
 * choice; left out, it keeps its own.
 */
export function CloneUrl({
  repository,
  transport: chosen,
  onChange,
}: {
  repository: Repository;
  transport?: Transport;
  onChange?: (transport: Transport) => void;
}) {
  const [own, setOwn] = useState<Transport>("https");
  // While SSH is turned off there is one way to clone, and nothing to choose.
  const ssh = repository.sshCloneUrl !== null;
  const transport = ssh ? (chosen ?? own) : "https";
  const setTransport = onChange ?? setOwn;
  const url = cloneUrlOf(repository, transport);
  return (
    <div className="flex items-center gap-2">
      {ssh ? (
        <Segmented
          label="Clone over"
          value={transport}
          onChange={setTransport}
          options={[
            { value: "https", label: "HTTPS" },
            { value: "ssh", label: "SSH" },
          ]}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 items-center rounded border border-border bg-surface">
        <input
          readOnly
          aria-label={`${transport === "https" ? "HTTPS" : "SSH"} clone URL`}
          value={url}
          onFocus={(event) => event.target.select()}
          className="min-w-0 flex-1 bg-transparent px-2 py-1 font-mono text-xs text-on-surface focus:outline-none"
        />
        <CopyButton text={url} label="Copy clone URL" />
      </div>
    </div>
  );
}

/** The Clone button on a repository's front page: the URLs and the archive downloads. */
export function CloneMenu({
  repository,
  repo,
  refName,
}: {
  repository: Repository;
  repo: RepoRef;
  refName: string;
}) {
  return (
    <Popover
      align="end"
      className="w-96"
      trigger={({ props }) => (
        <button {...props} type="button" aria-haspopup="dialog" className={buttonClass("primary")}>
          <Icon name="code" />
          Clone
          <Icon name="chevronDown" size={12} />
        </button>
      )}
    >
      {() => (
        <div role="dialog" aria-label="Clone" className="space-y-3 p-3">
          <CloneUrl repository={repository} />
          <div className="flex items-center gap-2 border-t border-border pt-3 text-xs">
            <Icon name="download" className="text-on-surface-muted" />
            <a
              href={archivePath(repo, refName, "zip")}
              className="text-on-surface-secondary hover:underline"
            >
              Download ZIP
            </a>
            <a
              href={archivePath(repo, refName, "tar.gz")}
              className="text-on-surface-secondary hover:underline"
            >
              Download TAR.GZ
            </a>
          </div>
        </div>
      )}
    </Popover>
  );
}
