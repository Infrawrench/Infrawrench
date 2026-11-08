// `infrawrench github-issues`: findings filed as GitHub issues (open first),
// and `infrawrench github-issues settings`: the routing document plus whether
// each GitHub App installation has accepted the permissions filing needs.
//
// Cloud-only: filing runs on the server's GitHub App. Read-only here; filing
// and pull requests happen from the Savings rows (or a routing rule), where
// the evidence is on screen. Types come from `@infrawrench/client-core`,
// type-only, so the CLI takes no new runtime dependency.
import type { GithubIssueLink, GithubIssuesStatus } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, type Column } from "../output";

const LINKS_PATH = "/github-issues/links";
const STATUS_PATH = "/github-issues";

// `state` stays a string: anything but "open" reads as closed, as it always has.
const Links = wire<GithubIssueLink[]>()(
  Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      issueNumber: Schema.Finite,
      state: Schema.String,
      status: Schema.optional(Schema.NullOr(Schema.String)),
      assignee: Schema.optional(Schema.NullOr(Schema.String)),
      sourceKind: Schema.String,
      autoFiled: Schema.Boolean,
      pullRequestNumber: Schema.NullOr(Schema.Finite),
      createdAt: Schema.String,
    }),
  ),
);
type Link = (typeof Links.Type)[number];

const Repo = Schema.Struct({ fullName: Schema.String });

const Status = wire<GithubIssuesStatus>()(
  Schema.Struct({
    appConfigured: Schema.Boolean,
    settings: Schema.Struct({
      enabled: Schema.Boolean,
      pullRequestsEnabled: Schema.Boolean,
      defaultRepo: Schema.NullOr(Repo),
      labels: Schema.Array(Schema.String),
      assignees: Schema.Array(Schema.String),
      resolveAction: Schema.String,
      routes: Schema.Array(
        Schema.Struct({
          match: Schema.Union([
            Schema.Struct({
              kind: Schema.Literal("tag"),
              tagKey: Schema.String,
              tagValue: Schema.NullOr(Schema.String),
            }),
            Schema.Struct({ kind: Schema.Literal("cost_centre"), costCentreId: Schema.String }),
          ]),
          repo: Repo,
        }),
      ),
      iacSources: Schema.Array(
        Schema.Struct({
          iacAccountId: Schema.NullOr(Schema.String),
          repo: Repo,
          directory: Schema.String,
          baseBranch: Schema.NullOr(Schema.String),
        }),
      ),
    }),
    installations: Schema.Array(
      Schema.Struct({
        installationId: Schema.Finite,
        accountLogin: Schema.NullOr(Schema.String),
        issues: Schema.String,
        contents: Schema.String,
        pullRequests: Schema.String,
        checked: Schema.Boolean,
        manageUrl: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);

const links = Effect.fn("github-issues")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, LINKS_PATH);

  if (session.output === "json") return yield* Print.json({ org: org.id, links: body });
  const all = yield* decodeBody(Links, LINKS_PATH)(body);

  if (all.length === 0) {
    return yield* Print.line(c.dim("Nothing has been filed as a GitHub issue yet."));
  }
  const ordered = [...all].sort((a, b) =>
    a.state === b.state ? b.createdAt.localeCompare(a.createdAt) : a.state === "open" ? -1 : 1,
  );
  const open = all.filter((l) => l.state === "open").length;
  yield* Print.line(`${c.bold(org.displayName)} ${c.dim(`· ${open} open · ${all.length} filed`)}`);
  yield* Print.line();
  const columns: Column<Link>[] = [
    { header: "issue", value: (l) => `${l.repo}#${l.issueNumber}` },
    { header: "state", value: (l) => (l.state === "open" ? c.green("open") : c.dim("closed")) },
    { header: "status", value: (l) => l.status ?? c.dim("-") },
    { header: "assignee", value: (l) => l.assignee ?? c.dim("-") },
    { header: "finding", value: (l) => l.sourceKind.replace(/_/g, " ") },
    { header: "by", value: (l) => (l.autoFiled ? c.dim("rule") : "person") },
    { header: "pr", value: (l) => (l.pullRequestNumber ? `#${l.pullRequestNumber}` : c.dim("—")) },
    { header: "filed", value: (l) => c.dim(l.createdAt.slice(0, 10)) },
  ];
  yield* Print.table(ordered, columns);
});

const settings = Command.make(
  "settings",
  {},
  Effect.fn("github-issues.settings")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, STATUS_PATH);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, STATUS_PATH));
    }
    const status = yield* decodeBody(Status, STATUS_PATH)(body);

    const s = status.settings;
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim("·")} filing ${s.enabled ? c.green("on") : c.dim("off")} ${c.dim(
        "·",
      )} pull requests ${s.pullRequestsEnabled ? c.green("on") : c.dim("off")}`,
    );
    if (!status.appConfigured) {
      yield* Print.line(c.yellow("This server has no GitHub App configured."));
    }
    yield* Print.line(`default repository  ${s.defaultRepo?.fullName ?? c.dim("none")}`);
    yield* Print.line(`labels              ${s.labels.join(", ") || c.dim("none")}`);
    yield* Print.line(`assignees           ${s.assignees.join(", ") || c.dim("none")}`);
    yield* Print.line(`when resolved       ${s.resolveAction}`);
    if (s.routes.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("routes (first match wins)"));
      for (const r of s.routes) {
        const match =
          r.match.kind === "tag"
            ? `tag ${r.match.tagKey}${r.match.tagValue ? `=${r.match.tagValue}` : ""}`
            : `cost centre ${r.match.costCentreId}`;
        yield* Print.line(`  ${match} → ${r.repo.fullName}`);
      }
    }
    if (s.iacSources.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("terraform sources"));
      for (const x of s.iacSources) {
        yield* Print.line(
          `  ${x.iacAccountId ?? "org-wide state"} → ${x.repo.fullName}/${x.directory || "."} @ ${x.baseBranch ?? "default branch"}`,
        );
      }
    }
    yield* Print.line();
    yield* Print.line(c.bold("installations"));
    const ok = (lvl: string) => (lvl === "write" || lvl === "admin" ? c.green(lvl) : c.yellow(lvl));
    for (const i of status.installations) {
      yield* Print.line(
        `  ${i.accountLogin ?? i.installationId}  issues ${ok(i.issues)}  contents ${ok(i.contents)}  pull requests ${ok(i.pullRequests)}${
          i.checked ? "" : c.dim("  (could not ask GitHub)")
        }`,
      );
      if (i.checked && i.issues !== "write" && i.manageUrl) {
        yield* Print.line(c.dim(`    approve the app's updated permissions: ${i.manageUrl}`));
      }
    }
  }),
).pipe(
  Command.withDescription(
    "Repository routing, Terraform sources and each GitHub App installation's permissions",
  ),
);

export const githubIssues = Command.make("github-issues", {}, links).pipe(
  Command.withDescription("Findings filed as GitHub issues, open first, with any pull request"),
  Command.withSubcommands([settings]),
);
