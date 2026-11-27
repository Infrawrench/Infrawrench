/** One commit: its message, who and when, its parents and refs, and what it changed. */
import { useQuery } from "@tanstack/react-query";
import type { Signature, UserRef } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge, CommitStatusIcon } from "../../components/Badge";
import { ButtonLink } from "../../components/Button";
import { CopyButton } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page, Panel } from "../../components/Panel";
import { CommitAuthor, CommitAuthors, RelativeTime } from "../../components/people";
import { QueryView } from "../../components/states";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import { usePageTitle } from "../../lib/title";
import { useRepoRef } from "../../layout/RepoLayout";
import { optional } from "../review/optional";
import { DiffSection } from "./DiffSection";
import { CommitReviewSection } from "./ReviewHistory";
import { showBidi } from "../../lib/bidi";

function Person({
  signature,
  user,
  verb,
}: {
  signature: Signature;
  user: UserRef | null;
  verb: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <CommitAuthor author={signature} user={user} />
      <span>{verb}</span>
      <RelativeTime iso={signature.when} />
    </span>
  );
}

export function CommitPage({ sha }: { sha: string }) {
  const repo = useRepoRef();
  const detail = useQuery(queries.contents.commit({ params: { ...repo, sha } }));
  usePageTitle(
    detail.data && `${detail.data.commit.summary} · ${detail.data.commit.oid.slice(0, 7)}`,
    `${repo.owner}/${repo.repo}`,
  );
  // The branch page this commit was merged as, when it is one: asked by the whole id, after the commit.
  const oid = detail.data?.commit.oid;
  const review = useQuery({
    ...optional(queries.contents.commitReview({ params: { ...repo, sha: oid ?? sha } })),
    enabled: oid !== undefined,
  });
  return (
    <Page>
      <QueryView query={detail} shape="code">
        {({ commit, stats, files, filesTruncated, branches, tags, branchPages }) => {
          const body = commit.message.slice(commit.summary.length).replace(/^\n+/, "");
          const sameCommitter =
            commit.author.email === commit.committer.email &&
            commit.author.when === commit.committer.when;
          return (
            <div className="space-y-4">
              <Panel>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border bg-surface-inset px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <h1 className="flex items-center gap-2 text-base font-semibold text-on-surface">
                      <span className="min-w-0 break-words">{showBidi(commit.summary)}</span>
                      <CommitStatusIcon state={commit.status} size={15} />
                    </h1>
                    {body !== "" ? (
                      <pre className="mt-2 whitespace-pre-wrap font-mono text-xs leading-5 text-on-surface-secondary">
                        {body}
                      </pre>
                    ) : null}
                    {branches.length + tags.length + branchPages.length > 0 ? (
                      <ul aria-label="Refs at this commit" className="mt-2 flex flex-wrap gap-1.5">
                        {branches.map((name) => (
                          <li key={`b:${name}`}>
                            <AppLink href={paths.tree(repo, name)}>
                              <Badge tone="outline">
                                <Icon name="gitBranch" size={10} />
                                {name}
                              </Badge>
                            </AppLink>
                          </li>
                        ))}
                        {tags.map((name) => (
                          <li key={`t:${name}`}>
                            <AppLink href={paths.tree(repo, name)}>
                              <Badge tone="outline">
                                <Icon name="tag" size={10} />
                                {name}
                              </Badge>
                            </AppLink>
                          </li>
                        ))}
                        {branchPages.map((page) => (
                          <li key={`p:${page.key}`}>
                            <AppLink href={paths.branchPage(repo, page.key)} title={page.title}>
                              <Badge tone="outline">
                                <Icon name="fileDiff" size={10} />
                                <span className="max-w-48 truncate">{page.title}</span>
                              </Badge>
                            </AppLink>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <ButtonLink href={paths.tree(repo, commit.oid)}>
                    <Icon name="code" />
                    Browse files
                  </ButtonLink>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 text-xs text-on-surface-muted">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="inline-flex items-center gap-1.5">
                      <CommitAuthors commit={commit} />
                      <span>authored</span>
                      <RelativeTime iso={commit.author.when} />
                    </span>
                    {sameCommitter ? null : (
                      <Person
                        signature={commit.committer}
                        user={commit.committerUser}
                        verb="committed"
                      />
                    )}
                    {commit.signed ? <Badge tone="outline">Signed</Badge> : null}
                  </div>
                  <dl className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <div className="flex items-center gap-1.5">
                      <dt>{commit.parents.length === 1 ? "Parent" : "Parents"}</dt>
                      <dd className="flex items-center gap-1.5 font-mono">
                        {commit.parents.length === 0 ? (
                          <span className="font-sans">None</span>
                        ) : (
                          commit.parents.map((parent) => (
                            <AppLink
                              key={parent}
                              href={paths.commit(repo, parent)}
                              className="text-on-surface-secondary hover:underline"
                            >
                              {shortOid(parent)}
                            </AppLink>
                          ))
                        )}
                      </dd>
                    </div>
                    <div className="flex items-center gap-1">
                      <dt>Commit</dt>
                      <dd className="flex items-center gap-0.5 font-mono text-on-surface">
                        {commit.oid}
                        <CopyButton text={commit.oid} label="Copy commit id" />
                      </dd>
                    </div>
                  </dl>
                </div>
              </Panel>

              {review.data !== undefined && review.data.review !== null ? (
                <CommitReviewSection repo={repo} review={review.data.review} />
              ) : null}

              <DiffSection
                repo={repo}
                queryKey={["contents", "commitDiff", repo, commit.oid]}
                files={files}
                filesTruncated={filesTruncated}
                stats={stats}
                fetchPage={(cursor) =>
                  api.contents.commitDiff({
                    params: { ...repo, sha: commit.oid },
                    query: cursor === undefined ? {} : { cursor },
                  })
                }
                fetchFile={async (path) =>
                  (
                    await api.contents.commitDiff({
                      params: { ...repo, sha: commit.oid },
                      query: { path },
                    })
                  ).files[0]
                }
              />
            </div>
          );
        }}
      </QueryView>
    </Page>
  );
}
