/** Changes to a mock thread that an issue and a branch page share, each leaving its event. */
import type { UserRef } from "@infrawrench/git-contract";
import { unprocessable } from "./define";
import { requireUser, type RepositoryRecord } from "./db";
import { everyone } from "./settings-data";
import { event, syncCounts, threadsOf, touch, type ThreadRecord } from "./threads-data";

export interface ThreadChange {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly state?: "open" | "closed" | undefined;
  readonly stateReason?: "completed" | "not_planned" | null | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly assignees?: ReadonlyArray<string> | undefined;
  readonly milestone?: number | null | undefined;
}

export function userNamed(username: string): UserRef {
  const found = everyone().find((user) => user.username === username);
  if (!found) throw unprocessable(`No user named ${username}`);
  return found;
}

export function applyThreadChange(
  repo: RepositoryRecord,
  thread: ThreadRecord,
  change: ThreadChange,
): void {
  const actor = requireUser();
  const store = threadsOf(repo);
  const now = new Date().toISOString();
  if (change.title !== undefined && change.title !== thread.title) {
    thread.items.push(event("renamed", actor, now, { from: thread.title, to: change.title }));
    thread.title = change.title;
  }
  if (change.body !== undefined && change.body !== thread.body) {
    thread.body = change.body;
    thread.bodyEditedAt = now;
  }
  if (change.labels !== undefined) {
    const wanted = change.labels.map((name) => {
      const label = store.labels.find((item) => item.name === name);
      if (!label) throw unprocessable(`No label named ${name}`);
      return label;
    });
    for (const label of store.labels) {
      const has = thread.labelIds.includes(label.id);
      const wants = wanted.includes(label);
      if (has !== wants) {
        thread.items.push(event(wants ? "labeled" : "unlabeled", actor, now, { label }));
      }
    }
    thread.labelIds = wanted.map((label) => label.id);
  }
  if (change.assignees !== undefined) {
    const wanted = change.assignees.map(userNamed);
    for (const user of thread.assignees) {
      if (!wanted.some((item) => item.id === user.id)) {
        thread.items.push(event("unassigned", actor, now, { assignee: user }));
      }
    }
    for (const user of wanted) {
      if (!thread.assignees.some((item) => item.id === user.id)) {
        thread.items.push(event("assigned", actor, now, { assignee: user }));
      }
    }
    thread.assignees = wanted;
  }
  if (change.milestone !== undefined && change.milestone !== thread.milestone) {
    const before = store.milestones.find((item) => item.number === thread.milestone);
    const after = store.milestones.find((item) => item.number === change.milestone);
    if (change.milestone !== null && !after) throw unprocessable("No such milestone");
    if (before) {
      thread.items.push(event("demilestoned", actor, now, { milestoneTitle: before.title }));
    }
    if (after) {
      thread.items.push(event("milestoned", actor, now, { milestoneTitle: after.title }));
    }
    thread.milestone = change.milestone;
  }
  if (change.state !== undefined && change.state !== thread.state) {
    if (change.state === "closed") {
      const stateReason = thread.page ? null : (change.stateReason ?? "completed");
      thread.state = "closed";
      thread.stateReason = stateReason;
      thread.closedAt = now;
      thread.closedBy = actor;
      thread.items.push(event("closed", actor, now, { stateReason, commitOid: null }));
    } else {
      thread.state = "open";
      thread.stateReason = null;
      thread.closedAt = null;
      thread.closedBy = null;
      thread.items.push(event("reopened", actor, now, {}));
    }
  } else if (
    change.stateReason !== undefined &&
    thread.state === "closed" &&
    change.stateReason !== thread.stateReason
  ) {
    thread.stateReason = change.stateReason;
  }
  touch(thread);
  syncCounts(repo);
}
