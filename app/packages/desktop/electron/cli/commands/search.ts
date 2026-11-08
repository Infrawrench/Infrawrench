// `infrawrench search <query>`: the command palette's index from a terminal.
// Every kind the caller's role can read (resources, workflows, cost reports,
// dashboards, budgets, SLOs, services, runbooks, …), narrowed server-side to
// what the caller could open and fuzzy-ranked, each with the web address that
// opens it. `--kind cost_report,slo` narrows; `--json` for scripts.
//
// `infrawrench starred` lists the caller's stars (the palette's first
// section); `starred add|remove <kind> <id>` toggles one, with the kind and id
// exactly as `search --json` prints them.
//
// Types come from `@infrawrench/client-core` type-only; the runtime helpers
// (kind list, labels, URLs) load with a dynamic import, the CLI's rule for
// client-core code. Zero new runtime dependencies.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { CLOUD_URL } from "../../../env";
import type {
  SearchResult,
  SearchResultKind,
  StarredItem,
  StarredListResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { kind } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, safe } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

const loadCore = Effect.promise((): Promise<Core> => import("@infrawrench/client-core"));

// `kind` stays a string: one this build does not know is inferred from the
// hit's other fields, the way a hit from a server that predates kinds is.
const Hit = Schema.Struct({
  id: Schema.String,
  kind: Schema.optional(Schema.String),
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  resourceTypeLabel: Schema.String,
  accountId: Schema.String,
  accountName: Schema.String,
  displayName: Schema.String,
  subtitle: Schema.optional(Schema.String),
});
type Hit = typeof Hit.Type;

const Hits = wire<SearchResult[]>()(Schema.Array(Hit));
const Starred = wire<StarredListResponse>()(Schema.Struct({ items: Schema.Array(Hit) }));
const StarResult = wire<{ item: StarredItem }>()(
  Schema.Struct({ item: Schema.Struct({ displayName: Schema.String }) }),
);

/** JSON objects, keys in the order the server sent them. */
const RawObjects = Schema.Array(Schema.Record(Schema.String, Schema.Unknown));
const RawStarred = Schema.Struct({ items: RawObjects });

const requireCloud = (what: string) =>
  Effect.gen(function* () {
    const session = yield* CliSession;
    if (session.local) {
      return yield* new CliFailure({
        message: `${what} live in Infrawrench Cloud, per organization. Drop --local.`,
      });
    }
  });

/** The hit's kind, with one this build does not know inferred instead. */
const kindOf = (core: Core, hit: Hit): SearchResultKind =>
  core.searchResultKind({
    pluginId: hit.pluginId,
    resourceTypeId: hit.resourceTypeId,
    kind: core.isSearchResultKind(hit.kind) ? hit.kind : undefined,
  });

/** The web address a hit opens at, for clicking from a terminal. */
function hitUrl(core: Core, orgId: string, hit: Hit): string {
  const kind = kindOf(core, hit);
  if (kind === "resource") {
    return core.webResourceUrl(CLOUD_URL, orgId, {
      accountId: hit.accountId,
      pluginId: hit.pluginId,
      resourceTypeId: hit.resourceTypeId,
      resourceId: hit.id,
    });
  }
  if (kind === "workflow") return core.webWorkflowUrl(CLOUD_URL, orgId, hit.id);
  return core.webObjectUrl(CLOUD_URL, orgId, kind, hit.id);
}

const parseKinds = (
  core: Core,
  raw: string | undefined,
): Effect.Effect<SearchResultKind[] | "all", CliUsageError> => {
  if (!raw) return Effect.succeed("all");
  const words = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const kinds = words.filter(core.isSearchResultKind);
  const unknown = words.filter((k) => !core.isSearchResultKind(k));
  if (unknown.length > 0) {
    return Effect.fail(
      new CliUsageError({
        message: `Unknown kind ${unknown.map((k) => `"${k}"`).join(", ")}. Valid: ${core.SEARCH_RESULT_KINDS.join(", ")}.`,
      }),
    );
  }
  return Effect.succeed(kinds);
};

const printHits = (core: Core, orgId: string, hits: ReadonlyArray<Hit>) =>
  Print.table(hits, [
    { header: "KIND", value: (h) => core.SEARCH_KIND_LABELS[kindOf(core, h)].singular },
    { header: "NAME", value: (h) => safe(h.displayName) },
    {
      header: "DETAIL",
      value: (h) =>
        safe(
          kindOf(core, h) === "resource"
            ? [h.resourceTypeLabel, h.accountName].filter(Boolean).join(" · ")
            : (h.subtitle ?? ""),
        ),
    },
    { header: "OPEN", value: (h) => c.dim(hitUrl(core, orgId, h)) },
  ]);

/** `infrawrench search <query> [--kind a,b] [--json]`. */
export const search = Command.make(
  "search",
  {
    query: Argument.String("query").pipe(
      Argument.withDescription("What to look for (the words join into one query)"),
      Argument.variadic(),
    ),
    kind: kind.pipe(
      Flag.withMetavar("kind,…"),
      Flag.withDescription(
        "Only these kinds (resource, workflow, cost_report, dashboard, budget, slo, …)",
      ),
    ),
  },
  Effect.fn("search")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    yield* requireCloud("The search index and its saved objects");
    const query = input.query.join(" ");
    if (!query.trim()) {
      return yield* new CliUsageError({
        message: "Give something to search for: `infrawrench search <query>`.",
      });
    }
    const core = yield* loadCore;
    const kinds = yield* parseKinds(core, Option.getOrUndefined(input.kind));
    const org = yield* currentOrg;
    const path = `/search?${core.searchQueryString(query, { kinds })}`;
    const body = yield* api.json(org.id, path);
    const hits = yield* decodeBody(Hits, path)(body);

    if (session.output === "json") {
      const raw = yield* decodeBody(RawObjects, path)(body);
      return yield* Print.json({
        org: org.id,
        query,
        results: hits.map((h, i) => ({
          ...raw[i],
          kind: kindOf(core, h),
          url: hitUrl(core, org.id, h),
        })),
      });
    }

    if (hits.length === 0) {
      return yield* Print.line(c.dim(`Nothing you can open matches "${safe(query)}".`));
    }
    yield* printHits(core, org.id, hits);
  }),
).pipe(
  Command.withDescription(
    "The Cmd+K index: resources, workflows, reports, dashboards and more you can open, best match first",
  ),
);

const listStarred = Effect.fn("starred")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  yield* requireCloud("Stars");
  const core = yield* loadCore;
  const org = yield* currentOrg;
  const path = "/starred";
  const body = yield* api.json(org.id, path);
  const { items } = yield* decodeBody(Starred, path)(body);
  if (session.output === "json") {
    const raw = yield* decodeBody(RawStarred, path)(body);
    return yield* Print.json({
      org: org.id,
      items: items.map((item, i) => ({ ...raw.items[i], url: hitUrl(core, org.id, item) })),
    });
  }
  if (items.length === 0) {
    return yield* Print.line(
      c.dim(
        "Nothing starred yet. Star a report, dashboard, SLO or resource from its page header or " +
          "with the modifier+S in Cmd+K, or `infrawrench starred add <kind> <id>`.",
      ),
    );
  }
  yield* printHits(core, org.id, items);
});

const starArgs = {
  kind: Argument.String("kind").pipe(
    Argument.withDescription("The kind, as `search --json` prints it"),
    Argument.optional,
  ),
  id: Argument.String("id").pipe(
    Argument.withDescription("The id, as `search --json` prints it"),
    Argument.variadic(),
  ),
};

/** `starred add|remove <kind> <id>`: one star, on or off. */
const toggle = (verb: "add" | "remove") =>
  Command.make(
    verb,
    starArgs,
    Effect.fn(`starred.${verb}`)(function* (input) {
      const session = yield* CliSession;
      const api = yield* CloudApi;
      yield* requireCloud("Stars");
      const core = yield* loadCore;
      const org = yield* currentOrg;
      const kindArg = Option.getOrUndefined(input.kind);
      const id = input.id.join(" ");
      if (!kindArg || !id) {
        return yield* new CliUsageError({
          message: `Usage: infrawrench starred ${verb} <kind> <id>. \`infrawrench search <query> --json\` prints both.`,
        });
      }
      if (!core.isSearchResultKind(kindArg)) {
        return yield* new CliUsageError({
          message: `Unknown kind "${kindArg}". Valid: ${core.SEARCH_RESULT_KINDS.join(", ")}.`,
        });
      }
      const ref = { kind: kindArg, id };
      const path = core.starPath(ref);
      if (verb === "add") {
        const body = yield* api.json(org.id, path, { method: "PUT" });
        if (session.output === "json") {
          const { item } = yield* decodeBody(Schema.Struct({ item: Schema.Unknown }), path)(body);
          return yield* Print.json({ org: org.id, item });
        }
        const { item } = yield* decodeBody(StarResult, path)(body);
        return yield* Print.line(`Starred ${safe(item.displayName)}.`);
      }
      yield* api.json(org.id, path, { method: "DELETE" });
      if (session.output === "json") return yield* Print.json({ org: org.id, removed: ref });
      yield* Print.line("Unstarred.");
    }),
  ).pipe(Command.withDescription(verb === "add" ? "Star one object" : "Unstar one object"));

/** `infrawrench starred`, `starred add <kind> <id>`, `starred remove <kind> <id>`. */
export const starred = Command.make("starred", {}, listStarred).pipe(
  Command.withDescription("Your starred items in this org (listed first in Cmd+K)"),
  Command.withSubcommands([
    Command.make("list", {}, listStarred).pipe(Command.withDescription("Your starred items")),
    toggle("add"),
    toggle("remove"),
  ]),
);
