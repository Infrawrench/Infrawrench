/**
 * Agent work review: versions and their diffs, traces, findings,
 * instructions, the agent behind a branch, the repository's review settings,
 * the viewer's inbox, and their T3 Code environments.
 *
 * The mock has an agent of its own: an instruction sent to a branch that has
 * an agent is delivered a few seconds later and answered by a new version a
 * few seconds after that, so a page that asks again shows the whole loop.
 */
import type {
  AgentIdentity,
  AgentLink,
  AgentLinkSet,
  BranchPageState,
  BranchVersion,
  Instruction,
  ReviewInbox,
  ReviewRun,
  TraceEntry,
} from "@infrawrench/git-contract";
import {
  badRequest,
  conflict,
  defineMockHandlers,
  mockError,
  notFound,
  ok,
  paginate,
  unprocessable,
  type Mutable,
} from "../define";
import {
  accessTo,
  currentUser,
  findRepository,
  gitOf,
  requireUser,
  visibleRepositories,
  type RepositoryRecord,
} from "../db";
import { launchT3Thread, t3Environments } from "../t3-data";
import { ancestors, diffCommits, flatten, mergeBase, statsOf, summarize, summaryOf } from "../git";
import { fakeOid, writeCommit } from "../git-write";
import {
  isOverridden,
  presentFinding,
  presentSettings,
  reviewOf,
  reviewSettingsOf,
  syncVersions,
  tallyOf,
  type ReviewState,
  type StoredFinding,
  type StoredVersion,
} from "../review-data";
import { newId } from "../settings-data";
import {
  commitsOf,
  findPage,
  pageKeyOf,
  mergeabilityOf,
  refsOf,
  syncCounts,
  threadsOf,
  toBranchPage,
  touch,
  type ThreadRecord,
} from "../threads-data";

const now = (): string => new Date().toISOString();

/** How long the mock's agent takes to pick an instruction up, and to push. */
const DELIVER_MS = 3_000;
const PUSH_MS = 11_000;
const REVIEW_MS = 5_000;

const identityOf = (agent: AgentLink | null): AgentIdentity | null =>
  agent === null
    ? null
    : {
        kind: agent.kind,
        name: agent.displayName,
        sessionRef: agent.externalRefs["sessionId"] ?? agent.externalRefs["threadId"] ?? null,
      };

const seededThreads = new WeakSet<ThreadRecord>();

/** #12's review threads were written on versions; the instruction that came of one names it. */
function seedThreadVersions(repo: RepositoryRecord, thread: ThreadRecord, state: ReviewState) {
  if (seededThreads.has(thread)) return;
  seededThreads.add(thread);
  if (`${repo.owner.slug}/${repo.name}` !== "acme/infra" || thread.number !== 12) return;
  for (const item of thread.page!.threads) {
    item.version = item.path.startsWith("modules/") ? 1 : item.path.startsWith("docs/") ? 3 : 2;
    item.answeredInVersion = item.outdated ? 2 : null;
    const sent = state.instructions.find(
      (instruction) =>
        instruction.source === "review_comment" && instruction.body === item.comments[0]?.body,
    );
    if (sent) sent.reviewCommentId = item.comments[0]!.id;
  }
}

function pushVersion(
  repo: RepositoryRecord,
  thread: ThreadRecord,
  state: ReviewState,
  instruction: Mutable<Instruction> | null,
  note: string,
): void {
  const page = thread.page!;
  const fx = gitOf(repo);
  const head = fx.branches[page.headRef];
  if (head === undefined) return;
  const files = new Map(flatten(fx, head));
  const write = (path: string, text: string) => {
    const oid = fakeOid();
    (fx.blobs as Record<string, unknown>)[oid] = { size: text.length, binary: false, text };
    files.set(path, ["100644", oid]);
  };
  const textOf = (path: string): string | null => {
    const blob = fx.blobs[files.get(path)?.[1] ?? ""];
    return blob !== undefined && !blob.binary ? blob.text : null;
  };

  const target: StoredFinding | undefined = state.findings.find(
    (item) => item.id === instruction?.findingId,
  );
  let message: string;
  let touched: string;
  const before = target?.path ? textOf(target.path) : null;
  if (target?.fix !== undefined && target.path !== null && before?.includes(target.fix.find)) {
    touched = target.path;
    write(touched, before.replace(target.fix.find, target.fix.find + target.fix.insert));
    message = `Fix: ${target.title.toLowerCase()}`;
  } else if (instruction === null) {
    touched = `docs/${page.headRef.split("/").pop() ?? "work"}.md`;
    write(touched, `# ${thread.title}\n\n${note}\n`);
    message = thread.title;
  } else {
    touched = "docs/review-notes.md";
    write(touched, `${textOf(touched) ?? "# Review notes\n"}\n- ${note.split("\n")[0]}\n`);
    message = `Answer: ${note.split("\n")[0]!.slice(0, 60)}`;
  }

  const who = state.agent?.connectedBy ?? thread.author ?? requireUser();
  const oid = writeCommit(fx, files, [head], message, who);
  fx.branches[page.headRef] = oid;
  const at = now();
  thread.items.push({
    type: "commits",
    id: newId("push"),
    createdAt: at,
    commits: [summarize(fx, oid)],
  });
  repo.pushedAt = at;
  touch(thread);
  const agent = identityOf(state.agent);
  const made = syncVersions(state, { oid, at, pusher: who, agent });
  if (made === null) return;
  state.traces.push({
    id: newId("trace"),
    kind: "evidence",
    body: "The change formats and validates.",
    anchors: [{ path: touched }],
    needsCode: false,
    evidence: {
      command: "terraform fmt -check -recursive && terraform validate",
      exitCode: 0,
      output: "Success! The configuration is valid.",
    },
    author: who,
    agent,
    branch: page.headRef,
    version: made.number,
    createdAt: at,
  });
  if (instruction !== null) {
    instruction.status = "answered";
    instruction.answeredInVersion = made.number;
    instruction.answeredAt = at;
  }
  if (target !== undefined && target.status === "open") {
    target.status = "fixed";
    target.fixedInVersion = made.number;
    target.updatedAt = at;
  }
  for (const item of state.findings) {
    if (item.status === "open") item.lastSeenVersion = made.number;
  }
  if (reviewSettingsOf(repo).reviewAgentsEnabled) {
    state.runs.unshift(blankRun(repo, made, "push"));
  }
}

function blankRun(
  repo: RepositoryRecord,
  version: StoredVersion,
  trigger: ReviewRun["trigger"],
  kinds: ReadonlyArray<string> = reviewSettingsOf(repo).reviewerKinds,
): Mutable<ReviewRun> {
  return {
    id: newId("rrun"),
    version: version.number,
    headOid: version.tipOid,
    status: "queued",
    reviewerKinds: [...kinds],
    trigger,
    requestedBy: trigger === "manual" ? currentUser() : null,
    model: null,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    findingCount: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now(),
  };
}

/** Brings a branch page's review state up to the present: versions, the agent's work, review runs. */
function advance(repo: RepositoryRecord, thread: ThreadRecord, state: ReviewState): void {
  const page = thread.page!;
  seedThreadVersions(repo, thread, state);
  const refs = refsOf(repo, page);
  if (commitsOf(refs).length > 0) {
    syncVersions(state, {
      oid: refs.headOid,
      at: state.versions.length === 0 ? thread.createdAt : now(),
      pusher: thread.author,
    });
  }
  for (const work of [...state.work]) {
    const age = Date.now() - work.since;
    const instruction = state.instructions.find((item) => item.id === work.instructionId) ?? null;
    const drop = () => state.work.splice(state.work.indexOf(work), 1);
    if (instruction?.status === "dismissed" || state.agent === null || thread.state !== "open") {
      drop();
      continue;
    }
    if (age >= DELIVER_MS && !work.started) {
      work.started = true;
      if (instruction?.status === "queued") {
        instruction.status = "delivered";
        instruction.deliveredVia = state.agent.kind;
        instruction.deliveredAt = now();
      }
      state.traces.push({
        id: newId("trace"),
        kind: "step",
        body: `Working on: ${work.note.split("\n")[0]}`,
        anchors: [],
        needsCode: false,
        evidence: null,
        author: state.agent.connectedBy,
        agent: identityOf(state.agent),
        branch: page.headRef,
        version: null,
        createdAt: now(),
      });
    }
    if (age >= PUSH_MS) {
      drop();
      pushVersion(repo, thread, state, instruction, work.note);
    }
  }
  for (const item of state.runs) {
    if (item.status !== "queued" && item.status !== "running") continue;
    const age = Date.now() - Date.parse(item.createdAt);
    if (age >= REVIEW_MS) {
      item.status = "done";
      item.model = "claude-sonnet-4-5";
      item.usage = { inputTokens: 21_300, outputTokens: 940, costUsd: 0.08 };
      item.findingCount = state.findings.filter(
        (found) => found.status === "open" && found.lastSeenVersion >= item.version,
      ).length;
      item.finishedAt = now();
    } else if (age >= 1_000) {
      item.status = "running";
      item.startedAt = item.startedAt ?? now();
    }
  }
}

function open(owner: string, name: string, key: string) {
  const repo = findRepository(owner, name);
  const thread = findPage(repo, key);
  const state = reviewOf(repo, thread.number);
  advance(repo, thread, state);
  return { repo, thread, page: thread.page!, state, fx: gitOf(repo) };
}

const canWrite = (repo: RepositoryRecord): boolean =>
  currentUser() !== null && ["write", "admin"].includes(accessTo(repo));

function requireWrite(repo: RepositoryRecord) {
  const user = requireUser();
  if (!canWrite(repo)) throw mockError(403, "You cannot write to this repository");
  return user;
}

function baseOf(repo: RepositoryRecord, thread: ThreadRecord, tipOid: string): string | null {
  const page = thread.page!;
  const fx = gitOf(repo);
  const base = page.frozenBaseOid ?? fx.branches[page.baseRef];
  return base === undefined ? null : mergeBase(fx, base, tipOid);
}

function presentVersion(
  repo: RepositoryRecord,
  thread: ThreadRecord,
  state: ReviewState,
  version: StoredVersion,
): BranchVersion {
  const fx = gitOf(repo);
  const baseOid = baseOf(repo, thread, version.tipOid);
  const inBase = baseOid === null ? new Set<string>() : ancestors(fx, baseOid);
  const commitCount = [...ancestors(fx, version.tipOid)].filter((oid) => !inBase.has(oid)).length;
  const run = state.runs.find((item) => item.version === version.number);
  const traceEntries = state.traces.filter((item) => item.version === version.number).length;
  return {
    id: `${thread.id}_v${version.number}`,
    number: version.number,
    lineage: 1,
    tipOid: version.tipOid,
    baseOid,
    previousOid: version.previousOid,
    forced: version.forced,
    rebased: version.rebased,
    pusher: version.pusher,
    pusherKind: version.pusherKind,
    agent: version.agent,
    commitCount,
    stats: statsOf(diffCommits(fx, baseOid, version.tipOid, { hunks: false })),
    counts: {
      comments: thread
        .page!.threads.filter((item) => item.version === version.number)
        .reduce((sum, item) => sum + item.comments.filter((c) => !c.pending).length, 0),
      findings: state.findings.filter((item) => item.version === version.number).length,
      traceEntries,
      answeredInstructions: state.instructions.filter(
        (item) => item.answeredInVersion === version.number,
      ).length,
    },
    hasTrace: traceEntries > 0,
    reviewStatus: run?.status ?? null,
    createdAt: version.createdAt,
    prunedAt: version.prunedAt ?? null,
  };
}

function versionAt(state: ReviewState, selector: string): StoredVersion {
  const found =
    selector === "latest"
      ? state.versions[state.versions.length - 1]
      : state.versions.find((item) => item.number === Number(selector));
  if (found === undefined) throw notFound("No such version");
  return found;
}

function branchState(
  repo: RepositoryRecord,
  thread: ThreadRecord,
  state: ReviewState,
): BranchPageState {
  const page = thread.page!;
  const mergeability = mergeabilityOf(repo, thread);
  const latest = state.versions[state.versions.length - 1]?.number ?? null;
  const findings = tallyOf(state);
  const openInstructions = state.instructions.filter(
    (item) => item.status === "queued" || item.status === "delivered",
  ).length;
  const pending = state.traces.filter((item) => item.version === null).length;
  const working =
    state.work.length > 0 ||
    pending > 0 ||
    state.instructions.some((item) => item.status === "delivered");
  const checks = mergeability.checks.state;
  const settings = reviewSettingsOf(repo);
  const unreviewed = latest === null ? 0 : latest - (state.reviewed ?? 0);
  const name: BranchPageState["state"] = page.merged
    ? "merged"
    : thread.state === "closed"
      ? "closed"
      : working
        ? "agent_working"
        : checks === "failure" || checks === "error"
          ? "checks_failing"
          : findings.mustFixOpen > 0
            ? "must_fix_open"
            : currentUser() !== null && unreviewed > 0
              ? "needs_your_review"
              : mergeability.canMerge
                ? "ready_to_merge"
                : "waiting";
  return {
    state: name,
    latestVersion: latest,
    workingOnVersion: name === "agent_working" ? (latest ?? 0) + 1 : null,
    viewerReviewedVersion: state.reviewed,
    unreviewedVersions: Math.max(0, unreviewed),
    agent: state.agent,
    openInstructions,
    pendingTraceEntries: pending,
    findings,
    checks,
    reviewRun: state.runs.find((item) => item.version === latest)?.status ?? null,
    canMerge: mergeability.canMerge,
    settings: {
      reviewAgentsEnabled: settings.reviewAgentsEnabled,
      mustFixBlocksMerge: settings.mustFixBlocksMerge,
    },
  };
}

const findingOrder = (a: StoredFinding, b: StoredFinding): number =>
  (a.path ?? "").localeCompare(b.path ?? "") ||
  (a.startLine ?? 0) - (b.startLine ?? 0) ||
  a.id.localeCompare(b.id);

function findingAt(state: ReviewState, id: string): StoredFinding {
  const found = state.findings.find((item) => item.id === id);
  if (found === undefined) throw notFound("No such finding");
  return found;
}

function instructionAt(state: ReviewState, id: string): Mutable<Instruction> {
  const found = state.instructions.find((item) => item.id === id);
  if (found === undefined) throw notFound("No such instruction");
  return found;
}

/** Entries recorded for a branch no page has yet. */
const looseTraces = new Map<string, Array<Mutable<TraceEntry>>>();

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");

/** The refs only the forge writes: what a client sends of them is dropped. */
const FORGE_REFS = [
  "launchError",
  "modelProviderId",
  "modelId",
  "modelName",
  "reasoningLevel",
  "modelPickedBy",
  "sendError",
  "startUrl",
  "threadStatus",
];

/** A link's refs as the forge keeps them: a T3 Code thread is started when none is named. */
function agentRefsOf(repo: { owner: { slug: string }; name: string }, agent: AgentLinkSet) {
  const refs: Record<string, string> = { ...(agent.externalRefs ?? {}) };
  for (const key of FORGE_REFS) delete refs[key];
  if (agent.kind !== "t3" || !agent.t3EnvironmentId || refs["threadId"] !== undefined) return refs;
  return {
    ...refs,
    ...launchT3Thread(agent.t3EnvironmentId, `${repo.owner.slug}/${repo.name}`, agent.t3Model),
  };
}

function environmentAt(id: string) {
  const found = t3Environments.find((item) => item.id === id);
  if (found === undefined) throw notFound("No such environment");
  return found;
}

export default defineMockHandlers({
  versions: {
    list: ({ params }) => {
      const { repo, thread, page, state } = open(params.owner, params.repo, params.branch);
      return {
        branch: page.headRef,
        versions: state.versions.map((item) => presentVersion(repo, thread, state, item)),
        latest: state.versions[state.versions.length - 1]?.number ?? null,
        viewerReviewed: state.reviewed,
      };
    },
    get: ({ params }) => {
      const { repo, thread, state } = open(params.owner, params.repo, params.branch);
      return presentVersion(repo, thread, state, versionAt(state, params.version));
    },
    diff: ({ params, query }) => {
      const { repo, thread, state, fx } = open(params.owner, params.repo, params.branch);
      const to = versionAt(state, params.version);
      const asked = query?.from ?? "base";
      const fromNumber =
        asked === "base"
          ? null
          : asked === "previous"
            ? to.number - 1
            : asked === "reviewed"
              ? state.reviewed
              : Number(asked);
      const from =
        fromNumber === null || fromNumber < 1
          ? null
          : state.versions.find((item) => item.number === fromNumber);
      if (from === undefined) throw unprocessable("No such version to compare from");
      if (from !== null && from.number > to.number) {
        throw unprocessable("The version to compare from is newer");
      }
      // A pruned version's commit is gone. What was merged is still in the merge.
      const pruned = to.prunedAt !== undefined || (from?.prunedAt ?? undefined) !== undefined;
      const merged = thread.page!.merged;
      const fromMerge =
        pruned &&
        from === null &&
        merged !== null &&
        merged.method !== "rebase" &&
        to === state.versions[state.versions.length - 1];
      if (pruned && !fromMerge) {
        const gone = from?.prunedAt !== undefined ? from : to;
        throw mockError(
          422,
          `The commits of v${gone.number} are no longer kept: they were removed thirty days after the branch was merged or deleted`,
          "version_pruned",
        );
      }
      const headOid = fromMerge ? merged.commitOid : to.tipOid;
      const baseOid = fromMerge
        ? (fx.commits[merged.commitOid]?.parents[0] ?? null)
        : from === null
          ? baseOf(repo, thread, to.tipOid)
          : from.tipOid;
      const all = diffCommits(fx, baseOid, headOid, {
        context: query?.context,
        path: query?.path,
      });
      const slice = paginate(all, query);
      return {
        baseOid,
        headOid,
        source: fromMerge ? ("merge" as const) : ("versions" as const),
        stats: statsOf(all.map(summaryOf)),
        files: slice.items,
        nextCursor: slice.nextCursor,
        kind: from === null ? ("whole" as const) : ("interdiff" as const),
        from: from?.number ?? null,
        to: to.number,
        rebased:
          from !== null &&
          state.versions.some(
            (item) => item.number > from.number && item.number <= to.number && item.rebased,
          ),
        exact:
          from === null || !state.inexact.some(([a, b]) => a === from.number && b === to.number),
      };
    },
    markReviewed: ({ params }) => {
      requireUser();
      const { state } = open(params.owner, params.repo, params.branch);
      const version = versionAt(state, params.version);
      state.reviewed = Math.max(state.reviewed ?? 0, version.number);
      return { version: state.reviewed, reviewedAt: now() };
    },
    branchState: ({ params }) => {
      const { repo, thread, state } = open(params.owner, params.repo, params.branch);
      return branchState(repo, thread, state);
    },
  },

  traces: {
    record: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const user = requireWrite(repo);
      const thread = threadsOf(repo).threads.find(
        (item) => item.page?.headRef === payload.branch && item.state === "open",
      );
      const entries = payload.entries.map((item): Mutable<TraceEntry> => ({
        id: newId("trace"),
        kind: item.kind,
        body: item.body,
        anchors: [...(item.anchors ?? [])],
        // The server's rule: a line when the writer does not say, and never without a file.
        needsCode:
          item.needsCode === undefined
            ? (item.anchors ?? []).some(
                (anchor) => anchor.startLine !== undefined && anchor.startLine !== null,
              )
            : item.needsCode && (item.anchors ?? []).length > 0,
        evidence: item.evidence ?? null,
        author: user,
        agent:
          payload.agent === undefined
            ? null
            : { ...payload.agent, sessionRef: payload.agent.sessionRef ?? null },
        branch: payload.branch,
        version: null,
        createdAt: now(),
      }));
      if (thread) reviewOf(repo, thread.number).traces.push(...entries);
      else {
        const key = `${repo.id}:${payload.branch}`;
        looseTraces.set(key, [...(looseTraces.get(key) ?? []), ...entries]);
      }
      return { entries };
    },
    list: ({ params, query }) => {
      const repo = findRepository(params.owner, params.repo);
      // The branch's page holds its entries; a branch with none keeps them loose.
      let thread: ThreadRecord | undefined;
      try {
        thread = findPage(repo, query.branch);
      } catch {
        thread = undefined;
      }
      const all: ReadonlyArray<TraceEntry> =
        thread === undefined
          ? (looseTraces.get(`${repo.id}:${query.branch}`) ?? [])
          : open(params.owner, params.repo, pageKeyOf(repo, thread)).state.traces;
      const wanted = query.version;
      const shown =
        wanted === undefined
          ? all
          : all.filter((item) =>
              wanted === "pending" ? item.version === null : item.version === Number(wanted),
            );
      return paginate(
        [...shown].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        { limit: 100, ...query },
      );
    },
  },

  findings: {
    list: ({ params, query }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      const version = query?.version;
      const findings = state.findings
        .filter(
          (item) =>
            (version === undefined ||
              (item.version <= version && item.lastSeenVersion >= version)) &&
            (query?.status === undefined || item.status === query.status),
        )
        .sort(findingOrder)
        .map((item) => presentFinding(repo, state, item));
      return { findings, tally: tallyOf(state) };
    },
    report: ({ params, payload }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      requireWrite(repo);
      const version =
        payload.version === undefined
          ? versionAt(state, "latest")
          : versionAt(state, String(payload.version));
      const at = now();
      const seen: StoredFinding[] = [];
      for (const item of payload.findings) {
        const known = state.findings.find(
          (found) =>
            found.reviewerKind === payload.reviewerKind &&
            found.path === (item.path ?? null) &&
            found.title === item.title,
        );
        if (known) {
          known.lastSeenVersion = version.number;
          known.updatedAt = at;
          if (known.status === "fixed") {
            known.status = "open";
            known.fixedInVersion = null;
          }
          seen.push(known);
          continue;
        }
        const made: StoredFinding = {
          id: newId("finding"),
          reviewerKind: payload.reviewerKind,
          severity: item.severity,
          title: item.title,
          body: item.body ?? "",
          path: item.path ?? null,
          side: item.side ?? "RIGHT",
          startLine: item.startLine ?? null,
          endLine: item.endLine ?? item.startLine ?? null,
          needsCode:
            (item.path ?? null) !== null &&
            (item.needsCode ??
              ((item.startLine ?? null) !== null || (item.endLine ?? null) !== null)),
          commitOid: version.tipOid,
          evidence: [...(item.evidence ?? [])],
          status: "open",
          version: version.number,
          lastSeenVersion: version.number,
          fixedInVersion: null,
          dismissedBy: null,
          dismissedAt: null,
          dismissalReason: null,
          runId: payload.runId ?? null,
          createdAt: at,
          updatedAt: at,
        };
        state.findings.push(made);
        seen.push(made);
      }
      if (payload.complete === true) {
        for (const item of state.findings) {
          if (
            item.reviewerKind === payload.reviewerKind &&
            item.status === "open" &&
            !seen.includes(item)
          ) {
            item.status = "fixed";
            item.fixedInVersion = version.number;
            item.updatedAt = at;
          }
        }
      }
      return { findings: seen.map((item) => presentFinding(repo, state, item)) };
    },
    dismiss: ({ params, payload }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      const user = requireWrite(repo);
      const found = findingAt(state, params.findingId);
      if (found.status === "fixed") throw unprocessable("The finding is already fixed");
      if (payload.reason.trim() === "") throw badRequest("A reason is required");
      found.status = "dismissed";
      found.dismissedBy = user;
      found.dismissedAt = now();
      found.dismissalReason = payload.reason.trim();
      found.updatedAt = now();
      return presentFinding(repo, state, found);
    },
    reopen: ({ params }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      requireWrite(repo);
      const found = findingAt(state, params.findingId);
      if (found.status !== "dismissed") throw unprocessable("The finding is not dismissed");
      found.status = "open";
      found.dismissedBy = null;
      found.dismissedAt = null;
      found.dismissalReason = null;
      found.updatedAt = now();
      return presentFinding(repo, state, found);
    },
    override: ({ params, payload }) => {
      const { repo, page, state } = open(params.owner, params.repo, params.branch);
      const user = requireUser();
      if (accessTo(repo) !== "admin") {
        throw mockError(403, "Only an administrator can merge past a finding");
      }
      const openMustFix = state.findings.filter(
        (item) =>
          item.status === "open" && item.severity === "must_fix" && !isOverridden(state, item.id),
      );
      const findingIds = payload.findingIds ?? openMustFix.map((item) => item.id);
      if (findingIds.length === 0) throw unprocessable("No open must-fix finding to merge past");
      for (const id of findingIds) findingAt(state, id);
      const made = {
        id: newId("override"),
        by: user,
        reason: payload.reason.trim(),
        findingIds: [...findingIds],
        headOid: refsOf(repo, page).headOid,
        createdAt: now(),
      };
      state.overrides.push(made);
      return made;
    },
    listRuns: ({ params }) => ({
      runs: open(params.owner, params.repo, params.branch).state.runs,
    }),
    getRun: ({ params }) => {
      const { state } = open(params.owner, params.repo, params.branch);
      const found = state.runs.find((item) => item.id === params.runId);
      if (found === undefined) throw notFound("No such review run");
      return found;
    },
    requestRun: ({ params, payload }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      requireWrite(repo);
      const version =
        payload.version === undefined
          ? versionAt(state, "latest")
          : versionAt(state, String(payload.version));
      if (
        state.runs.some(
          (item) =>
            item.version === version.number &&
            (item.status === "queued" || item.status === "running"),
        )
      ) {
        throw conflict("A review of this version is already running");
      }
      const made = blankRun(repo, version, "manual", payload.reviewerKinds);
      state.runs.unshift(made);
      return made;
    },
    updateRun: ({ params, payload }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      requireWrite(repo);
      const found = state.runs.find((item) => item.id === params.runId);
      if (found === undefined) throw notFound("No such review run");
      if (payload.status !== undefined) found.status = payload.status;
      if (payload.model !== undefined) found.model = payload.model;
      if (payload.error !== undefined) found.error = payload.error;
      found.usage = {
        inputTokens: payload.inputTokens ?? found.usage.inputTokens,
        outputTokens: payload.outputTokens ?? found.usage.outputTokens,
        costUsd: payload.costUsd ?? found.usage.costUsd,
      };
      return found;
    },
  },

  instructions: {
    send: ({ params, payload }) => {
      const { repo, page, state } = open(params.owner, params.repo, params.branch);
      const user = requireWrite(repo);
      let body = payload.body?.trim() ?? "";
      let findingId: string | null = null;
      let reviewCommentId: string | null = null;
      if (payload.source === "text") {
        if (body === "") throw badRequest("Say what the agent should do");
      } else if (payload.source === "finding") {
        const found = findingAt(state, payload.findingId ?? "");
        findingId = found.id;
        body = [found.title, found.body, body].filter((part) => part !== "").join("\n\n");
      } else {
        const thread = page.threads.find((item) =>
          item.comments.some((comment) => comment.id === payload.reviewCommentId),
        );
        if (thread === undefined) throw unprocessable("No such review comment");
        reviewCommentId = thread.comments[0]!.id;
        body = [thread.comments[0]!.body, body].filter((part) => part !== "").join("\n\n");
      }
      const made: Mutable<Instruction> = {
        id: newId("ins"),
        source: payload.source,
        reviewCommentId,
        findingId,
        body,
        createdBy: user,
        status: "queued",
        deliveredVia: null,
        deliveredAt: null,
        answeredInVersion: null,
        answeredAt: null,
        dismissedBy: null,
        dismissedAt: null,
        createdAt: now(),
      };
      state.instructions.push(made);
      if (state.agent !== null) {
        state.work.push({ instructionId: made.id, since: Date.now(), note: body, started: false });
      }
      return made;
    },
    list: ({ params, query }) => {
      const { state } = open(params.owner, params.repo, params.branch);
      return {
        instructions: state.instructions.filter(
          (item) => query?.status === undefined || item.status === query.status,
        ),
      };
    },
    markDelivered: ({ params, payload }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      requireWrite(repo);
      const found = instructionAt(state, params.instructionId);
      if (found.status !== "queued") throw unprocessable("The instruction is not waiting");
      found.status = "delivered";
      found.deliveredVia = payload.via ?? "mcp";
      found.deliveredAt = now();
      return found;
    },
    markAnswered: ({ params, payload }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      requireWrite(repo);
      const found = instructionAt(state, params.instructionId);
      if (found.status === "dismissed") throw unprocessable("The instruction was withdrawn");
      found.status = "answered";
      found.answeredInVersion =
        payload.version ?? (state.versions[state.versions.length - 1]?.number ?? 0) + 1;
      found.answeredAt = now();
      return found;
    },
    dismiss: ({ params }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      const user = requireWrite(repo);
      const found = instructionAt(state, params.instructionId);
      if (found.status === "answered") throw unprocessable("The instruction is already answered");
      found.status = "dismissed";
      found.dismissedBy = user;
      found.dismissedAt = now();
      return found;
    },
  },

  agents: {
    get: ({ params }) => ({ agent: open(params.owner, params.repo, params.branch).state.agent }),
    set: ({ params, payload }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      const user = requireWrite(repo);
      if (payload.kind === "t3" && payload.t3EnvironmentId) {
        environmentAt(payload.t3EnvironmentId);
      }
      const at = now();
      state.agent = {
        kind: payload.kind,
        displayName: payload.displayName,
        externalRefs: agentRefsOf(repo, payload),
        t3EnvironmentId: payload.t3EnvironmentId ?? null,
        connectedBy: user,
        createdAt: state.agent?.createdAt ?? at,
        updatedAt: at,
      };
      return { agent: state.agent };
    },
    remove: ({ params }) => {
      const { repo, state } = open(params.owner, params.repo, params.branch);
      requireWrite(repo);
      state.agent = null;
      return ok;
    },
    startWork: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      const user = requireWrite(repo);
      const fx = gitOf(repo);
      const baseRef = payload.base ?? repo.defaultBranch;
      const base = fx.branches[baseRef];
      if (base === undefined) throw unprocessable("No such branch", "ref_not_found");
      const ask = payload.ask.trim();
      if (ask === "") throw badRequest("Say what is being asked for");
      const title = (payload.title ?? ask.split("\n")[0]!).trim().slice(0, 256);
      const branch = payload.branch?.trim() || `work/${slug(title) || "branch"}`;
      if (fx.branches[branch] !== undefined) {
        throw conflict(`A branch named ${branch} already exists`, "ref_exists");
      }
      fx.branches[branch] = base;
      const store = threadsOf(repo);
      const at = now();
      const thread: ThreadRecord = {
        id: newId("thread"),
        number: store.nextNumber++,
        title,
        body: ask,
        bodyEditedAt: null,
        author: user,
        labelIds: [],
        assignees: [],
        milestone: null,
        state: "open",
        stateReason: null,
        locked: false,
        lockReason: null,
        createdAt: at,
        updatedAt: at,
        closedAt: null,
        closedBy: null,
        items: [],
        page: {
          draft: true,
          baseRef,
          headRef: branch,
          frozenHeadOid: null,
          frozenBaseOid: null,
          merged: null,
          reviews: [],
          threads: [],
        },
      };
      store.threads.push(thread);
      syncCounts(repo);
      const state = reviewOf(repo, thread.number);
      if (payload.agent !== undefined) {
        state.agent = {
          kind: payload.agent.kind,
          displayName: payload.agent.displayName,
          externalRefs: agentRefsOf(repo, payload.agent),
          t3EnvironmentId: payload.agent.t3EnvironmentId ?? null,
          connectedBy: user,
          createdAt: at,
          updatedAt: at,
        };
        // A thread that did not start records nothing and works on nothing.
        if (state.agent.externalRefs["launchError"] === undefined) {
          state.traces.push({
            id: newId("trace"),
            kind: "ask",
            body: ask,
            anchors: [],
            needsCode: false,
            evidence: null,
            author: user,
            agent: identityOf(state.agent),
            branch,
            version: null,
            createdAt: at,
          });
          state.work.push({ instructionId: null, since: Date.now(), note: ask, started: false });
        }
      }
      return { page: toBranchPage(repo, thread), branch, agent: state.agent };
    },
  },

  reviewSettings: {
    get: ({ params }) => {
      const repo = findRepository(params.owner, params.repo);
      if (accessTo(repo) !== "admin") throw mockError(403, "Forbidden");
      return presentSettings(repo);
    },
    update: ({ params, payload }) => {
      const repo = findRepository(params.owner, params.repo);
      if (accessTo(repo) !== "admin") throw mockError(403, "Forbidden");
      const settings = reviewSettingsOf(repo);
      if (payload.reviewAgentsEnabled !== undefined) {
        settings.reviewAgentsEnabled = payload.reviewAgentsEnabled;
      }
      if (payload.reviewerKinds !== undefined) settings.reviewerKinds = [...payload.reviewerKinds];
      if (payload.mustFixBlocksMerge !== undefined) {
        settings.mustFixBlocksMerge = payload.mustFixBlocksMerge;
      }
      return presentSettings(repo);
    },
  },

  review: {
    inbox: ({ query }) => {
      const user = requireUser();
      const items: Array<ReviewInbox["items"][number]> = [];
      for (const repo of visibleRepositories()) {
        for (const thread of threadsOf(repo).threads) {
          const page = thread.page;
          if (page === null || thread.state !== "open" || page.merged) continue;
          const state = reviewOf(repo, thread.number);
          advance(repo, thread, state);
          const involved =
            thread.author?.id === user.id ||
            thread.assignees.some((person) => person.id === user.id) ||
            page.reviews.some((review) => review.author?.id === user.id) ||
            state.agent?.connectedBy?.id === user.id;
          const latest = state.versions[state.versions.length - 1];
          const reviewed = state.reviewed ?? 0;
          if (!involved || latest === undefined || latest.number <= reviewed) continue;
          const since = state.versions.find((item) => item.number > reviewed)!;
          items.push({
            repository: {
              id: repo.id,
              owner: repo.owner.slug,
              name: repo.name,
              visibility: repo.visibility,
            },
            key: pageKeyOf(repo, thread),
            number: thread.number,
            title: thread.title,
            branch: page.headRef,
            draft: page.draft,
            author: thread.author,
            agent:
              state.agent === null
                ? null
                : { kind: state.agent.kind, displayName: state.agent.displayName },
            latestVersion: latest.number,
            reviewedVersion: state.reviewed,
            waitingSince: since.createdAt,
            changes: {
              versions: latest.number - reviewed,
              comments: page.threads
                .filter((item) => (item.version ?? 0) > reviewed)
                .reduce(
                  (sum, item) =>
                    sum +
                    item.comments.filter((c) => !c.pending && c.author?.id !== user.id).length,
                  0,
                ),
              findings: state.findings.filter((item) => item.version > reviewed).length,
            },
            mustFixOpen: tallyOf(state).mustFixOpen,
          });
        }
      }
      items.sort((a, b) => a.waitingSince.localeCompare(b.waitingSince));
      return paginate(items, query);
    },
  },
});
