/** Findings, review runs and merge overrides as the contract's shapes. */
import {
  type MergeOverride,
  type ReviewFinding,
  type ReviewRun,
  accessAtLeast,
} from "@infrawrench/git-contract";
import {
  type FindingRow,
  type MergeOverrideRow,
  type ReviewRunRow,
  findingCountsByRun,
} from "../../db/findings";
import { overriddenFindingIds } from "../../db/review";
import type { RepoCx } from "../context";
import { iso, isoOrNull, peopleById } from "./repositories";

/** A person or an API key that may triage. A CI job reports findings and decides nothing about them. */
export const mayDismiss = (cx: RepoCx): boolean =>
  cx.principal.kind !== "job" &&
  cx.principal.kind !== "anonymous" &&
  accessAtLeast(cx.access, "triage");

export const findingViews = async (
  cx: RepoCx,
  pullRequestId: string,
  rows: readonly FindingRow[],
): Promise<ReviewFinding[]> => {
  const [person, overridden] = await Promise.all([
    peopleById(rows.map((row) => row.dismissedByUserId)),
    overriddenFindingIds(pullRequestId),
  ]);
  const canDismiss = mayDismiss(cx);
  return rows.map((row) => ({
    id: row.id,
    reviewerKind: row.reviewerKind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    path: row.path,
    side: row.side,
    startLine: row.startLine,
    endLine: row.endLine,
    needsCode: row.needsCode,
    commitOid: row.commitOid,
    evidence: row.evidence.map((evidence) => ({
      kind: evidence.kind,
      text: evidence.text,
      url: evidence.url ?? null,
    })),
    status: row.status,
    version: row.versionNumber,
    lastSeenVersion: row.lastSeenVersionNumber,
    fixedInVersion: row.fixedInVersionNumber,
    dismissedBy: person(row.dismissedByUserId),
    dismissedAt: isoOrNull(row.dismissedAt),
    dismissalReason: row.dismissalReason,
    overridden: overridden.has(row.id),
    runId: row.runId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    viewerCanDismiss: canDismiss && row.status === "open",
  }));
};

export const findingView = async (
  cx: RepoCx,
  pullRequestId: string,
  row: FindingRow,
): Promise<ReviewFinding> => (await findingViews(cx, pullRequestId, [row]))[0]!;

export const reviewRunViews = async (rows: readonly ReviewRunRow[]): Promise<ReviewRun[]> => {
  const [person, counts] = await Promise.all([
    peopleById(rows.map((row) => row.requestedByUserId)),
    findingCountsByRun(rows.map((row) => row.id)),
  ]);
  return rows.map((row) => ({
    id: row.id,
    version: row.versionNumber,
    headOid: row.headOid,
    status: row.status,
    reviewerKinds: row.reviewerKinds,
    trigger: row.trigger,
    requestedBy: person(row.requestedByUserId),
    model: row.model,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costMicros / 1_000_000,
    },
    findingCount: counts.get(row.id) ?? 0,
    error: row.error,
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    createdAt: iso(row.createdAt),
  }));
};

export const reviewRunView = async (row: ReviewRunRow): Promise<ReviewRun> =>
  (await reviewRunViews([row]))[0]!;

export const mergeOverrideView = async (row: MergeOverrideRow): Promise<MergeOverride> => {
  const person = await peopleById([row.userId]);
  return {
    id: row.id,
    by: person(row.userId),
    reason: row.reason,
    findingIds: row.findingIds,
    headOid: row.headOid,
    createdAt: iso(row.createdAt),
  };
};
