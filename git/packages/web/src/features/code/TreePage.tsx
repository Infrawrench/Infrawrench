/**
 * A directory at a ref: the file table with each entry's last commit, and the
 * directory's README under it. The repository's front page is this at the
 * default branch's root, with the clone box and the About column.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Repository, TreeEntry, TreeListing } from "@infrawrench/git-contract";
import { ApiError } from "../../api/client";
import { queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { LanguageLabel } from "../../components/Badge";
import { Icon, type IconName } from "../../components/icons";
import { Page, Panel, PanelHeader, Table, Td, Th, Tr } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { ErrorState, Loading } from "../../components/states";
import { formatBytes, plural } from "../../lib/format";
import { paths, type RepoRef } from "../../lib/paths";
import { parentPath } from "../../lib/refs";
import { webUrl } from "../../lib/safe-url";
import { usePageTitle } from "../../lib/title";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { EmptyRepository } from "./EmptyRepository";
import { Languages } from "./Languages";
import { ReadmePanel } from "./ReadmePanel";
import { latestCommitQuery, prefetchEntry, treeQuery } from "./requests";
import { CloneMenu, CodeRefPicker, CommitStrip, PathBreadcrumbs } from "./shared";
import { showBidi } from "../../lib/bidi";

const ENTRY_ICON: Record<TreeEntry["type"], IconName> = {
  tree: "folder",
  blob: "file",
  symlink: "fileSymlink",
  submodule: "folderGit",
};

const ENTRY_KIND: Record<TreeEntry["type"], string> = {
  tree: "Directory",
  blob: "File",
  symlink: "Symbolic link",
  submodule: "Submodule",
};

export function TreePage({ refName, path }: { refName: string; path: string }) {
  const repository = useRepository();
  const repo = useRepoRef();
  const go = useGo();
  const tree = useQuery({ ...treeQuery(repo, refName, path), enabled: !repository.isEmpty });
  // The root is the repository's own page; a folder is named with the ref it resolved to.
  usePageTitle(
    tree.data && tree.data.path !== ""
      ? `${repo.repo}/${tree.data.path} at ${tree.data.ref.name}`
      : null,
    `${repo.owner}/${repo.repo}`,
  );

  // A file's path under /tree is a link someone edited by hand: show the file.
  const isFile = tree.error instanceof ApiError && tree.error.code === "not_a_directory";
  useEffect(() => {
    if (isFile) go(paths.blob(repo, refName, path), { replace: true });
  }, [isFile, go, repo.owner, repo.repo, refName, path]);

  if (repository.isEmpty) {
    return (
      <Page>
        <EmptyRepository repository={repository} />
      </Page>
    );
  }
  if (tree.data === undefined) {
    return (
      <Page>
        {tree.error && !isFile ? (
          <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />
        ) : (
          <Loading />
        )}
      </Page>
    );
  }
  const listing = tree.data;
  const root = path === "";
  const files = (
    <div className="min-w-0 space-y-4">
      <FileTable repo={repo} refName={listing.ref.name} listing={listing} />
      {listing.readmePath !== null ? (
        <ReadmePanel repo={repo} commitOid={listing.ref.commitOid} path={listing.readmePath} />
      ) : null}
    </div>
  );
  return (
    <Page>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <CodeRefPicker
          repo={repo}
          resolved={listing.ref}
          to={(name) => paths.tree(repo, name, path)}
        />
        {root ? (
          <div className="flex items-center gap-3 text-xs text-on-surface-muted">
            <AppLink
              href={paths.branches(repo)}
              className="inline-flex items-center gap-1 hover:underline"
            >
              <Icon name="gitBranch" size={12} />
              {plural(repository.branchCount, "branch", "branches")}
            </AppLink>
            <AppLink
              href={paths.tags(repo)}
              className="inline-flex items-center gap-1 hover:underline"
            >
              <Icon name="tag" size={12} />
              {plural(repository.tagCount, "tag")}
            </AppLink>
          </div>
        ) : (
          <PathBreadcrumbs repo={repo} refName={listing.ref.name} path={path} />
        )}
        <div className="flex-1" />
        {root ? <CloneMenu repository={repository} repo={repo} refName={listing.ref.name} /> : null}
      </div>
      {root ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
          {files}
          <About repository={repository} />
        </div>
      ) : (
        files
      )}
    </Page>
  );
}

function FileTable({
  repo,
  refName,
  listing,
}: {
  repo: RepoRef;
  refName: string;
  listing: TreeListing;
}) {
  // The listing comes first; commits the server had no budget for follow.
  const rest = useQuery({
    ...queries.contents.treeLastCommits({
      params: repo,
      query: { ref: listing.ref.commitOid, path: listing.path },
    }),
    enabled: !listing.lastCommitsComplete,
  });
  // The header's commit and the root's count arrive after the listing.
  const latest = useQuery(latestCommitQuery(repo, listing.ref.commitOid, listing.path));
  const headCommit = listing.lastCommit ?? latest.data?.commit ?? null;
  const commitCount = listing.commitCount ?? latest.data?.count ?? null;
  return (
    <Panel>
      {headCommit !== null ? (
        <PanelHeader>
          <CommitStrip repo={repo} commit={headCommit}>
            <AppLink
              href={paths.commits(repo, refName, listing.path)}
              className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-on-surface hover:underline"
            >
              <Icon name="history" size={12} />
              {commitCount !== null ? plural(commitCount, "commit") : "History"}
            </AppLink>
          </CommitStrip>
        </PanelHeader>
      ) : null}
      <Table caption={listing.path === "" ? "Files" : `Files in ${listing.path}`}>
        <thead className="sr-only">
          <tr>
            <Th>Name</Th>
            <Th>Last commit</Th>
            <Th>Last changed</Th>
          </tr>
        </thead>
        <tbody>
          {listing.path !== "" ? (
            <Tr>
              <Td colSpan={3}>
                <AppLink
                  href={paths.tree(repo, refName, parentPath(listing.path))}
                  onPointerEnter={() =>
                    prefetchEntry(repo, refName, { type: "tree", path: parentPath(listing.path) })
                  }
                  aria-label="Parent directory"
                  className="inline-flex items-center gap-2 font-mono text-on-surface-secondary hover:underline"
                >
                  <Icon name="folder" className="text-on-surface-muted" />
                  ..
                </AppLink>
              </Td>
            </Tr>
          ) : null}
          {listing.entries.map((entry) => {
            const commit = entry.lastCommit ?? rest.data?.commits[entry.name] ?? null;
            const href =
              entry.type === "tree"
                ? paths.tree(repo, refName, entry.path)
                : entry.type === "submodule"
                  ? null
                  : paths.blob(repo, refName, entry.path);
            return (
              <Tr key={entry.name}>
                <Td className="w-[32%] max-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span role="img" aria-label={ENTRY_KIND[entry.type]} className="inline-flex">
                      <Icon name={ENTRY_ICON[entry.type]} className="text-on-surface-muted" />
                    </span>
                    {href !== null ? (
                      <AppLink
                        href={href}
                        className="truncate text-on-surface hover:underline"
                        onPointerEnter={() => prefetchEntry(repo, refName, entry)}
                        onFocus={() => prefetchEntry(repo, refName, entry)}
                      >
                        {showBidi(entry.name)}
                      </AppLink>
                    ) : (
                      <span className="truncate text-on-surface">
                        {showBidi(entry.name)}
                        <span className="ml-1.5 font-mono text-on-surface-faint">
                          @ {entry.oid.slice(0, 7)}
                        </span>
                      </span>
                    )}
                  </span>
                </Td>
                <Td className="max-w-0 text-on-surface-muted">
                  {commit !== null ? (
                    <AppLink
                      href={paths.commit(repo, commit.oid)}
                      className="block truncate hover:text-on-surface hover:underline"
                      title={showBidi(commit.summary)}
                    >
                      {showBidi(commit.summary)}
                    </AppLink>
                  ) : null}
                </Td>
                <Td className="w-28 whitespace-nowrap text-right text-on-surface-muted">
                  {commit !== null ? <RelativeTime iso={commit.committer.when} /> : null}
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      {listing.truncated ? (
        <p className="border-t border-border px-3 py-2 text-xs text-on-surface-muted">
          This directory has more entries than are listed.
        </p>
      ) : null}
    </Panel>
  );
}

function About({ repository }: { repository: Repository }) {
  const homepage = webUrl(repository.homepageUrl);
  return (
    <aside aria-labelledby="about-heading" className="space-y-3 text-xs">
      <h2 id="about-heading" className="text-sm font-semibold text-on-surface">
        About
      </h2>
      {repository.description !== null && repository.description !== "" ? (
        <p className="text-on-surface-secondary">{repository.description}</p>
      ) : null}
      {homepage !== null ? (
        <a
          href={homepage}
          rel="noopener noreferrer nofollow"
          className="flex items-center gap-1.5 text-accent"
        >
          <Icon name="link" size={12} />
          <span className="truncate">{homepage.replace(/^https?:\/\//, "")}</span>
        </a>
      ) : null}
      {repository.topics.length > 0 ? (
        <ul aria-label="Topics" className="flex flex-wrap gap-1">
          {repository.topics.map((topic) => (
            <li key={topic}>
              <AppLink
                href={paths.explore({ q: topic })}
                className="inline-block rounded-full bg-surface-sunken px-2 py-0.5 text-on-surface-secondary hover:text-on-surface"
              >
                {topic}
              </AppLink>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="space-y-1.5 text-on-surface-muted">
        {repository.primaryLanguage !== null ? (
          <div className="flex items-center gap-1.5">
            <dt className="sr-only">Language</dt>
            <dd>
              <LanguageLabel language={repository.primaryLanguage} />
            </dd>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <Icon name="star" size={12} />
          <dt className="sr-only">Stars</dt>
          <dd>{plural(repository.starCount, "star")}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <Icon name="gitFork" size={12} />
          <dt className="sr-only">Forks</dt>
          <dd>{plural(repository.forkCount, "fork")}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <Icon name="archive" size={12} />
          <dt className="sr-only">Size</dt>
          <dd>{formatBytes(repository.sizeBytes)}</dd>
        </div>
      </dl>
      <Languages languages={repository.languages} />
    </aside>
  );
}
