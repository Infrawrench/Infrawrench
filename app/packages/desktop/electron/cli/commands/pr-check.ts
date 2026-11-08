// `infrawrench pr-check`: the pull request check, before (or without) a pull
// request. Two forms:
//
//   infrawrench pr-check [--base <ref>] [--repo owner/name]
//     analyses the local working tree against the merge base with <ref>
//     (default: the remote's default branch), uncommitted edits included;
//   infrawrench pr-check --repo owner/name --pr <n>
//     analyses an open pull request through the org's GitHub App.
//
// Either way nothing is posted: this is `POST /pr-checks/preview`, the same
// analysis the github-watcher posts as a check run, so the numbers here are
// the numbers the pull request will show. Cloud-only (pricing runs on the
// server's plugin clients, blast radius on the org's synced graph).
//
// Zero new dependencies: git is run with node:child_process, and only the
// file kinds the check reads are sent (Terraform, Infrafiles and YAML that
// looks like a Kubernetes manifest), at most 50 of them.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import type {
  PrCheckPreview,
  PrCheckPreviewFile,
  PrCheckRepository,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { positiveInt } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { githubRepoFromRemote, parseNameStatusZ } from "../format";
import { c, type Column } from "../output";

const run = promisify(execFile);

/** Mirrors `PR_CHECK_LIMITS` (the CLI imports client-core types only). */
const MAX_FILES = 50;
const MAX_FILE_BYTES = 512 * 1024;

const PREVIEW_PATH = "/pr-checks/preview";
const REPOSITORIES_PATH = "/pr-checks/repositories";

const Repositories = wire<PrCheckRepository[]>()(
  Schema.Array(Schema.Struct({ id: Schema.String, repo: Schema.String })),
);

const Side = Schema.NullOr(
  Schema.Struct({ monthlyAmount: Schema.Finite, currency: Schema.String }),
);

const Preview = wire<PrCheckPreview>()(
  Schema.Struct({
    // The conclusion and the enums below read as text, so a newer value still prints.
    conclusion: Schema.String,
    title: Schema.String,
    report: Schema.Struct({
      changes: Schema.Array(
        Schema.Struct({
          address: Schema.String,
          action: Schema.String,
          resourceId: Schema.NullOr(Schema.String),
          before: Side,
          after: Side,
          monthlyDelta: Schema.NullOr(Schema.Finite),
          currency: Schema.NullOr(Schema.String),
          unpricedReason: Schema.NullOr(Schema.String),
          blastRadius: Schema.NullOr(
            Schema.Struct({
              severity: Schema.String,
              directDependants: Schema.Finite,
              transitiveDependants: Schema.Finite,
            }),
          ),
          warnings: Schema.Array(
            Schema.Struct({ severity: Schema.String, message: Schema.String }),
          ),
        }),
      ),
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String,
          analysed: Schema.Boolean,
          note: Schema.NullOr(Schema.String),
        }),
      ),
      notes: Schema.Array(Schema.String),
    }),
  }),
);
type Change = (typeof Preview.Type)["report"]["changes"][number];

/** `git <args>`'s stdout; a failure is one sentence naming the subcommand. */
const git = (args: string[]): Effect.Effect<string, CliFailure> =>
  Effect.tryPromise({
    try: async () => (await run("git", args, { maxBuffer: 32 * 1024 * 1024 })).stdout,
    catch: (e) => {
      const message = e instanceof Error ? e.message.split("\n")[0] : String(e);
      return new CliFailure({ message: `git ${args[0]} failed: ${message}` });
    },
  });

/** {@link git}, or `fallback` when it fails: a question whose "no" is an answer. */
const gitOr = (args: string[], fallback: string | null) =>
  git(args).pipe(Effect.orElseSucceed(() => fallback));

function isInfraPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".tf") || base === "Infrafile" || /\.ya?ml$/i.test(base);
}

const defaultBase = Effect.gen(function* () {
  const head = yield* gitOr(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], "");
  const ref = (head ?? "").trim().replace(/^refs\/remotes\//, "");
  return ref || "origin/main";
});

const localFiles = Effect.fnUntraced(function* (base: string, root: string) {
  const session = yield* CliSession;
  const mergeBase = (yield* git(["merge-base", base, "HEAD"])).trim();
  const entries = parseNameStatusZ(
    yield* git(["diff", "--name-status", "-M", "-z", mergeBase, "--"]),
  ).filter((e) => isInfraPath(e.path));
  const untracked = (yield* git(["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((p) => p.length > 0 && isInfraPath(p))
    .map((path) => ({ status: "A" as const, path, previousPath: null }));

  const files: PrCheckPreviewFile[] = [];
  for (const e of [...entries, ...untracked].slice(0, MAX_FILES)) {
    const before =
      e.status === "A"
        ? null
        : yield* gitOr(["show", `${mergeBase}:${e.previousPath ?? e.path}`], null);
    const after =
      e.status === "D"
        ? null
        : yield* Effect.promise(() => readFile(`${root}/${e.path}`, "utf8").catch(() => null));
    if (before === null && after === null) continue;
    if ((before?.length ?? 0) > MAX_FILE_BYTES || (after?.length ?? 0) > MAX_FILE_BYTES) {
      // On stderr under --json, so the note never corrupts the document a pipe reads.
      const note = c.yellow(`skipping ${e.path}: larger than ${MAX_FILE_BYTES / 1024} KiB`);
      yield* session.output === "json" ? Print.errLine(note) : Print.line(note);
      continue;
    }
    files.push({ path: e.path, before, after });
  }
  return files;
});

export const prCheck = Command.make(
  "pr-check",
  {
    repo: Flag.String("repo").pipe(
      Flag.withMetavar("owner/name"),
      Flag.withDescription("Whose settings and Terraform state mapping apply"),
      Flag.optional,
    ),
    pr: positiveInt("pr").pipe(
      Flag.withMetavar("n"),
      Flag.withDescription("Preview this pull request through the GitHub App (needs --repo)"),
      Flag.optional,
    ),
    base: Flag.String("base").pipe(
      Flag.withMetavar("ref"),
      Flag.withDescription(
        "What the local diff compares against (default: the remote's default branch)",
      ),
      Flag.optional,
    ),
  },
  Effect.fn("pr-check")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    let body: unknown;
    let label: string;

    if (Option.isSome(input.pr)) {
      if (Option.isNone(input.repo)) {
        return yield* new CliFailure({ message: "--pr needs --repo owner/name." });
      }
      const wanted = input.repo.value;
      const repos = yield* api.decode(Repositories, org.id, REPOSITORIES_PATH);
      const repository = repos.find((r) => r.repo.toLowerCase() === wanted.toLowerCase());
      if (!repository) {
        return yield* new CliFailure({
          message: `${wanted} has no pull request checks configured. Turn them on in Settings → Pull Request Checks.`,
        });
      }
      label = `${repository.repo}#${input.pr.value}`;
      body = yield* api.json(org.id, PREVIEW_PATH, {
        method: "POST",
        body: JSON.stringify({ repositoryId: repository.id, pullNumber: input.pr.value }),
      });
    } else {
      const root = (yield* git(["rev-parse", "--show-toplevel"])).trim();
      const base = Option.isSome(input.base) ? input.base.value : yield* defaultBase;
      const repo = Option.isSome(input.repo)
        ? input.repo.value
        : (githubRepoFromRemote((yield* gitOr(["remote", "get-url", "origin"], "")) ?? "") ??
          undefined);
      const files = yield* localFiles(base, root);
      label = `working tree vs ${base}`;
      if (files.length === 0) {
        if (session.output === "json") {
          return yield* Print.json({ org: org.id, base, files: 0, preview: null });
        }
        return yield* Print.line(c.dim(`No infrastructure files differ from ${base}.`));
      }
      body = yield* api.json(org.id, PREVIEW_PATH, {
        method: "POST",
        body: JSON.stringify({ files, ...(repo ? { repo } : {}) }),
      });
    }

    if (session.output === "json") {
      return yield* Print.json(
        yield* spreadBody({ org: org.id, target: label }, body, PREVIEW_PATH),
      );
    }
    const preview = yield* decodeBody(Preview, PREVIEW_PATH)(body);

    const conclusion =
      preview.conclusion === "failure"
        ? c.red("failure")
        : preview.conclusion === "neutral"
          ? c.yellow("neutral")
          : c.green("success");
    yield* Print.line(
      `${c.bold(label)} ${c.dim("·")} ${conclusion} ${c.dim("·")} ${preview.title}`,
    );
    const { report } = preview;
    if (report.changes.length > 0) {
      yield* Print.line();
      const money = (s: { monthlyAmount: number; currency: string } | null) =>
        s ? `${s.currency} ${s.monthlyAmount.toFixed(2)}` : c.dim("-");
      const columns: Column<Change>[] = [
        { header: "resource", value: (ch) => ch.address },
        { header: "action", value: (ch) => ch.action },
        { header: "before", value: (ch) => money(ch.before), align: "right" },
        { header: "after", value: (ch) => money(ch.after), align: "right" },
        {
          header: "monthly",
          value: (ch) =>
            ch.monthlyDelta !== null && ch.currency
              ? `${ch.monthlyDelta > 0 ? "+" : ""}${ch.monthlyDelta.toFixed(2)}`
              : c.dim("not priced"),
          align: "right",
        },
        {
          header: "blast radius",
          value: (ch) =>
            ch.blastRadius
              ? `${ch.blastRadius.severity} (${ch.blastRadius.directDependants + ch.blastRadius.transitiveDependants})`
              : c.dim(ch.action === "create" ? "new" : ch.resourceId ? "unknown" : "not matched"),
        },
      ];
      yield* Print.table(report.changes, columns);
    }
    const warnings = report.changes.flatMap((ch) =>
      ch.warnings.map(
        (w) =>
          `${w.severity === "warning" ? c.yellow("!") : c.dim("i")} ${ch.address}: ${w.message}`,
      ),
    );
    if (warnings.length > 0) {
      yield* Print.line();
      for (const w of warnings) yield* Print.line(w);
    }
    const unpriced = report.changes.filter((ch) => ch.unpricedReason);
    if (unpriced.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("not priced"));
      for (const ch of unpriced) {
        yield* Print.line(`  ${ch.address}: ${c.dim(ch.unpricedReason ?? "")}`);
      }
    }
    const skipped = report.files.filter((f) => !f.analysed);
    for (const f of skipped) yield* Print.line(c.dim(`${f.path}: ${f.note ?? "not analysed"}`));
    if (report.notes.length > 0) {
      yield* Print.line();
      for (const n of report.notes) yield* Print.line(c.dim(n));
    }
  }),
).pipe(
  Command.withDescription(
    "The pull request check on a local diff (--base) or an open pull request (--repo --pr), posting nothing",
  ),
);
