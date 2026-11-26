/**
 * A branch's page, read as a record of versions, laid out as a document to
 * read from the top. The ask, the versions in a strip, the picked version's
 * diff the width of the page with its files beside it and its trace on its
 * lines, then what review agents found, the merge box and the conversation,
 * with the agent and the people beside those.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { BranchPageState } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { useGo } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Segmented } from "../../components/controls";
import { Icon } from "../../components/icons";
import { EmptyState, ErrorState, InlineError, Loading } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { CommentForm } from "../issues/CommentForm";
import { LockControl, TriageFields } from "../issues/ThreadSidebar";
import { Timeline } from "../issues/Timeline";
import { ReviewEntry, Reviewers } from "../branch-page/Reviews";
import { InfrastructureBox } from "../branch-page/InfrastructureBox";
import { MergeBox } from "../branch-page/MergeBox";
import { refreshBranchPage, useBranchPage } from "../branch-page/BranchLayout";
import { ReviewButton } from "../branch-page/ReviewForm";
import { countThreads } from "../branch-page/review-threads";
import { AgentPanel } from "./Agent";
import { EMPTY_VIEW } from "./diff/focus";
import { Ask } from "./Ask";
import { DIFF_MODES, defaultSelection, isLive, showsFindings, type DiffMode } from "./branch";
import { LIVE_MS, useBranchState } from "./BranchNeeds";
import { FindingsPanel } from "./Findings";
import { InstructionsPanel, InstructionsProvider } from "./Instructions";
import { isUnavailable, optional } from "./optional";
import { TraceBlock } from "./Trace";
import { DiffBar, VersionDiff } from "./VersionDiff";
import { VersionRail } from "./VersionRail";

/** What moves when the agent pushes, records or answers: one change of it refetches the rest. */
const signature = (state: BranchPageState): string =>
  [
    state.latestVersion,
    state.pendingTraceEntries,
    state.openInstructions,
    state.reviewRun,
    state.findings.open,
    state.findings.fixed,
    state.agent?.updatedAt,
  ].join(":");

export function BranchPage({
  v,
  diff,
}: {
  /** The version picked in the address. */
  v: number | undefined;
  diff: DiffMode | undefined;
}) {
  const repo = useRepoRef();
  const repository = useRepository();
  const page = useBranchPage();
  const go = useGo();
  const { number, key } = page;
  const params = { ...repo, branch: key };

  const state = useBranchState(key);
  const live = isLive(state.data);
  const versions = useQuery(queries.versions.list({ params }));
  const traces = useQuery({
    ...optional(queries.traces.list({ params: repo, query: { branch: page.headRef, limit: 100 } })),
    refetchInterval: live ? LIVE_MS : false,
  });
  const findings = useQuery(optional(queries.findings.list({ params })));
  const instructions = useQuery(optional(queries.instructions.list({ params })));
  const reviews = useQuery(queries.branches.listReviews({ params }));
  const threads = useQuery(queries.branches.listThreads({ params }));
  const allThreads = useMemo(() => threads.data?.threads ?? [], [threads.data]);
  // Which files are open, and how far: kept while the page is, across versions and views.
  const [diffView, setDiffView] = useState(EMPTY_VIEW);
  const counts = countThreads(allThreads);

  // A push, a recorded step or an answer shows in the state first: everything else follows it.
  const mark = state.data === undefined ? null : signature(state.data);
  const before = useRef(mark);
  useEffect(() => {
    if (before.current !== null && mark !== null && before.current !== mark) {
      void invalidate("versions", "list");
      void invalidate("traces");
      void invalidate("findings");
      void invalidate("instructions");
      refreshBranchPage();
    }
    before.current = mark;
  }, [mark]);

  const update = useMutation({
    mutationFn: (payload: Parameters<typeof api.branches.update>[0]["payload"]) =>
      api.branches.update({ params, payload }),
    onSuccess: refreshBranchPage,
  });
  const close = useMutation({
    mutationFn: () => api.branches.close({ params }),
    onSuccess: refreshBranchPage,
  });
  const reopen = useMutation({
    mutationFn: () => api.branches.reopen({ params }),
    onSuccess: refreshBranchPage,
  });
  const toDraft = useMutation({
    mutationFn: () => api.branches.setDraft({ params, payload: { draft: true } }),
    onSuccess: refreshBranchPage,
  });
  const reviewed = useMutation({
    mutationFn: (version: number) =>
      api.versions.markReviewed({ params: { ...params, version: String(version) } }),
    onSuccess: (_mark, version) => {
      void invalidate("versions");
      void invalidate("review", "inbox");
      // "Since you last looked" is now empty: show the version itself.
      go(paths.branchPage(repo, key, { v: version, diff: "whole" }), { replace: true });
    },
  });

  if (versions.error) return <ErrorState error={versions.error} />;
  if (versions.data === undefined) return <Loading shape="code" />;
  const list = versions.data;
  const start = defaultSelection(list);
  const selected = list.versions.find((item) => item.number === (v ?? start.version)) ?? null;
  const mode: DiffMode = diff ?? (v === undefined ? start.mode : "whole");
  const pick = (next: { v?: number; diff?: DiffMode }) =>
    go(
      paths.branchPage(repo, key, {
        ...(selected === null ? {} : { v: selected.number }),
        diff: mode,
        ...next,
      }),
      { replace: true },
    );
  const lastReviewed = list.viewerReviewed;
  const nothingNew =
    mode === "since" &&
    selected !== null &&
    lastReviewed !== null &&
    lastReviewed >= selected.number;
  const canSend = repository.viewer.canPush && page.state === "open";
  // Off means the forge's own agents do not run, not that nothing was found.
  const agentsEnabled = state.data?.settings.reviewAgentsEnabled !== false;
  const pending = (traces.data?.items ?? []).filter((entry) => entry.version === null);

  // The strip above the diff: what to compare at its start, the reviewed mark at its end.
  const compare =
    selected === null ? null : (
      <Segmented<DiffMode>
        label="What to compare"
        value={mode}
        onChange={(next) => pick({ diff: next })}
        options={DIFF_MODES.filter((option) => option.value !== "since" || lastReviewed !== null)}
      />
    );
  const reviewedMark =
    selected === null ? null : (
      <>
        <InlineError error={reviewed.error} />
        {page.viewer.canReview || lastReviewed !== null ? (
          (lastReviewed ?? 0) >= selected.number ? (
            <span className="inline-flex items-center gap-1 text-xs text-on-surface-muted">
              <Icon name="check" size={12} className="text-success" />
              Reviewed up to v{lastReviewed}
            </span>
          ) : (
            <Button
              size="sm"
              variant="primary"
              busy={reviewed.isPending}
              onClick={() => reviewed.mutate(selected.number)}
            >
              <Icon name="check" size={12} />
              Mark v{selected.number} reviewed
            </Button>
          )
        ) : null}
      </>
    );

  return (
    <InstructionsProvider
      value={{
        branchKey: key,
        instructions: isUnavailable(instructions.error)
          ? null
          : (instructions.data?.instructions ?? []),
        canSend,
      }}
    >
      {/* Read from the top: the ask, the versions, the change, then what settles it. */}
      <div className="space-y-8">
        <Ask
          author={page.author}
          createdAt={page.createdAt}
          body={page.body}
          edited={page.bodyEditedAt !== null}
          canEdit={page.viewer.canEdit}
          onSave={(body) => update.mutateAsync({ body })}
        />

        {list.versions.length === 0 ? (
          <EmptyState>
            {state.data?.state === "agent_working"
              ? "The agent has not pushed yet"
              : "Nothing pushed to this branch yet"}
          </EmptyState>
        ) : (
          <VersionRail
            versions={list.versions}
            selected={selected?.number ?? null}
            reviewed={lastReviewed}
            workingOn={state.data?.workingOnVersion ?? null}
            onSelect={(next) => pick({ v: next })}
          />
        )}

        {pending.length > 0 ? (
          <div className="diff-note max-w-3xl">
            <p className="border-b border-border bg-surface-inset px-3 py-1.5 text-xs text-on-surface-muted">
              Not pushed yet
            </p>
            <TraceBlock entries={pending} where label="Recorded since the last push" />
          </div>
        ) : null}

        {selected !== null ? (
          nothingNew ? (
            <section aria-label="Changes" className="space-y-4">
              <DiffBar lead={compare}>{reviewedMark}</DiffBar>
              <EmptyState>Nothing new in v{selected.number} since you last looked</EmptyState>
            </section>
          ) : (
            <VersionDiff
              key={`${selected.number}:${mode}`}
              version={selected}
              mode={mode}
              latest={selected.number === list.latest}
              traces={traces.data?.items ?? []}
              findings={findings.data?.findings ?? []}
              threads={allThreads}
              lead={compare}
              actions={reviewedMark}
              view={diffView}
              onView={setDiffView}
            />
          )
        ) : null}

        {/* What closes the page: the findings, the merge and the talk, with who and what beside them. */}
        <div className="grid gap-x-10 gap-y-6 border-t border-border pt-8 lg:grid-cols-[minmax(0,56rem)_18rem]">
          <div className="min-w-0 space-y-4">
            {findings.data !== undefined &&
            showsFindings({
              agentsEnabled,
              findings: findings.data.findings.length,
              run: state.data?.reviewRun ?? null,
            }) ? (
              <FindingsPanel
                findings={findings.data.findings}
                branchKey={key}
                version={list.latest}
                run={state.data?.reviewRun ?? null}
                canRun={canSend && agentsEnabled}
              />
            ) : null}

            <InfrastructureBox branchKey={key} />
            <MergeBox page={page} tally={findings.data?.tally ?? null} />

            <section aria-labelledby="branch-conversation" className="space-y-3 pt-4">
              <h2 id="branch-conversation" className="text-base font-semibold text-on-surface">
                Conversation
              </h2>
              <Timeline
                number={number}
                kind="branches"
                renderReview={(item) => <ReviewEntry item={item} />}
              />
              <CommentForm
                number={number}
                canComment={page.viewer.canComment}
                locked={page.locked}
                stateActions={({ body, post }) =>
                  page.state === "merged" || !page.viewer.canClose ? null : page.state ===
                    "open" ? (
                    <Button
                      busy={close.isPending}
                      onClick={() => void post().then(() => close.mutate())}
                    >
                      <Icon name="circleSlash" size={13} className="text-danger" />
                      {body.trim() === "" ? "Close" : "Close with comment"}
                    </Button>
                  ) : (
                    <Button
                      busy={reopen.isPending}
                      disabled={!page.headRefExists}
                      title={page.headRefExists ? undefined : "Restore the branch first"}
                      onClick={() => void post().then(() => reopen.mutate())}
                    >
                      Reopen
                    </Button>
                  )
                }
              />
              <InlineError error={update.error ?? close.error ?? reopen.error} />
            </section>
          </div>

          <aside aria-label="Details">
            {state.data !== undefined ? (
              <AgentPanel state={state.data} branchKey={key} canEdit={canSend} />
            ) : null}
            <InstructionsPanel />
            <div className="flex flex-wrap items-center gap-2 py-3">
              <ReviewButton pendingComments={counts.pending} />
              {counts.unresolved > 0 ? (
                <span className="text-xs text-on-surface-muted">
                  {counts.unresolved} unresolved
                </span>
              ) : null}
            </div>
            <Reviewers reviews={reviews.data?.reviews ?? []} />
            <div className="pt-3">
              <TriageFields
                kind="branches"
                canTriage={page.viewer.canTriage}
                shown={page}
                value={{
                  labels: page.labels.map((label) => label.name),
                  assignees: page.assignees.flatMap((user) => user.username ?? []),
                  milestone: page.milestone?.number ?? null,
                }}
                onChange={(next) =>
                  update.mutate({
                    labels: [...next.labels],
                    assignees: [...next.assignees],
                    milestone: next.milestone,
                  })
                }
              />
            </div>
            {page.state === "open" && !page.draft && page.viewer.canEdit ? (
              <section className="border-t border-border py-3">
                <button
                  type="button"
                  disabled={toDraft.isPending}
                  onClick={() => toDraft.mutate()}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface disabled:opacity-60"
                >
                  <Icon name="circleDashed" size={13} />
                  Convert to draft
                </button>
                <InlineError error={toDraft.error} />
              </section>
            ) : null}
            {page.viewer.canTriage ? (
              <div className="border-t border-border">
                <LockControl number={number} locked={page.locked} />
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </InstructionsProvider>
  );
}
