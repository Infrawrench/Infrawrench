/**
 * The list both Issues and Branches show: a search box whose text is the
 * list's whole state, Open and Closed counts, filter menus that edit the
 * text, and the rows, one line each as the lists of work are (`WorkRow`).
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BranchPageSummary, IssueSummary } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { queries, usePages } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { CommitStatusIcon } from "../../components/Badge";
import { ButtonLink } from "../../components/Button";
import { SearchInput } from "../../components/forms";
import { Icon, type IconName } from "../../components/icons";
import { LabelChip, LabelDot } from "../../components/LabelChip";
import { Page, Panel } from "../../components/Panel";
import { Avatar } from "../../components/people";
import { Picker, PickerButton, type PickerOption } from "../../components/Picker";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { issueKind } from "../../components/StatusIcons";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatCount } from "../../lib/format";
import { paths, type RepoRef } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";
import { ChangeStateIcon, Chip, WorkRow, personOf, type RowPerson } from "../workspace/rows";
import { importedAuthorName } from "./ImportedFrom";
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

export type ThreadListKind = "issues" | "branches";
type Kind = ThreadListKind;
type Row = IssueSummary | BranchPageSummary;

interface ListPage {
  readonly items: ReadonlyArray<Row>;
  readonly nextCursor: string | null;
  readonly counts: { readonly open: number; readonly closed: number };
}

const isPage = (row: Row): row is BranchPageSummary => "headRef" in row;

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

export function ThreadList({
  kind,
  q,
  lead,
}: {
  kind: Kind;
  q: string | undefined;
  /** Above the search: the Branches tab's two views. */
  lead?: ReactNode;
}) {
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
      if (kind === "branches") {
        return api.branches.list({
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
  const things = kind === "issues" ? "issues" : "branches";
  const heading = kind === "issues" ? "Issues" : "Branches";
  const canStart = signedIn && repository.viewer.canPush && !repository.archived;

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
      {lead}
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
        {kind === "branches" ? (
          canStart ? (
            <ButtonLink href={paths.startWork(repo)} variant="primary">
              <Icon name="bot" size={12} />
              Start work
            </ButtonLink>
          ) : null
        ) : repository.archived ? null : signedIn ? (
          <ButtonLink variant="primary" href={paths.newIssue(repo)}>
            New issue
          </ButtonLink>
        ) : (
          <a href={signInHref()} className="text-xs text-on-surface-secondary hover:underline">
            Sign in to open one
          </a>
        )}
      </div>

      <Panel className="overflow-visible !rounded-lg">
        <div className="flex min-h-12 flex-wrap items-center gap-x-1 gap-y-1 rounded-t-lg border-b border-border py-1.5 pr-3 pl-3.5">
          <div className="flex flex-1 items-center gap-2">
            {stateTab(
              "open",
              counts?.open,
              <Icon name={kind === "issues" ? "circleDot" : "gitBranch"} size={13} />,
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
                kind === "branches" ? (
                  // A fork's own branches have no pages: they are proposed from the list of them.
                  repository.parent !== null ? (
                    <ButtonLink href={paths.branches(repo, { view: "all" })}>
                      All branches
                    </ButtonLink>
                  ) : canStart ? (
                    <ButtonLink href={paths.startWork(repo)}>Start work</ButtonLink>
                  ) : undefined
                ) : signedIn && !repository.archived ? (
                  <ButtonLink href={paths.newIssue(repo)}>New issue</ButtonLink>
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
          <ul aria-label={heading} className="divide-y divide-border">
            {list.items.map((row) => (
              <ThreadWorkRow
                key={row.id}
                row={row}
                labelHref={(name) => href(editSearch(text, { labels: [name] }))}
              />
            ))}
          </ul>
        )}
      </Panel>
      <LoadMore pages={list} />
    </Page>
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
  if (isPage(row)) {
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

/** A thread on one line. A branch is named by its branch, an issue by its number. */
function ThreadWorkRow({ row, labelHref }: { row: Row; labelHref: (name: string) => string }) {
  const repo = useRepoRef();
  const page = isPage(row) ? row : null;
  // The author first, then whoever it is assigned to, each once.
  const people: RowPerson[] = [];
  // An imported issue whose author has no account here: their name at the source.
  const importedAuthor =
    page === null && row.author === null && "imported" in row
      ? importedAuthorName(row.imported)
      : null;
  if (importedAuthor !== null) people.push({ name: importedAuthor });
  for (const user of [row.author, ...row.assignees]) {
    const person = personOf(user);
    if (person !== null && !people.some((known) => known.name === person.name)) people.push(person);
  }
  return (
    <WorkRow
      href={page !== null ? paths.branchPage(repo, page.key) : paths.issue(repo, row.number)}
      icon={<WorkStateIcon row={row} />}
      title={row.title}
      summary={
        page !== null ? (
          <span className="truncate font-mono text-xs">{page.headRef}</span>
        ) : (
          <span className="tabular-nums">#{row.number}</span>
        )
      }
      chips={
        // Above the row's own link, so a label and a milestone can be followed.
        <span className="relative z-10 flex items-center gap-2 text-xs text-on-surface-muted">
          {page !== null ? <CommitStatusIcon state={page.status} /> : null}
          {page !== null && page.crossRepository ? (
            <span
              title={
                page.headRepository === null
                  ? "From a deleted fork"
                  : `From ${page.headRepository.owner}/${page.headRepository.name}`
              }
            >
              <Chip icon="gitFork">
                from fork
                <span className="sr-only">
                  {page.headRepository === null
                    ? " that was deleted"
                    : ` ${page.headRepository.owner}/${page.headRepository.name}`}
                </span>
              </Chip>
            </span>
          ) : null}
          {page !== null && page.reviewDecision === "review_required" && page.state === "open" ? (
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
  return kind === "issues" ? paths.issueSearch(repo, q) : paths.branches(repo, { q });
}

/** For a page that reaches a list with one filter: a milestone's threads, a label's. */
export function threadSearchHref(repo: RepoRef, kind: Kind, patch: Partial<ThreadSearch>): string {
  return threadListHref(repo, kind, editSearch(DEFAULT_SEARCH_TEXT, patch));
}
