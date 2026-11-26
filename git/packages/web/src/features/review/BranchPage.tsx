/**
 * The branch page: a pull request read as a record of versions, laid out as
 * a document to read from the top. The ask, the versions in a strip, the
 * picked version's diff the width of the page with its files beside it and
 * its trace on its lines, then what review agents found, the merge box and
 * the conversation, with the agent and the people beside those. It is the
 * pull request's own data, so everything the pull request page does is here
 * too.
 */
import { useEffect, useMemo, useRef } from "react";
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
import { ReviewEntry, Reviewers } from "../pulls/ConversationTab";
import { InfrastructureBox } from "../pulls/InfrastructureBox";
import { MergeBox } from "../pulls/MergeBox";
import { refreshPull, usePull } from "../pulls/PullLayout";
import { ReviewButton } from "../pulls/ReviewForm";
import { countThreads } from "../pulls/review-threads";
import { AgentPanel } from "./Agent";
import { Ask } from "./Ask";
import { DIFF_MODES, defaultSelection, isLive, type DiffMode } from "./branch";
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
  const pull = usePull();
  const go = useGo();
  const { number } = pull;
  const params = { ...repo, number };

  const state = useBranchState(number);
  const live = isLive(state.data);
  const versions = useQuery(queries.versions.list({ params }));
  const traces = useQuery({
    ...optional(queries.traces.list({ params: repo, query: { pull: number, limit: 100 } })),
    refetchInterval: live ? LIVE_MS : false,
  });
  const findings = useQuery(optional(queries.findings.list({ params })));
  const instructions = useQuery(optional(queries.instructions.list({ params })));
  const reviews = useQuery(queries.pulls.listReviews({ params }));
  const threads = useQuery(queries.pulls.listThreads({ params }));
  const allThreads = useMemo(() => threads.data?.threads ?? [], [threads.data]);
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
      refreshPull();
    }
    before.current = mark;
  }, [mark]);

  const update = useMutation({
    mutationFn: (payload: Parameters<typeof api.pulls.update>[0]["payload"]) =>
      api.pulls.update({ params, payload }),
    onSuccess: refreshPull,
  });
  const close = useMutation({
    mutationFn: () => api.pulls.close({ params }),
    onSuccess: refreshPull,
  });
  const reopen = useMutation({
    mutationFn: () => api.pulls.reopen({ params }),
    onSuccess: refreshPull,
  });
  const reviewed = useMutation({
    mutationFn: (version: number) =>
      api.versions.markReviewed({ params: { ...params, version: String(version) } }),
    onSuccess: (_mark, version) => {
      void invalidate("versions");
      void invalidate("review", "inbox");
      // "Since you last looked" is now empty: show the version itself.
      go(paths.branchPage(repo, number, { v: version, diff: "whole" }), { replace: true });
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
      paths.branchPage(repo, number, {
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
  const canSend = repository.viewer.canPush && pull.state === "open";
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
        {pull.viewer.canReview || lastReviewed !== null ? (
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
        number,
        instructions: isUnavailable(instructions.error)
          ? null
          : (instructions.data?.instructions ?? []),
        canSend,
      }}
    >
      {/* Read from the top: the ask, the versions, the change, then what settles it. */}
      <div className="space-y-8">
        <Ask
          author={pull.author}
          createdAt={pull.createdAt}
          body={pull.body}
          edited={pull.bodyEditedAt !== null}
          canEdit={pull.viewer.canEdit}
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
            />
          )
        ) : null}

        {/* What closes the page: the findings, the merge and the talk, with who and what beside them. */}
        <div className="grid gap-x-10 gap-y-6 border-t border-border pt-8 lg:grid-cols-[minmax(0,56rem)_18rem]">
          <div className="min-w-0 space-y-4">
            {findings.data !== undefined && state.data?.settings.reviewAgentsEnabled !== false ? (
              <FindingsPanel
                findings={findings.data.findings}
                number={number}
                version={list.latest}
                run={state.data?.reviewRun ?? null}
                canRun={canSend}
              />
            ) : null}

            <InfrastructureBox number={number} flush />
            <MergeBox pull={pull} tally={findings.data?.tally ?? null} flush />

            <section aria-labelledby="branch-conversation" className="space-y-3 pt-4">
              <h2 id="branch-conversation" className="text-base font-semibold text-on-surface">
                Conversation
              </h2>
              <Timeline
                number={number}
                kind="pulls"
                renderReview={(item) => <ReviewEntry item={item} branch />}
              />
              <CommentForm
                number={number}
                canComment={pull.viewer.canComment}
                locked={pull.locked}
                stateActions={({ body, post }) =>
                  pull.state === "merged" || !pull.viewer.canClose ? null : pull.state ===
                    "open" ? (
                    <Button
                      busy={close.isPending}
                      onClick={() => void post().then(() => close.mutate())}
                    >
                      <Icon name="gitPullRequestClosed" size={13} className="text-danger" />
                      {body.trim() === "" ? "Close" : "Close with comment"}
                    </Button>
                  ) : (
                    <Button
                      busy={reopen.isPending}
                      disabled={!pull.headRefExists}
                      title={pull.headRefExists ? undefined : "Restore the branch first"}
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
              <AgentPanel state={state.data} number={number} canEdit={canSend} />
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
                kind="pulls"
                canTriage={pull.viewer.canTriage}
                shown={pull}
                value={{
                  labels: pull.labels.map((label) => label.name),
                  assignees: pull.assignees.flatMap((user) => user.username ?? []),
                  milestone: pull.milestone?.number ?? null,
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
            {pull.viewer.canTriage ? (
              <div className="border-t border-border">
                <LockControl number={number} locked={pull.locked} />
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </InstructionsProvider>
  );
}
