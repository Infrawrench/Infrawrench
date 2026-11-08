// `infrawrench changes`: the cross-provider drift feed in the terminal,
// backed by the same /changes endpoint the web Changes page reads.
//
// Every poll cycle diffs a freshly fetched account against the stored snapshot
// and records what appeared, changed, or disappeared. The diff runs on the
// generic stored record, so this is cross-provider by construction: no plugin
// contributes anything to it, and a new plugin shows up here the moment its
// resources sync.
//
// Wire types and the row summary come from `@infrawrench/client-core`: the
// same definitions the web feed renders with, so a server-side change breaks
// the CLI's build instead of its output.
import { Effect, Option, Predicate, Schema } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import type { ResourceChangeEntry } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { listCloudAccounts, resolveAccount } from "../context";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { days, from, kind, lastDays, limit, resource, to } from "../effect/range-flags";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, safe } from "../output";
import { formatChangeTime } from "../format";

/** The endpoint's own `pageSize` bound. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const KINDS = ["created", "updated", "deleted"] as const;
type Kind = (typeof KINDS)[number];

/** One glyph + color per kind, so a long feed reads at a glance. */
const KIND_STYLE: Record<Kind, { glyph: string; color: (s: string) => string }> = {
  created: { glyph: "+", color: c.green },
  updated: { glyph: "~", color: c.blue },
  deleted: { glyph: "-", color: c.red },
};

const Entry = Schema.Struct({
  createdAt: Schema.String,
  changeKind: Schema.Literals(KINDS),
  displayName: Schema.String,
  pluginId: Schema.String,
  resourceTypeId: Schema.String,
  accountName: Schema.optional(Schema.NullOr(Schema.String)),
  // `summarizeChange` takes the diff as a mutable array.
  diff: Schema.mutable(
    Schema.Array(Schema.Struct({ field: Schema.String, from: Schema.Unknown, to: Schema.Unknown })),
  ),
});

const Feed = wire<{ entries: ResourceChangeEntry[]; total: number }>()(
  Schema.Struct({ entries: Schema.Array(Entry), total: Schema.Finite }),
);

/** The feed's rows as the server sent them, for `--json`. */
const RawFeed = Schema.Struct({ entries: Schema.Array(Schema.Unknown), total: Schema.Finite });

const kindFlag = kind.pipe(
  Flag.withMetavar("created|updated|deleted"),
  Flag.withDescription("Only this kind of change"),
  Flag.mapEffect((value) =>
    Option.match(value, {
      onNone: () => Effect.succeedNone,
      onSome: (wanted) => {
        const known = KINDS.find((k) => k === wanted);
        return known
          ? Effect.succeedSome(known)
          : Effect.fail(
              new CliError.ValidationError({
                message: `--kind must be one of ${KINDS.join(", ")} (got "${wanted}").`,
              }),
            );
      },
    }),
  ),
);

/**
 * The `from`/`to` the feed should be asked for. `--last 7d` is the common case;
 * explicit `--from`/`--to` pass through as given (the endpoint wants ISO
 * date-times, which is also what a user typing a date gets).
 */
const resolveWindow = (input: {
  readonly from: Option.Option<string>;
  readonly to: Option.Option<string>;
  readonly days: Option.Option<number>;
  readonly last: Option.Option<number>;
}): Effect.Effect<{ from?: string; to?: string }, CliUsageError> => {
  const to = Option.getOrUndefined(input.to);
  const toPart = to ? { to } : {};
  if (Option.isSome(input.from) && input.from.value) {
    return Effect.succeed({ from: input.from.value, ...toPart });
  }
  const span = Option.orElse(input.days, () => input.last);
  if (Option.isNone(span)) return Effect.succeed(toPart);
  const anchor = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(anchor)) {
    return Effect.fail(
      new CliUsageError({ message: `Invalid --to "${to}": use an ISO 8601 date or date-time.` }),
    );
  }
  return Effect.succeed({
    from: new Date(anchor - span.value * 86_400_000).toISOString(),
    ...toPart,
  });
};

export const changes = Command.make(
  "changes",
  {
    last: lastDays,
    days,
    from,
    to,
    limit: limit.pipe(
      Flag.withDescription(`Events to show (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
    ),
    kind: kindFlag,
    resource: resource.pipe(Flag.withDescription("Only this resource, with its field diffs")),
  },
  Effect.fn("changes")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message:
          "The change timeline is recorded by Infrawrench Cloud's poller as it syncs your accounts. Local-only mode has no poller, so there is no feed.",
      });
    }
    const org = yield* currentOrg;
    const pageSize = Math.min(
      Option.getOrElse(input.limit, () => DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const focus = Option.getOrUndefined(input.resource);

    const params = new URLSearchParams({ page: "1", pageSize: String(pageSize) });
    if (Option.isSome(input.kind)) params.set("kind", input.kind.value);
    if (focus) params.set("resourceId", focus);

    // --account takes the same id/name/prefix forms as every other command, so
    // resolve it against the org's accounts rather than pushing a raw string at
    // a uuid-typed query parameter.
    const wantedAccount = session.account;
    if (wantedAccount) {
      const account = yield* Effect.promise(async () =>
        resolveAccount(await listCloudAccounts(org.id), wantedAccount),
      );
      params.set("accountId", account.id);
    }

    const window = yield* resolveWindow(input);
    if (window.from) params.set("from", window.from);
    if (window.to) params.set("to", window.to);

    const path = `/changes?${params.toString()}`;
    const body = yield* api.json(org.id, path);

    if (session.output === "json") {
      const raw = yield* decodeBody(RawFeed, path)(body);
      return yield* Print.json({
        org: org.id,
        limit: pageSize,
        total: raw.total,
        entries: raw.entries,
      });
    }
    const { entries, total } = yield* decodeBody(Feed, path)(body);

    // The summary line ("name, size and 2 more") is shared with the web feed:
    // one definition of what an update reads as.
    const { summarizeChange, formatChangeValue } = yield* Effect.promise(
      () => import("@infrawrench/client-core"),
    );

    if (entries.length === 0) {
      return yield* Print.line(
        c.dim(
          "No changes recorded for this filter. Events start accumulating once the poller has synced an account at least twice.",
        ),
      );
    }

    yield* Print.line(
      `${c.bold(safe(org.displayName))} ${c.dim(`· ${entries.length} of ${total} event${total === 1 ? "" : "s"}, newest first`)}`,
    );
    yield* Print.line();

    yield* Print.table(entries, [
      { header: "when", value: (e) => c.dim(formatChangeTime(e.createdAt)) },
      {
        header: "",
        value: (e) => KIND_STYLE[e.changeKind].color(KIND_STYLE[e.changeKind].glyph),
      },
      { header: "resource", value: (e) => c.bold(safe(e.displayName)) },
      { header: "type", value: (e) => c.dim(safe(`${e.pluginId}/${e.resourceTypeId}`)) },
      {
        header: "account",
        value: (e) => (Predicate.isNullish(e.accountName) ? c.dim("—") : safe(e.accountName)),
      },
      { header: "what changed", value: (e) => safe(summarizeChange(e)) },
    ]);

    // Field-level diffs are the reason to look at one resource, so they print in
    // full when the feed is already narrowed to one, never for a whole org's
    // feed, which would be thousands of lines.
    if (focus) {
      for (const entry of entries) {
        if (entry.changeKind !== "updated" || entry.diff.length === 0) continue;
        yield* Print.line();
        yield* Print.line(
          `${c.dim(formatChangeTime(entry.createdAt))} ${c.bold(safe(entry.displayName))}`,
        );
        yield* Print.keyValues(
          entry.diff.map((d) => [
            safe(d.field),
            `${c.dim(safe(formatChangeValue(d.from)))} ${c.dim("→")} ${safe(formatChangeValue(d.to))}`,
          ]),
        );
      }
    }

    yield* Print.line();
    yield* Print.line(
      c.dim(
        focus
          ? "Pass --limit to see further back."
          : "Narrow with --account <id|name>, --resource <id>, --kind created|updated|deleted, or --last 7d.",
      ),
    );
  }),
).pipe(Command.withDescription("What appeared, changed or disappeared across your providers"));
