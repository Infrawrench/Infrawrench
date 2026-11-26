/**
 * Waiting on you: the branches with a version the reader has not reviewed,
 * the longest wait first, each with what changed since they last looked.
 */
import type { ReviewInboxItem } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { usePages } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { showBidi } from "../../lib/bidi";
import { cursorQuery } from "../../lib/cursor";
import { plural } from "../../lib/format";
import { paths } from "../../lib/paths";
import { isUnavailable } from "./optional";

/** `2 new versions, 3 comments, 1 finding`, or that it has not been looked at. */
export function changesSentence(item: ReviewInboxItem): string {
  const { versions, comments, findings } = item.changes;
  const parts = [
    item.reviewedVersion === null ? plural(versions, "version") : plural(versions, "new version"),
    comments > 0 ? plural(comments, "comment") : null,
    findings > 0 ? plural(findings, "finding") : null,
  ].filter((part): part is string => part !== null);
  return parts.join(", ");
}

export function InboxRow({ item }: { item: ReviewInboxItem }) {
  const repo = { owner: item.repository.owner, repo: item.repository.name };
  // Opens on what is new: the newest version against the one last reviewed.
  const href = paths.branchPage(
    repo,
    item.number,
    item.reviewedVersion === null ? {} : { v: item.latestVersion, diff: "since" },
  );
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <AppLink href={href} className="min-w-0 font-medium text-on-surface hover:underline">
            {showBidi(item.title)}
          </AppLink>
          {item.draft ? <Badge tone="outline">Draft</Badge> : null}
          {item.mustFixOpen > 0 ? (
            <Badge tone="danger">{plural(item.mustFixOpen, "must fix", "must fix")}</Badge>
          ) : null}
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-on-surface-muted">
          <AppLink href={paths.repo(repo)} className="hover:underline">
            {item.repository.owner}/{item.repository.name}
          </AppLink>
          <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[11px]">
            <Icon name="gitBranch" size={11} />
            <span className="truncate">{showBidi(item.branch)}</span>
          </span>
          {item.agent !== null ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              <Icon name="bot" size={11} />
              <span className="truncate">{item.agent.displayName}</span>
            </span>
          ) : item.author?.username ? (
            <span>{item.author.username}</span>
          ) : null}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="text-on-surface-secondary">
          <span className="font-mono">
            {item.reviewedVersion === null ? "" : `v${item.reviewedVersion} to `}v
            {item.latestVersion}
          </span>
          {" · "}
          {changesSentence(item)}
        </p>
        <p className="text-on-surface-muted">
          Waiting since <RelativeTime iso={item.waitingSince} />
        </p>
      </div>
    </li>
  );
}

export function InboxSection() {
  const inbox = usePages(["review", "inbox"], (cursor) =>
    api.review.inbox({ query: { ...cursorQuery(cursor), limit: 20 } }),
  );
  // A server without the inbox: the home page is as it was.
  if (isUnavailable(inbox.error)) return null;
  return (
    <section aria-labelledby="home-inbox" className="space-y-2">
      <h2 id="home-inbox" className="text-sm font-semibold text-on-surface">
        Waiting on you
      </h2>
      {inbox.error ? (
        <ErrorState error={inbox.error} />
      ) : inbox.isLoading ? (
        <Loading count={3} />
      ) : (
        <Panel>
          {inbox.items.length === 0 ? (
            <EmptyState>Nothing is waiting on you</EmptyState>
          ) : (
            <ul aria-label="Branches waiting on you" className="divide-y divide-border">
              {inbox.items.map((item) => (
                <InboxRow key={`${item.repository.id}#${item.number}`} item={item} />
              ))}
            </ul>
          )}
        </Panel>
      )}
      <LoadMore pages={inbox} />
    </section>
  );
}
