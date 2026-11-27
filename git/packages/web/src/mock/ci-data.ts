/**
 * The mock's CI: runs per repository with their jobs and what each printed,
 * and the commit statuses those runs report. One run of `acme/infra` is still
 * going when the page loads and finishes about a minute later, so the log
 * viewer has something to follow.
 */
import type {
  CiRun,
  CiRunStatus,
  CommitStatus,
  StatusState,
  UserRef,
} from "@infrawrench/git-contract";
import type { Mutable } from "./define";
import { APP_URL, gitOf, type RepositoryRecord } from "./db";
import { FIXTURE_PEOPLE, commitOf, statusOf, type GitFixture } from "./git";
import { newId, person } from "./settings-data";

type JobStatus = "passed" | "failed" | "skipped" | "error" | "cancelled";

export interface JobRecord {
  pipeline: string;
  id: string;
  name: string;
  needs: string[];
  status: JobStatus;
  reason: string | null;
  /** Seconds after the run starts that the job starts, and how long it takes. */
  startsAt: number;
  seconds: number;
  lines: Array<{ stream: "stdout" | "stderr"; line: string }>;
}

export interface RunRecord {
  run: Mutable<CiRun>;
  jobs: JobRecord[];
  /** Set for a run in progress: when it started, by this page's clock. */
  liveSince: number | null;
}

const E = "\u001b[";
const green = (text: string) => `${E}32m${text}${E}0m`;
const red = (text: string) => `${E}31m${text}${E}0m`;
const yellow = (text: string) => `${E}33m${text}${E}0m`;
const cyan = (text: string) => `${E}36m${text}${E}0m`;
const bold = (text: string) => `${E}1m${text}${E}0m`;
const dim = (text: string) => `${E}2m${text}${E}0m`;

const out = (...lines: string[]) => lines.map((line) => ({ stream: "stdout" as const, line }));
const err = (...lines: string[]) => lines.map((line) => ({ stream: "stderr" as const, line }));

const INIT = [
  `${dim("$")} terraform init -backend=false`,
  bold("Initializing modules..."),
  "- cluster in ../../modules/cluster",
  "- database in ../../modules/database",
  "- network in ../../modules/network",
  bold("Initializing provider plugins..."),
  '- Finding hashicorp/aws versions matching "~> 5.60"...',
  "- Installing hashicorp/aws v5.72.1...",
  "- Installed hashicorp/aws v5.72.1 (signed by HashiCorp)",
  "",
  bold(green("Terraform has been successfully initialized!")),
];

type JobSeed = Omit<JobRecord, "startsAt"> & { startsAt?: number };

function terraformJobs(outcome: "passed" | "fmt" | "validate"): JobSeed[] {
  const pipeline = "terraform";
  const fmt: JobSeed =
    outcome === "fmt"
      ? {
          pipeline,
          id: "fmt",
          name: "fmt",
          needs: [],
          status: "failed",
          reason: "exit code 3",
          seconds: 6,
          lines: [
            ...out(`${dim("$")} terraform fmt -check -recursive -diff`),
            ...out(
              "modules/database/variables.tf",
              bold("--- old/modules/database/variables.tf"),
              bold("+++ new/modules/database/variables.tf"),
              cyan("@@ -14,7 +14,7 @@"),
              ' variable "backup_retention_days" {',
              red("-  type = number"),
              red("-  default = 14"),
              green("+  type    = number"),
              green("+  default = 14"),
              " }",
            ),
            ...err(red("Error: 1 file is not formatted")),
          ],
        }
      : {
          pipeline,
          id: "fmt",
          name: "fmt",
          needs: [],
          status: "passed",
          reason: null,
          seconds: 5,
          lines: out(`${dim("$")} terraform fmt -check -recursive`, dim("23 files checked")),
        };
  const validate = (root: string, fails: boolean): JobSeed => ({
    pipeline,
    id: `validate-${root.split("/").pop()}`,
    name: `validate (${root})`,
    needs: [],
    status: fails ? "failed" : "passed",
    reason: fails ? "exit code 1" : null,
    seconds: fails ? 19 : 24,
    lines: [
      ...out(...INIT, "", `${dim("$")} terraform -chdir=${root} validate`),
      ...(fails
        ? err(
            red("╷"),
            `${red("│")} ${bold(red("Error: "))}${bold("Unsupported argument")}`,
            red("│"),
            `${red("│")}   on main.tf line 41, in module "database":`,
            `${red("│")}   41:   ${bold("backup_window")} = "02:00-03:00"`,
            red("│"),
            `${red("│")} An argument named "backup_window" is not expected here.`,
            red("╵"),
          )
        : out(`${bold(green("Success!"))} The configuration is valid.`)),
    ],
  });
  const lint: JobSeed = {
    pipeline,
    id: "lint",
    name: "lint",
    needs: ["fmt"],
    status: outcome === "fmt" ? "skipped" : "passed",
    reason: outcome === "fmt" ? "fmt failed" : null,
    seconds: outcome === "fmt" ? 0 : 9,
    lines:
      outcome === "fmt"
        ? []
        : out(
            `${dim("$")} ./scripts/lint.sh`,
            `${green("ok")}   modules/cluster pins hashicorp/aws ~> 5.60`,
            `${green("ok")}   modules/database pins hashicorp/aws ~> 5.60`,
            `${green("ok")}   modules/network pins hashicorp/aws ~> 5.60`,
            `${yellow("warn")} modules/vendor/terraform-aws-tags is a submodule, skipped`,
            "3 modules checked, 0 failures",
          ),
  };
  return [
    fmt,
    validate("environments/staging", false),
    validate("environments/production", outcome === "validate"),
    lint,
  ];
}

function nodeJobs(outcome: "passed" | "test"): JobSeed[] {
  const pipeline = "test";
  return [
    {
      pipeline,
      id: "typecheck",
      name: "typecheck",
      needs: [],
      status: "passed",
      reason: null,
      seconds: 11,
      lines: out(`${dim("$")} pnpm typecheck`, dim("> tsc --noEmit"), ""),
    },
    {
      pipeline,
      id: "test",
      name: "test",
      needs: ["typecheck"],
      status: outcome === "test" ? "failed" : "passed",
      reason: outcome === "test" ? "exit code 1" : null,
      seconds: 17,
      lines: [
        ...out(
          `${dim("$")} pnpm test`,
          "",
          ` ${green("✓")} src/match.test.ts ${dim("(9 tests)")} 14ms`,
          outcome === "test"
            ? ` ${red("❯")} src/router.test.ts ${dim("(6 tests | 1 failed)")} 31ms`
            : ` ${green("✓")} src/router.test.ts ${dim("(6 tests)")} 22ms`,
        ),
        ...(outcome === "test"
          ? err(
              `${red("FAIL")} src/router.test.ts > prefers the longest prefix`,
              `${red("AssertionError")}: expected '/api' to be '/api/v2'`,
              dim("  at src/router.test.ts:48:31"),
            )
          : []),
        ...out(
          "",
          outcome === "test"
            ? ` ${bold("Tests")}  ${red("1 failed")} | ${green("14 passed")} (15)`
            : ` ${bold("Tests")}  ${green("15 passed")} (15)`,
        ),
      ],
    },
  ];
}

/** Jobs laid out in time: a job starts when the ones it needs have ended. */
function schedule(seeds: JobSeed[]): JobRecord[] {
  const ends = new Map<string, number>();
  return seeds.map((seed) => {
    const startsAt = seed.startsAt ?? Math.max(1, ...seed.needs.map((need) => ends.get(need) ?? 1));
    ends.set(seed.id, startsAt + seed.seconds);
    return { ...seed, startsAt };
  });
}

const totalSeconds = (jobs: JobRecord[]): number =>
  Math.max(1, ...jobs.map((job) => job.startsAt + job.seconds)) + 1;

const stores = new Map<string, RunRecord[]>();
const reported = new Map<string, CommitStatus[]>();

const appUrlOf = (repo: RepositoryRecord, id: string): string | null =>
  repo.owner.kind === "org" ? `${APP_URL}/org/org_acme/ci/runs/${id}` : null;

interface RunSeed {
  event: CiRun["event"];
  headRef: string;
  sha: string;
  /** The key of the branch page the run is of. */
  branchPage?: string;
  actor: UserRef | null;
  status: CiRunStatus;
  statusReason?: string;
  /** Minutes before now that it was created. */
  minutesAgo: number;
  jobs: JobSeed[];
  fromFork?: boolean;
  pipelineFile?: string;
}

function makeRun(repo: RepositoryRecord, fx: GitFixture, seed: RunSeed): RunRecord {
  const id = newId("run");
  const jobs = schedule(seed.jobs);
  const live = seed.status === "running";
  const created = Date.now() - seed.minutesAgo * 60_000;
  const waiting = ["queued", "pending", "awaiting_approval"].includes(seed.status);
  const duration = totalSeconds(jobs) * 1000;
  return {
    jobs,
    liveSince: live ? Date.now() - (seed.minutesAgo === 0 ? 0 : 14_000) : null,
    run: {
      id,
      event: seed.event,
      headRef: seed.headRef,
      sha: seed.sha,
      branchPage: seed.branchPage ?? null,
      fromFork: seed.fromFork ?? false,
      actor: seed.actor,
      status: seed.status,
      statusReason: seed.statusReason ?? null,
      createdAt: new Date(live ? Date.now() - 17_000 : created).toISOString(),
      startedAt: waiting
        ? null
        : new Date(live ? Date.now() - 14_000 : created + 3000).toISOString(),
      finishedAt: live || waiting ? null : new Date(created + 3000 + duration).toISOString(),
      jobs: null,
      ...(seed.pipelineFile === undefined ? {} : { pipelineFile: seed.pipelineFile }),
      retryOfRunId: null,
      retriedAsRunId: null,
      cancelRequested: false,
      commitTitle: fx.commits[seed.sha]?.message.split("\n")[0] ?? null,
      appUrl: appUrlOf(repo, id),
    },
  };
}

const authorOf = (fx: GitFixture, oid: string): UserRef | null =>
  FIXTURE_PEOPLE[commitOf(fx, oid).author.email] ?? null;

function seedRuns(repo: RepositoryRecord): RunRecord[] {
  if (repo.fixture === null || !repo.hasCi) return [];
  const fx = gitOf(repo);
  const seeds: RunSeed[] = [];
  const terraform = repo.fixture === "infra";
  const jobsFor = (state: StatusState | null): JobSeed[] =>
    terraform
      ? terraformJobs(state === "failure" ? "validate" : "passed")
      : nodeJobs(state === "failure" ? "test" : "passed");

  // The default branch's newest commits, in step with the statuses the code pages show.
  let cursor: string | undefined = fx.branches[fx.defaultBranch];
  for (let depth = 0; depth < 8 && cursor !== undefined; depth++) {
    const state = statusOf(fx, cursor);
    if (state !== null) {
      seeds.push({
        event: "push",
        headRef: fx.defaultBranch,
        sha: cursor,
        actor: authorOf(fx, cursor),
        status: state === "pending" ? "running" : state === "success" ? "passed" : "failed",
        minutesAgo: 40 + depth * 60 * 19,
        jobs: jobsFor(state),
      });
    }
    cursor = fx.commits[cursor]?.parents[0];
  }

  if (terraform) {
    const peering = fx.branches["feature/vpc-peering"]!;
    const backups = fx.branches["fix/database-backups"]!;
    const earlier = commitOf(fx, peering).parents[0]!;
    seeds.push(
      {
        event: "pull-request",
        headRef: "feature/vpc-peering",
        sha: peering,
        branchPage: "feature/vpc-peering",
        actor: person("jonas"),
        status: "passed",
        minutesAgo: 60 * 30,
        jobs: terraformJobs("passed"),
      },
      {
        event: "pull-request",
        headRef: "feature/vpc-peering",
        sha: earlier,
        branchPage: "feature/vpc-peering",
        actor: person("jonas"),
        status: "cancelled",
        statusReason: "A newer push replaced it",
        minutesAgo: 60 * 47,
        jobs: terraformJobs("passed").map((job) => ({ ...job, status: "cancelled" as const })),
      },
      {
        event: "pull-request",
        headRef: "fix/database-backups",
        sha: backups,
        branchPage: "fix/database-backups",
        actor: person("priya"),
        status: "failed",
        minutesAgo: 60 * 21,
        jobs: terraformJobs("fmt"),
      },
      {
        event: "manual",
        headRef: "release/2026.11",
        sha: fx.branches["release/2026.11"]!,
        actor: person("mara"),
        status: "passed",
        minutesAgo: 60 * 70,
        jobs: terraformJobs("passed"),
        pipelineFile: ".infrawrench/ci/terraform.yml",
      },
      {
        event: "pull-request",
        headRef: "tomas:docs/typos",
        sha: fx.commits[fx.branches[fx.defaultBranch]!]!.parents[0]!,
        actor: {
          id: "user_tomas",
          username: "tomas",
          displayName: "Tomas Okafor",
          avatarUrl: null,
        },
        status: "awaiting_approval",
        statusReason: "A branch from a fork runs once someone approves it",
        minutesAgo: 95,
        jobs: terraformJobs("passed"),
        fromFork: true,
      },
    );
  } else {
    const health = fx.branches["feature/health-checks"];
    if (health !== undefined) {
      seeds.push({
        event: "pull-request",
        headRef: "feature/health-checks",
        sha: health,
        branchPage: "feature/health-checks",
        actor: person("mara"),
        status: "passed",
        minutesAgo: 60 * 5,
        jobs: nodeJobs("passed"),
      });
    }
  }
  return seeds
    .map((seed) => makeRun(repo, fx, seed))
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
}

export function runsOf(repo: RepositoryRecord): RunRecord[] {
  let found = stores.get(repo.id);
  if (!found) stores.set(repo.id, (found = seedRuns(repo)));
  return found;
}

/** A run started by something else in the mock (a Terraform plan), newest first. */
export function registerRun(repo: RepositoryRecord, seed: RunSeed): RunRecord {
  const record = makeRun(repo, gitOf(repo), seed);
  const runs = runsOf(repo);
  runs.push(record);
  runs.sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  return record;
}

/** A run that starts now and passes in about a minute: what a push to a branch sets off. */
export function startRun(
  repo: RepositoryRecord,
  seed: { headRef: string; sha: string; branchPage: string; actor: UserRef | null },
): RunRecord {
  return registerRun(repo, {
    ...seed,
    event: "pull-request",
    status: "running",
    minutesAgo: 0,
    jobs: repo.fixture === "infra" ? terraformJobs("passed") : nodeJobs("passed"),
  });
}

const elapsedOf = (record: RunRecord): number =>
  record.liveSince === null ? Infinity : (Date.now() - record.liveSince) / 1000;

/** Moves a run in progress on: once its last job has ended it is a finished run. */
function settle(record: RunRecord): void {
  if (record.liveSince === null) return;
  const total = totalSeconds(record.jobs);
  if (elapsedOf(record) < total) return;
  record.run.status = record.jobs.some((job) => job.status === "failed") ? "failed" : "passed";
  record.run.finishedAt = new Date(record.liveSince + total * 1000).toISOString();
  record.liveSince = null;
}

const jobOf = (job: JobRecord) => ({
  pipeline: job.pipeline,
  id: job.id,
  name: job.name,
  status: job.status,
  reason: job.reason,
  durationMs: job.status === "skipped" ? null : job.seconds * 1000,
  needs: job.needs,
});

const finished = (record: RunRecord): boolean =>
  ["passed", "failed", "error", "cancelled"].includes(record.run.status);

export function toRun(record: RunRecord): CiRun {
  settle(record);
  return { ...record.run, jobs: finished(record) ? record.jobs.map(jobOf) : null };
}

const textOf = (job: JobRecord, stream: "stdout" | "stderr"): string =>
  job.lines
    .filter((line) => line.stream === stream)
    .map((line) => `${line.line}\n`)
    .join("");

export function toDetail(record: RunRecord) {
  const run = toRun(record);
  return {
    run,
    jobs: finished(record)
      ? record.jobs.map((job) => ({
          ...jobOf(job),
          stdout: textOf(job, "stdout"),
          stderr: textOf(job, "stderr"),
        }))
      : null,
  };
}

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The run's log so far, as the server-sent events the runner's log is relayed as. */
export function logFrames(record: RunRecord): string {
  const elapsed = elapsedOf(record);
  settle(record);
  if (record.run.startedAt === null) return "";
  let text = "";
  for (const pipeline of [...new Set(record.jobs.map((job) => job.pipeline))]) {
    const jobs = record.jobs.filter((job) => job.pipeline === pipeline);
    text += frame("pipeline-started", {
      event: "pipeline-started",
      pipeline,
      jobs: jobs.map((job) => ({ key: job.id, name: job.name, needs: job.needs, ids: [job.id] })),
    });
    for (const job of jobs) {
      if (job.status === "skipped") {
        if (elapsed >= job.startsAt) {
          text += frame("job-finished", {
            event: "job-finished",
            job: job.id,
            status: "skipped",
            duration_ms: 0,
          });
        }
        continue;
      }
      if (elapsed < job.startsAt) continue;
      text += frame("job-started", { event: "job-started", job: job.id, name: job.name });
      const progress = Math.min(1, (elapsed - job.startsAt) / Math.max(1, job.seconds));
      const shown = Math.floor(job.lines.length * progress);
      for (const line of job.lines.slice(0, shown)) {
        text += frame("output", { event: "output", job: job.id, ...line });
      }
      if (progress >= 1) {
        text += frame("job-finished", {
          event: "job-finished",
          job: job.id,
          status: job.status,
          duration_ms: job.seconds * 1000,
        });
      }
    }
  }
  if (record.liveSince === null) {
    text += frame("run-finished", { passed: record.run.status === "passed", error: null });
  }
  return text;
}

const STATE_OF_JOB: Record<JobStatus, StatusState | null> = {
  passed: "success",
  failed: "failure",
  error: "error",
  cancelled: "error",
  skipped: null,
};

/** `Infrawrench CI / validate`: a matrix job's entries report under its key. */
const contextOf = (job: JobRecord): string =>
  `Infrawrench CI / ${job.name.replace(/ \(.*\)$/, "")}`;

const WORSE: StatusState[] = ["success", "pending", "error", "failure"];
const worse = (a: StatusState, b: StatusState): StatusState =>
  WORSE.indexOf(a) >= WORSE.indexOf(b) ? a : b;

/** Each context's newest status on a commit: what CI reported plus anything else that did. */
export function statusesFor(repo: RepositoryRecord, sha: string): CommitStatus[] {
  const byContext = new Map<string, CommitStatus>();
  const runs = runsOf(repo).filter(
    (record) => record.run.sha === sha && record.run.status !== "awaiting_approval",
  );
  // Oldest first, so a newer run's report replaces an older one's.
  for (const record of [...runs].reverse()) {
    settle(record);
    if (record.run.status === "cancelled") continue;
    const live = record.liveSince !== null;
    const perContext = new Map<string, StatusState>();
    for (const job of record.jobs) {
      const state: StatusState | null = live ? "pending" : STATE_OF_JOB[job.status];
      if (state === null) continue;
      const context = contextOf(job);
      const before = perContext.get(context);
      perContext.set(context, before === undefined ? state : worse(before, state));
    }
    for (const [context, state] of perContext) {
      byContext.set(context, {
        id: `status_${record.run.id}_${context}`,
        context,
        state,
        description:
          state === "pending"
            ? "Running"
            : state === "success"
              ? "Passed"
              : state === "failure"
                ? "Failed"
                : "Errored",
        targetUrl: `/${repo.owner.slug}/${repo.name}/ci/runs/${record.run.id}`,
        creator: null,
        createdAt: record.run.createdAt,
        updatedAt: record.run.finishedAt ?? record.run.createdAt,
      });
    }
  }
  for (const status of reported.get(`${repo.id}:${sha}`) ?? []) {
    byContext.set(status.context, status);
  }
  return [...byContext.values()].sort((a, b) => a.context.localeCompare(b.context));
}

export function reportStatus(repo: RepositoryRecord, sha: string, status: CommitStatus): void {
  const key = `${repo.id}:${sha}`;
  const list = (reported.get(key) ?? []).filter((item) => item.context !== status.context);
  list.push(status);
  reported.set(key, list);
}

/** `failure` if any failed or errored, else `pending` if any is pending, else `success`. */
export function combine(statuses: ReadonlyArray<{ state: StatusState }>): StatusState | null {
  if (statuses.length === 0) return null;
  if (statuses.some((status) => status.state === "failure" || status.state === "error")) {
    return "failure";
  }
  return statuses.some((status) => status.state === "pending") ? "pending" : "success";
}

export function knownContexts(repo: RepositoryRecord): string[] {
  const contexts = new Set<string>();
  for (const record of runsOf(repo)) for (const job of record.jobs) contexts.add(contextOf(job));
  for (const [key, list] of reported) {
    if (key.startsWith(`${repo.id}:`)) for (const status of list) contexts.add(status.context);
  }
  return [...contexts].sort();
}
