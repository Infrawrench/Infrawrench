/** Tags, newest first, each with the commit it leads to and its archives. */
import { useState } from "react";
import { archivePath } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { SearchInput } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Page, PageHeader, Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";

export function TagsPage() {
  const repository = useRepository();
  const repo = useRepoRef();
  const [q, setQ] = useState("");
  const request = { params: repo, query: { ...(q === "" ? {} : { q }), limit: 30 } };
  const tags = usePages(
    ["contents", "listTags", request],
    (cursor) =>
      api.contents.listTags({
        ...request,
        query: { ...request.query, ...(cursor === undefined ? {} : { cursor }) },
      }),
    { enabled: !repository.isEmpty },
  );
  return (
    <Page>
      <PageHeader title="Tags">
        <SearchInput
          label="Filter tags"
          placeholder="Find a tag"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          className="w-64"
        />
      </PageHeader>
      <Panel>
        {repository.isEmpty ? (
          <EmptyState>No tags yet</EmptyState>
        ) : tags.isLoading ? (
          <Loading framed={false} />
        ) : tags.error ? (
          <ErrorState error={tags.error} />
        ) : tags.items.length === 0 ? (
          <EmptyState>{q === "" ? "No tags yet" : "No tags match"}</EmptyState>
        ) : (
          <ul aria-label="Tags" className="divide-y divide-border">
            {tags.items.map((tag) => {
              const when = tag.tagger?.when ?? tag.commit?.committer.when ?? null;
              const subject = tag.message?.split("\n")[0] ?? "";
              return (
                <li
                  key={tag.name}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2">
                      <Icon name="tag" className="text-on-surface-muted" />
                      <AppLink
                        href={paths.tree(repo, tag.name)}
                        className="text-sm font-semibold text-on-surface hover:underline"
                      >
                        {tag.name}
                      </AppLink>
                    </p>
                    {subject !== "" ? (
                      <p className="mt-0.5 truncate text-xs text-on-surface-secondary">{subject}</p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-4 text-xs text-on-surface-muted">
                    {when !== null ? <RelativeTime iso={when} /> : null}
                    {tag.commit !== null ? (
                      <AppLink
                        href={paths.commit(repo, tag.commit.oid)}
                        className="inline-flex items-center gap-1 font-mono hover:underline"
                      >
                        <Icon name="gitCommit" size={12} />
                        {shortOid(tag.commit.oid)}
                      </AppLink>
                    ) : null}
                    <a
                      href={archivePath(repo, tag.name, "zip")}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      <Icon name="download" size={12} />
                      ZIP
                    </a>
                    <a
                      href={archivePath(repo, tag.name, "tar.gz")}
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      <Icon name="download" size={12} />
                      TAR.GZ
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      <LoadMore pages={tags} />
    </Page>
  );
}
