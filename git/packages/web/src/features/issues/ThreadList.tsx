/**
 * The list both Issues and Pull requests show: a search box whose text is the
 * list's whole state, Open and Closed counts, filter menus that edit the
 * text, and the rows.
 *
 * In the sidebar shell the same list is drawn as the lists of work are (one
 * line a row, `WorkRow`), and a repository's pull requests are its branches.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueSummary, PullRequestSummary } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { queries, usePages } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { Badge, CommitStatusIcon } from "../../components/Badge";
import { ButtonLink } from "../../components/Button";
import { SearchInput } from "../../components/forms";
import { Icon, type IconName } from "../../components/icons";
import { LabelChip, LabelDot } from "../../components/LabelChip";
import { Page, Panel } from "../../components/Panel";
import { Avatar, RelativeTime, UserLink } from "../../components/people";
import { Picker, PickerButton, type PickerOption } from "../../components/Picker";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { ThreadStateIcon, issueKind, pullKind } from "../../components/StatusIcons";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatCount } from "../../lib/format";
import { paths, type RepoRef } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";
import { useSidebarShell } from "../../lib/shell";
import { ChangeStateIcon, Chip, WorkRow, personOf, type RowPerson } from "../workspace/rows";
import {
  DEFAULT_SEARCH_TEXT,
  EMPTY_SEARCH,
  editSearch,
  formatSearch,
  isFiltered,
  parseSearch,
  toListQuery,
  type SearchSort,
  type ThreadSearch,
} from "./search";
import { cursorQuery } from "../../lib/cursor";

type Kind = "issues" | "pulls";
type Row = IssueSummary | PullRequestSummary;

interface ListPage {
  readonly items: ReadonlyArray<Row>;
  readonly nextCursor: string | null;
  readonly counts: { readonly open: number; readonly closed: number };
}

const isPull = (row: Row): row is PullRequestSummary => "headRef" in row;

const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "created-desc", label: "Newest" },
  { value: "created-asc", label: "Oldest" },
  { value: "updated-desc", label: "Recently updated" },
  { value: "comments-desc", label: "Most commented" },
];

const REVIEW_LABEL = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
} as const;

export function ThreadList({ kind, q }: { kind: Kind; q: string | undefined }) {
  const repo = useRepoRef();
  const repository = useRepository();
  const go = useGo();
  const session = useSession();
  const signedIn = session.data?.user != null;
  const text = q ?? DEFAULT_SEARCH_TEXT;
  const search = parseSearch(text);
  const href = (next: string) => threadListHref(repo, kind, next);
  const edit = (patch: Partial<ThreadSearch>) => go(href(editSearch(text, patch)));

  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);

  const labels = useQuery(queries.labels.list({ params: repo }));
  const milestones = useQuery(queries.milestones.list({ params: repo, query: { state: "all" } }));
  const people = useQuery(queries.collaborators.listAssignable({ params: repo }));

  const listQuery = toListQuery(search, milestones.data?.milestones ?? []);
  const needsMilestones = search.milestone !== null && search.milestone !== "none";
  const list = usePages<ListPage>(
    [kind, "list", repo, listQuery],
    (cursor) => {
      if (kind === "pulls") {
        return api.pulls.list({
          params: repo,
          query: { ...listQuery, ...cursorQuery(cursor), limit: 25 },
        });
      }
      const {
        draft: _draft,
        reviewer: _reviewer,
        base: _base,
        head: _head,
        state,
        ...rest
      } = listQuery;
      return api.issues.list({
        params: repo,
        query: {
          ...rest,
          state: state === "merged" ? "closed" : state,
          ...cursorQuery(cursor),
          limit: 25,
        },
      });
    },
    { enabled: !needsMilestones || milestones.data !== undefined },
  );
  const counts = list.pages[0]?.counts;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    go(href(draft.trim()));
  };

  const userOptions: PickerOption[] = (people.data?.users ?? []).flatMap((user) =>
    user.username === null
      ? []
      : [
          {
            value: user.username,
            label: user.username,
            detail: user.displayName,
            leading: (
              <Avatar name={user.displayName ?? user.username} src={user.avatarUrl} size={16} />
            ),
          },
        ],
  );
  const sidebar = useSidebarShell();
  // In the sidebar shell a pull request is read as its branch.
  const branches = sidebar && kind === "pulls";
  const noun = kind === "issues" ? "issue" : "pull request";
  const [thing, things] =
    kind === "issues"
      ? ["issue", "issues"]
      : branches
        ? ["branch", "branches"]
        : ["pull request", "pull requests"];
  const heading = kind === "issues" ? "Issues" : branches ? "Branches" : "Pull requests";
  const canOpen = kind === "issues" || repository.branchCount > 1;

  const stateTab = (state: "open" | "closed", count: number | undefined, icon: ReactNode) => (
    <AppLink
      href={href(editSearch(text, { state }))}
      aria-current={search.state === state ? "true" : undefined}
      className={`inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xs ${
        search.state === state
          ? "font-semibold text-on-surface"
          : "text-on-surface-muted hover:text-on-surface"
      }`}
    >
      {icon}
      {count === undefined ? "" : `${formatCount(count)} `}
      {state === "open" ? "Open" : "Closed"}
    </AppLink>
  );

  return (
    <Page>
      <h1 className="sr-only">{heading}</h1>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <form role="search" onSubmit={submit} className="min-w-56 flex-1">
          <SearchInput
            label={`Search ${things}`}
            placeholder="is:open label:bug author:@me"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </form>
        <ButtonLink href={paths.labels(repo)}>
          <Icon name="tag" size={12} />
          Labels
        </ButtonLink>
        <ButtonLink href={paths.milestones(repo)}>
          <Icon name="milestone" size={12} />
          Milestones
        </ButtonLink>
        {kind === "pulls" && signedIn && repository.viewer.canPush && !repository.archived ? (
          <ButtonLink href={paths.startWork(repo)} variant={branches ? "primary" : "secondary"}>
            <Icon name="bot" size={12} />
            Start work
          </ButtonLink>
        ) : null}
        {repository.archived ? null : signedIn ? (
          canOpen ? (
            <ButtonLink
              variant={branches ? "secondary" : "primary"}
              href={kind === "issues" ? paths.newIssue(repo) : paths.newPull(repo)}
            >
              New {noun}
            </ButtonLink>
          ) : null
        ) : (
          <a href={signInHref()} className="text-xs text-on-surface-secondary hover:underline">
            Sign in to open one
          </a>
        )}
      </div>

      <Panel className={`overflow-visible ${sidebar ? "!rounded-lg" : ""}`}>
        <div
          className={`flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-border ${
            sidebar
              ? "min-h-12 rounded-t-lg py-1.5 pr-3 pl-3.5"
              : "min-h-10 rounded-t-md bg-surface-inset px-2 py-1"
          }`}
        >
          <div className="flex flex-1 items-center gap-2">
            {stateTab(
              "open",
              counts?.open,
              <Icon
                name={kind === "issues" ? "circleDot" : branches ? "gitBranch" : "gitPullRequest"}
                size={13}
              />,
            )}
            {stateTab("closed", counts?.closed, <Icon name="check" size={13} />)}
            {isFiltered(search) ? (
              <AppLink
                href={href(formatSearch({ ...EMPTY_SEARCH, state: search.state }))}
                className="ml-1 inline-flex items-center gap-1 text-xs text-on-surface-muted hover:text-on-surface"
              >
                <Icon name="x" size={11} />
                Clear filters
              </AppLink>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center">
            <Picker
              label="Authors"
              align="end"
              options={userOptions}
              selected={search.author === null ? [] : [search.author]}
              onChange={([author]) => edit({ author: author ?? null })}
              loading={people.isLoading}
              trigger={({ props }) => (
                <PickerButton {...props} active={search.author !== null}>
                  Author
                </PickerButton>
              )}
            />
            <Picker
              label="Labels"
              align="end"
              multiple
              options={(labels.data?.labels ?? []).map((label) => ({
                value: label.name,
                label: label.name,
                detail: label.description,
                leading: <LabelDot color={label.color} />,
              }))}
              selected={search.labels}
              onChange={(next) => edit({ labels: next })}
              loading={labels.isLoading}
              emptyText="No labels"
              trigger={({ props }) => (
                <PickerButton {...props} active={search.labels.length > 0}>
                  Label
                </PickerButton>
              )}
            />
            <Picker
              label="Milestones"
              align="end"
              options={[
                { value: "none", label: "No milestone" },
                ...(milestones.data?.milestones ?? []).map((item) => ({
                  value: item.title,
                  label: item.title,
                  detail: item.state === "closed" ? "Closed" : null,
                })),
              ]}
              selected={search.milestone === null ? [] : [search.milestone]}
              onChange={([milestone]) => edit({ milestone: milestone ?? null })}
              loading={milestones.isLoading}
              trigger={({ props }) => (
                <PickerButton {...props} active={search.milestone !== null}>
                  Milestone
                </PickerButton>
              )}
            />
            <Picker
              label="Assignees"
              align="end"
              options={[{ value: "none", label: "Assigned to nobody" }, ...userOptions]}
              selected={search.assignee === null ? [] : [search.assignee]}
              onChange={([assignee]) => edit({ assignee: assignee ?? null })}
              loading={people.isLoading}
              trigger={({ props }) => (
                <PickerButton {...props} active={search.assignee !== null}>
                  Assignee
                </PickerButton>
              )}
            />
            <Picker
              label="Sort"
              align="end"
              filterable={false}
              options={SORT_OPTIONS}
              selected={[`${search.sort}-${search.direction}`]}
              onChange={([value]) => {
                const [sort, direction] = (value ?? "created-desc").split("-");
                edit({ sort: sort as SearchSort, direction: direction === "asc" ? "asc" : "desc" });
              }}
              trigger={({ props }) => (
                <PickerButton
                  {...props}
                  active={search.sort !== "created" || search.direction !== "desc"}
                >
                  Sort
                </PickerButton>
              )}
            />
          </div>
        </div>

        {list.error ? (
          <ErrorState error={list.error} />
        ) : list.isLoading || (needsMilestones && milestones.data === undefined) ? (
          <Loading framed={false} />
        ) : list.items.length === 0 ? (
          (counts?.open ?? 0) + (counts?.closed ?? 0) === 0 && !isFiltered(search) ? (
            <EmptyState
              action={
                signedIn && canOpen && !repository.archived ? (
                  <ButtonLink href={kind === "issues" ? paths.newIssue(repo) : paths.newPull(repo)}>
                    New {noun}
                  </ButtonLink>
                ) : undefined
              }
            >
              No {things} yet
            </EmptyState>
          ) : (
            <EmptyState
              action={
                isFiltered(search) ? (
                  <ButtonLink href={href(DEFAULT_SEARCH_TEXT)}>Clear filters</ButtonLink>
                ) : undefined
              }
            >
              No {things} match
            </EmptyState>
          )
        ) : (
          <ul aria-label={heading} className={sidebar ? "divide-y divide-border" : ""}>
            {list.items.map((row) =>
              sidebar ? (
                <ThreadWorkRow
                  key={row.id}
                  row={row}
                  labelHref={(name) => href(editSearch(text, { labels: [name] }))}
                />
              ) : (
                <ThreadRow
                  key={row.id}
                  row={row}
                  labelHref={(name) => href(editSearch(text, { labels: [name] }))}
                />
              ),
            )}
          </ul>
        )}
      </Panel>
      <LoadMore pages={list} />
    </Page>
  );
}

function ThreadRow({ row, labelHref }: { row: Row; labelHref: (name: string) => string }) {
  const repo = useRepoRef();
  const pull = isPull(row);
  const kind = pull ? pullKind(row.state, row.draft) : issueKind(row.state, row.stateReason);
  const closed = row.state !== "open";
  return (
    <li className="flex items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0 hover:bg-surface-inset">
      <span className="mt-0.5">
        <ThreadStateIcon kind={kind} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <AppLink
            href={pull ? paths.pull(repo, row.number) : paths.issue(repo, row.number)}
            className="text-sm font-medium text-on-surface hover:underline"
          >
            {row.title}
          </AppLink>
          {pull ? <CommitStatusIcon state={row.status} /> : null}
          {row.labels.map((label) => (
            <LabelChip key={label.id} label={label} href={labelHref(label.name)} />
          ))}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-on-surface-muted">
          <span>#{row.number}</span>
          {pull && row.state === "merged" && row.mergedAt !== null ? (
            <span>
              merged <RelativeTime iso={row.mergedAt} />
            </span>
          ) : closed && row.closedAt !== null ? (
            <span>
              closed <RelativeTime iso={row.closedAt} />
            </span>
          ) : (
            <span>
              opened <RelativeTime iso={row.createdAt} />
            </span>
          )}
          {row.author !== null ? (
            <span className="inline-flex items-center gap-1">
              by <UserLink user={row.author} className="font-normal text-on-surface-secondary" />
            </span>
          ) : null}
          {pull && row.draft && row.state === "open" ? <Badge tone="outline">Draft</Badge> : null}
          {pull && row.reviewDecision !== null && row.state === "open" ? (
            <span
              className={
                row.reviewDecision === "approved"
                  ? "text-success"
                  : row.reviewDecision === "changes_requested"
                    ? "text-danger"
                    : ""
              }
            >
              {REVIEW_LABEL[row.reviewDecision]}
            </span>
          ) : null}
          {row.milestone !== null ? (
            <AppLink
              href={paths.milestone(repo, row.milestone.number)}
              className="inline-flex items-center gap-1 hover:text-on-surface"
            >
              <Icon name="milestone" size={11} />
              {row.milestone.title}
            </AppLink>
          ) : null}
          {row.locked ? (
            <span className="inline-flex items-center gap-1">
              <Icon name="lock" size={11} />
              Locked
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 pt-0.5">
        {row.assignees.length > 0 ? (
          <span
            className="flex -space-x-1"
            title={`Assigned to ${row.assignees.map((user) => user.username ?? user.displayName).join(", ")}`}
          >
            {row.assignees.slice(0, 3).map((user) => (
              <Avatar
                key={user.id}
                name={user.displayName ?? user.username ?? "?"}
                src={user.avatarUrl}
                size={18}
              />
            ))}
            <span className="sr-only">
              Assigned to{" "}
              {row.assignees.map((user) => user.username ?? user.displayName).join(", ")}
            </span>
          </span>
        ) : null}
        {row.commentCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
            <Icon name="messageSquare" size={12} />
            <span className="sr-only">Comments:</span>
            {row.commentCount}
          </span>
        ) : null}
      </div>
    </li>
  );
}

const ISSUE_GLYPH: Record<string, { icon: IconName; tone: string; label: string }> = {
  "issue-open": { icon: "circleDot", tone: "text-on-surface-secondary", label: "Open issue" },
  "issue-closed": { icon: "checkCircle", tone: "text-notice", label: "Closed issue" },
  "issue-not-planned": {
    icon: "circleSlash",
    tone: "text-on-surface-muted",
    label: "Closed as not planned",
  },
};

/** A thread's state as the lists of work draw one: a branch's by where its review stands. */
function WorkStateIcon({ row }: { row: Row }) {
  if (isPull(row)) {
    return (
      <ChangeStateIcon
        draft={row.draft}
        state={
          row.state === "merged"
            ? "merged"
            : row.state === "closed"
              ? "closed"
              : row.reviewDecision === "approved"
                ? "approved"
                : row.reviewDecision === "changes_requested"
                  ? "changes_requested"
                  : "needs_review"
        }
      />
    );
  }
  const { icon, tone, label } = ISSUE_GLYPH[issueKind(row.state, row.stateReason)]!;
  return (
    <span role="img" aria-label={label} title={label} className={`inline-flex shrink-0 ${tone}`}>
      <Icon name={icon} size={16} />
    </span>
  );
}

/** The same thread as `ThreadRow` shows, on one line: the row of the sidebar shell's lists. */
function ThreadWorkRow({ row, labelHref }: { row: Row; labelHref: (name: string) => string }) {
  const repo = useRepoRef();
  const pull = isPull(row);
  // The author first, then whoever it is assigned to, each once.
  const people: RowPerson[] = [];
  for (const user of [row.author, ...row.assignees]) {
    const person = personOf(user);
    if (person !== null && !people.some((known) => known.name === person.name)) people.push(person);
  }
  return (
    <WorkRow
      href={pull ? paths.pull(repo, row.number) : paths.issue(repo, row.number)}
      icon={<WorkStateIcon row={row} />}
      title={row.title}
      summary={
        <span className="inline-flex items-center gap-2.5">
          <span className="tabular-nums">#{row.number}</span>
          {pull ? <span className="truncate font-mono text-xs">{row.headRef}</span> : null}
        </span>
      }
      chips={
        // Above the row's own link, so a label and a milestone can be followed.
        <span className="relative z-10 flex items-center gap-2 text-xs text-on-surface-muted">
          {pull ? <CommitStatusIcon state={row.status} /> : null}
          {pull && row.reviewDecision === "review_required" && row.state === "open" ? (
            <Chip icon="eye">{REVIEW_LABEL.review_required}</Chip>
          ) : null}
          {row.labels.map((label) => (
            <LabelChip key={label.id} label={label} href={labelHref(label.name)} />
          ))}
          {row.milestone !== null ? (
            <AppLink
              href={paths.milestone(repo, row.milestone.number)}
              className="inline-flex items-center gap-1 hover:text-on-surface"
            >
              <Icon name="milestone" size={12} />
              {row.milestone.title}
            </AppLink>
          ) : null}
          {row.locked ? (
            <span role="img" aria-label="Locked" title="Locked" className="inline-flex">
              <Icon name="lock" size={12} />
            </span>
          ) : null}
          {row.commentCount > 0 ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Icon name="messageCircle" size={12} />
              <span className="sr-only">Comments:</span>
              {row.commentCount}
            </span>
          ) : null}
        </span>
      }
      people={people}
      at={row.updatedAt}
    />
  );
}

/**
 * A list's URL for a search text. The default search has no `?q=`; a search
 * for everything is `is:all`, since an empty `?q=` would read as the default.
 */
export function threadListHref(repo: RepoRef, kind: Kind, text: string): string {
  const q = text === DEFAULT_SEARCH_TEXT ? undefined : text === "" ? "is:all" : text;
  return kind === "issues" ? paths.issueSearch(repo, q) : paths.pullSearch(repo, q);
}

/** For a page that reaches a list with one filter: a milestone's threads, a label's. */
export function threadSearchHref(repo: RepoRef, kind: Kind, patch: Partial<ThreadSearch>): string {
  return threadListHref(repo, kind, editSearch(DEFAULT_SEARCH_TEXT, patch));
}
