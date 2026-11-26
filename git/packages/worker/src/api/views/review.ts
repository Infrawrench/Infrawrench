/**
 * Review rows as the contract's shapes: a branch's versions, the agent
 * behind it, and the state its page opens with.
 */
import type {
  AgentLink,
  BranchPageState,
  BranchPageStateName,
  BranchVersion,
} from "@infrawrench/git-contract";
import type { PullRequestWithThread } from "../../db/pulls";
import {
  type AgentLinkRow,
  type VersionRow,
  findingsCount,
  getAgentLink,
  getReviewSettings,
  getReviewedMark,
  latestRunStatus,
  openInstructionCount,
  pendingTraceCount,
  versionCounts,
  versionsForPull,
} from "../../db/review";
import type { RepoCx } from "../context";
import { mergeabilityDetail } from "./pulls";
import { iso, peopleById } from "./repositories";

export const versionViews = async (
  pullRequestId: string,
  rows: readonly VersionRow[],
): Promise<BranchVersion[]> => {
  const [person, counts] = await Promise.all([
    peopleById(rows.map((row) => row.pusherUserId)),
    versionCounts(pullRequestId, rows),
  ]);
  return rows.map((row, index) => {
    const count = counts.get(row.number);
    const before = rows[index - 1];
    return {
      id: row.id,
      number: row.number,
      lineage: row.lineage,
      tipOid: row.tipOid,
      baseOid: row.baseOid,
      previousOid: row.previousOid,
      forced: row.forced,
      rebased: before !== undefined && before.baseOid !== row.baseOid,
      pusher: person(row.pusherUserId),
      pusherKind: row.pusherKind,
      agent: row.agent
        ? { kind: row.agent.kind, name: row.agent.name, sessionRef: row.agent.sessionRef ?? null }
        : null,
      commitCount: row.commitsCount,
      stats:
        row.additions === null || row.deletions === null || row.changedFiles === null
          ? null
          : {
              filesChanged: row.changedFiles,
              additions: row.additions,
              deletions: row.deletions,
            },
      counts: {
        comments: count?.comments ?? 0,
        findings: count?.findings ?? 0,
        traceEntries: count?.traceEntries ?? 0,
        answeredInstructions: count?.answeredInstructions ?? 0,
      },
      hasTrace: (count?.traceEntries ?? 0) > 0,
      reviewStatus: count?.reviewStatus ?? null,
      createdAt: iso(row.createdAt),
    };
  });
};

export const agentLinkView = async (row: AgentLinkRow): Promise<AgentLink> => {
  const person = await peopleById([row.connectedByUserId]);
  return {
    kind: row.kind,
    displayName: row.displayName,
    externalRefs: row.externalRefs,
    t3EnvironmentId: row.t3EnvironmentId,
    connectedBy: person(row.connectedByUserId),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
};

/**
 * Where a branch stands, for the viewer. The first that holds, in the order
 * the contract gives (`BRANCH_PAGE_STATES`).
 */
export const branchPageState = async (
  cx: RepoCx,
  found: PullRequestWithThread,
): Promise<BranchPageState> => {
  const { thread, pull } = found;
  const [versions, mark, agent, openInstructions, pendingTraceEntries, findings, settings, merge] =
    await Promise.all([
      versionsForPull(pull),
      cx.userId ? getReviewedMark(pull.issueId, cx.userId) : null,
      getAgentLink(pull.issueId),
      openInstructionCount(pull.issueId),
      pull.headRepositoryId ? pendingTraceCount(pull.headRepositoryId, pull.headRef) : 0,
      findingsCount(pull.issueId),
      getReviewSettings(cx.repo.repository.id),
      mergeabilityDetail(cx, found),
    ]);
  const latest = versions.at(-1) ?? null;
  // A mark from a lineage before this one is of a branch that was made again.
  const reviewed = mark && latest && mark.lineage === latest.lineage ? mark.versionNumber : null;
  const unreviewed = versions.filter((version) => version.number > (reviewed ?? 0)).length;
  const checks = merge.mergeability.checks.state;
  // Pushed by the viewer's own hand, with no agent behind it, is not theirs to review.
  const theirs = latest !== null && latest.agent === null && latest.pusherUserId === cx.userId;

  let state: BranchPageStateName = "waiting";
  if (pull.mergedAt) state = "merged";
  else if (thread.state !== "open") state = "closed";
  else if (openInstructions > 0 || pendingTraceEntries > 0) state = "agent_working";
  else if (checks === "failure" || checks === "error") state = "checks_failing";
  else if (findings.mustFixOpen > 0) state = "must_fix_open";
  else if (cx.userId !== null && unreviewed > 0 && !theirs) state = "needs_your_review";
  else if (merge.mergeability.canMerge) state = "ready_to_merge";

  return {
    state,
    latestVersion: latest?.number ?? null,
    workingOnVersion: state === "agent_working" ? (latest?.number ?? 0) + 1 : null,
    viewerReviewedVersion: reviewed,
    unreviewedVersions: unreviewed,
    agent: agent ? await agentLinkView(agent) : null,
    openInstructions,
    pendingTraceEntries,
    findings,
    checks,
    reviewRun: latest ? await latestRunStatus(pull.issueId, latest.number) : null,
    canMerge: merge.mergeability.canMerge,
    settings: {
      reviewAgentsEnabled: settings.reviewAgentsEnabled,
      mustFixBlocksMerge: settings.mustFixBlocksMerge,
    },
  };
};
