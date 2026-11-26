/**
 * The lists behind the home page: every branch of the workspace (Changes),
 * the branches waiting on the reader (Reviews) and the comments that name
 * them (Mentions). The same rows as home, with the filters in the bar.
 */
import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { api } from "../../api/client";
import { type Pages, usePages } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { buttonClass } from "../../components/Button";
import { Segmented } from "../../components/controls";
import { Icon } from "../../components/icons";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { showBidi } from "../../lib/bidi";
import { cursorQuery } from "../../lib/cursor";
import { plural } from "../../lib/format";
import { paths } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";
import { TopBar } from "../../layout/TopBar";
import { useWorkspaces } from "../../layout/workspace";
import { changesSentence } from "../review/Inbox";
import { ChangeRow, ChangeStateIcon, WorkCard, WorkRow, personOf } from "./rows";

/** The frame of a list page: its bar, then one card of rows that loads more. */
function ListPage({
  title,
  actions,
  pages,
  empty,
  children,
}: {
  title: string;
  actions?: ReactNode;
  pages: Pages<unknown> & { readonly isLoading: boolean; readonly error: unknown };
  empty: string;
  children: ReactNode;
}) {
  const session = useSession();
  const signedOut = session.data !== undefined && session.data.user === null;
  return (
    <>
      <TopBar title={title} actions={signedOut ? undefined : actions} />
      <div className="px-5 py-6 md:px-10 md:py-8">
        <div className="mx-auto w-full max-w-[1640px]">
          {signedOut ? (
            <EmptyState
              action={
                <a href={signInHref()} className={buttonClass("primary")}>
                  Sign in
                </a>
              }
            >
              Sign in to see your work
            </EmptyState>
          ) : pages.error ? (
            <ErrorState error={pages.error} />
          ) : pages.isLoading ? (
            <Loading count={6} />
          ) : (
            <WorkCard
              label={title}
              {...(pages.items.length === 0 ? { empty: <EmptyState>{empty}</EmptyState> } : {})}
            >
              {children}
            </WorkCard>
          )}
          <LoadMore pages={pages} />
        </div>
      </div>
    </>
  );
}

type StateFilter = "open" | "merged" | "all";
type AuthorFilter = "all" | "mine" | "team";

const oneOf = <T extends string>(
  value: string | null,
  options: ReadonlyArray<T>,
  fallback: T,
): T => ((options as ReadonlyArray<string>).includes(value ?? "") ? (value as T) : fallback);

export function ChangesPage() {
  const go = useGo();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const params = new URLSearchParams(searchStr);
  const state = oneOf<StateFilter>(params.get("state"), ["open", "merged", "all"], "open");
  const author = oneOf<AuthorFilter>(params.get("author"), ["all", "mine", "team"], "all");
  const { current } = useWorkspaces();
  const session = useSession();
  const signedIn = session.data !== undefined && session.data.user !== null;
  const namespace = current?.slug;
  const pages = usePages(
    ["workspace", "changes", namespace, state, author],
    (cursor) =>
      api.workspace.changes({
        query: {
          ...cursorQuery(cursor),
          limit: 30,
          state,
          author,
          ...(namespace === undefined ? {} : { namespace }),
        },
      }),
    { enabled: signedIn && current !== null },
  );
  const show = (next: { state?: StateFilter; author?: AuthorFilter }) => {
    const merged = { state, author, ...next };
    go(
      paths.changes({
        ...(merged.state === "open" ? {} : { state: merged.state }),
        ...(merged.author === "all" ? {} : { author: merged.author }),
      }),
      { replace: true },
    );
  };
  return (
    <ListPage
      title="Changes"
      pages={{ ...pages, isLoading: pages.isLoading || (signedIn && current === null) }}
      empty="No branches"
      actions={
        <>
          <Segmented<AuthorFilter>
            label="Author"
            value={author}
            onChange={(next) => show({ author: next })}
            options={[
              { value: "all", label: "Everyone" },
              { value: "mine", label: "Mine" },
              { value: "team", label: "Team" },
            ]}
          />
          <Segmented<StateFilter>
            label="State"
            value={state}
            onChange={(next) => show({ state: next })}
            options={[
              { value: "open", label: "Open" },
              { value: "merged", label: "Merged" },
              { value: "all", label: "All" },
            ]}
          />
        </>
      }
    >
      {pages.items.map((change) => (
        <ChangeRow
          key={`${change.repository.id}#${change.number}`}
          change={change}
          showRepository
        />
      ))}
    </ListPage>
  );
}

export function ReviewsPage() {
  const session = useSession();
  const signedIn = session.data !== undefined && session.data.user !== null;
  const pages = usePages(
    ["review", "inbox", "list"],
    (cursor) => api.review.inbox({ query: { ...cursorQuery(cursor), limit: 30 } }),
    { enabled: signedIn },
  );
  return (
    <ListPage title="Reviews" pages={pages} empty="Nothing is waiting on you">
      {pages.items.map((item) => {
        const repo = { owner: item.repository.owner, repo: item.repository.name };
        const author = personOf(item.author);
        return (
          <WorkRow
            key={`${item.repository.id}#${item.number}`}
            // Opens on what is new: the newest version against the one last reviewed.
            href={paths.branchPage(
              repo,
              item.number,
              item.reviewedVersion === null ? {} : { v: item.latestVersion, diff: "since" },
            )}
            icon={<ChangeStateIcon state="needs_review" draft={item.draft} />}
            title={item.title}
            summary={`${item.reviewedVersion === null ? "" : `v${item.reviewedVersion} to `}v${item.latestVersion}, ${changesSentence(item)}`}
            chips={
              <>
                {item.mustFixOpen > 0 ? (
                  <Badge tone="danger">{plural(item.mustFixOpen, "must fix", "must fix")}</Badge>
                ) : null}
                <span className="text-xs text-on-surface-muted">{item.repository.name}</span>
              </>
            }
            people={[
              ...(item.agent !== null ? [{ name: item.agent.displayName, agent: true }] : []),
              ...(author !== null ? [author] : []),
            ]}
            at={item.waitingSince}
          />
        );
      })}
    </ListPage>
  );
}

export function MentionsPage() {
  const session = useSession();
  const signedIn = session.data !== undefined && session.data.user !== null;
  const pages = usePages(
    ["workspace", "mentions"],
    (cursor) => api.workspace.mentions({ query: { ...cursorQuery(cursor), limit: 30 } }),
    { enabled: signedIn },
  );
  return (
    <ListPage title="Mentions" pages={pages} empty="Nobody has mentioned you">
      {pages.items.map((mention) => {
        const repo = { owner: mention.repository.owner, repo: mention.repository.name };
        const author = personOf(mention.author);
        return (
          <WorkRow
            key={mention.id}
            href={
              mention.isPullRequest
                ? paths.pull(repo, mention.number)
                : paths.issue(repo, mention.number)
            }
            icon={
              <span className="inline-flex shrink-0 text-on-surface-muted">
                <Icon
                  name={mention.kind === "review_comment" ? "messageSquare" : "atSign"}
                  size={16}
                />
              </span>
            }
            title={mention.title}
            summary={showBidi(mention.excerpt)}
            chips={<span className="text-xs text-on-surface-muted">{mention.repository.name}</span>}
            people={author !== null ? [author] : []}
            at={mention.createdAt}
          />
        );
      })}
    </ListPage>
  );
}
