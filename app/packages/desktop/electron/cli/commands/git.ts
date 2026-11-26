// `infrawrench git`: the organisation's namespace on git.infrawrench.com with
// its usage against the plan, and `infrawrench git repos`, its repositories.
//
// Cloud-only: a namespace belongs to an organisation, and the forge is a
// site of its own that a local workspace knows nothing of. The CLI reads;
// claiming, renaming and the default visibility are Settings > Git, and
// everything about one repository is the forge itself (each row carries its
// address there).
//
// The response shapes come from `@infrawrench/client-core` type-only, so the
// CLI keeps its zero-runtime-dependency rule. Visibility and CI status are
// decoded as strings: a newer server's value still renders.
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import type { GitForgeOverview, GitForgeRepositoryList } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";
import { formatChangeTime } from "../format";

const Overview = wire<GitForgeOverview>()(
  Schema.Struct({
    forgeUrl: Schema.String,
    namespace: Schema.NullOr(
      Schema.Struct({
        slug: Schema.String,
        url: Schema.String,
        defaultVisibility: Schema.String,
      }),
    ),
    plan: Schema.String,
    limits: Schema.Struct({
      privateRepositories: Schema.NullOr(Schema.Finite),
      privateStorageBytes: Schema.Finite,
      includedStorageBytes: Schema.Finite,
    }),
    usage: Schema.Struct({
      repositories: Schema.Finite,
      publicRepositories: Schema.Finite,
      privateRepositories: Schema.Finite,
      storageBytes: Schema.Finite,
      privateStorageBytes: Schema.Finite,
    }),
  }),
);

const Repositories = wire<GitForgeRepositoryList>()(
  Schema.Struct({
    repositories: Schema.Array(
      Schema.Struct({
        fullName: Schema.String,
        url: Schema.String,
        visibility: Schema.String,
        archived: Schema.Boolean,
        pushedAt: Schema.NullOr(Schema.String),
        openPullRequests: Schema.Finite,
        sizeBytes: Schema.Finite,
        ci: Schema.NullOr(Schema.Struct({ status: Schema.String })),
      }),
    ),
  }),
);
type Repository = (typeof Repositories.Type)["repositories"][number];

/** `1.5 GiB`: binary units, the ones the plan's limits are stated in. */
function gib(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${units[unit]}`;
}

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "A namespace on git.infrawrench.com belongs to a cloud organization. Drop --local.",
    });
  }
});

function ciCell(status: string | undefined): string {
  if (status === undefined) return c.dim("—");
  if (status === "passed") return c.green(status);
  if (status === "failed" || status === "error") return c.red(status);
  if (status === "running" || status === "queued" || status === "pending") return c.yellow(status);
  return c.dim(safe(status));
}

const showOverview = Effect.fn("git")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  yield* requireCloud;
  const org = yield* currentOrg;
  const path = "/git";
  const body = yield* api.json(org.id, path);
  if (session.output === "json") {
    return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
  }
  const { namespace, plan, limits, usage } = yield* decodeBody(Overview, path)(body);

  if (!namespace) {
    return yield* Print.line(
      c.dim(
        "No namespace claimed. Someone with git:admin can claim one under Settings → Git in the web or desktop app.",
      ),
    );
  }
  yield* Print.line(`${c.bold(safe(org.displayName))} ${c.dim("·")} ${safe(namespace.url)}`);
  yield* Print.line();
  yield* Print.keyValues([
    ["namespace", safe(namespace.slug)],
    ["new repositories", safe(namespace.defaultVisibility)],
    ["plan", safe(plan)],
    ["public repositories", `${usage.publicRepositories} ${c.dim("(free)")}`],
    [
      "private repositories",
      limits.privateRepositories === null
        ? String(usage.privateRepositories)
        : `${usage.privateRepositories} of ${limits.privateRepositories}`,
    ],
    [
      "private storage",
      `${gib(usage.privateStorageBytes)} of ${gib(limits.privateStorageBytes)}` +
        (limits.includedStorageBytes < limits.privateStorageBytes
          ? c.dim(` (${gib(limits.includedStorageBytes)} included, then metered)`)
          : ""),
    ],
    ["all storage", gib(usage.storageBytes)],
  ]);
  yield* Print.line();
  yield* Print.line(c.dim("`infrawrench git repos` lists the repositories."));
});

const repos = Command.make(
  "repos",
  {},
  Effect.fn("git.repos")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud;
    const org = yield* currentOrg;
    const path = "/git/repositories";
    const body = yield* api.json(org.id, path);
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const { repositories } = yield* decodeBody(Repositories, path)(body);
    if (repositories.length === 0) {
      return yield* Print.line(c.dim("No repositories on git.infrawrench.com yet."));
    }
    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· ${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}, most recently pushed first`)}`,
    );
    yield* Print.line();
    const columns: Column<Repository>[] = [
      {
        header: "repository",
        value: (r) => `${c.bold(safe(r.fullName))}${r.archived ? c.dim(" archived") : ""}`,
      },
      {
        header: "visibility",
        value: (r) => (r.visibility === "public" ? safe(r.visibility) : c.dim(safe(r.visibility))),
      },
      { header: "ci", value: (r) => ciCell(r.ci?.status) },
      { header: "open prs", value: (r) => String(r.openPullRequests), align: "right" },
      {
        header: "last push",
        value: (r) => c.dim(r.pushedAt ? formatChangeTime(r.pushedAt) : "never"),
      },
      { header: "size", value: (r) => gib(r.sizeBytes), align: "right" },
      { header: "address", value: (r) => c.dim(safe(r.url)) },
    ];
    yield* Print.table(repositories, columns);
  }),
).pipe(
  Command.withDescription(
    "The organization's repositories on git.infrawrench.com: visibility, CI, open PRs & last push",
  ),
);

export const git = Command.make("git", {}, showOverview).pipe(
  Command.withDescription(
    "The organization's namespace on git.infrawrench.com and its usage against the plan",
  ),
  Command.withSubcommands([repos]),
);
