// `infrawrench page` and `infrawrench costs push`: the two push-up surfaces,
// from the machine that has the news.
//
// This is the CLI's reason to exist on a server rather than a laptop: a cron,
// a deploy script, or a health check can reach the org's on-call fan-out and
// its cost history without embedding Twilio, Slack, Expo, or a ClickHouse
// client. Both commands are thin wrappers over `POST /pages` and
// `POST /costs/rows`; the server owns every rule, including the paging cooldown
// that makes it safe to call `page` on every tick of a monitor.
import { readFile } from "node:fs/promises";
import { Effect, Option, Predicate, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import { file as fileFlag, formatOf } from "../effect/file-flags";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { decodePaired } from "../effect/wire";
import { c } from "../output";
import {
  findCustomSource,
  LOCAL_REFUSAL,
  type PushOptions,
  pushToCustomSource,
  Sources,
  SOURCES_PATH,
} from "./custom-costs";

/** The `PageResponse` schema in the web package's OpenAPI paths, as text mode reads it. */
const PageResult = Schema.Struct({
  delivered: Schema.Boolean,
  suppressed: Schema.Boolean,
  sms: Schema.Finite,
  push: Schema.Finite,
  slack: Schema.Finite,
  msTeams: Schema.Finite,
  retryAt: Schema.optional(Schema.String),
});

const usage = (message: string) => new CliUsageError({ message });

const source = Flag.String("source").pipe(
  Flag.withMetavar("name"),
  Flag.withDescription("Who is pushing: the system raising this (required)"),
  Flag.optional,
);

const SOURCE_REQUIRED = "--source <name> is required. It names the system raising this.";

const requireSource = (flag: Option.Option<string>) =>
  Effect.fromOption(Option.filter(flag, (name) => name !== "")).pipe(
    Effect.mapError(() => usage(SOURCE_REQUIRED)),
  );

const key = Flag.String("key").pipe(
  Flag.withMetavar("k"),
  Flag.withDescription('The throttle key (the server defaults it to "default")'),
  Flag.optional,
);

const refusePageLocal = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({
      message: "Paging goes through Infrawrench Cloud. `--local` has nobody to page.",
    });
  }
});

/** `infrawrench page clear`: drop a key's cooldown after a recovery. */
const clearPage = Command.make(
  "clear",
  { source, key },
  Effect.fn("page.clear")(function* (input) {
    yield* refusePageLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const name = yield* requireSource(input.source);
    const org = yield* currentOrg;
    const keyValue = Option.getOrUndefined(input.key);
    const query = new URLSearchParams({ source: name, ...(keyValue ? { key: keyValue } : {}) });
    const path = `/pages?${query}`;
    const body = yield* api.json(org.id, path, { method: "DELETE" });
    if (session.output === "json") return yield* Print.json(body);
    const result = yield* decodeBody(Schema.Struct({ cleared: Schema.Boolean }), path)(body);
    yield* Print.line(
      result.cleared
        ? `${c.green("✓")} cooldown cleared; the next page delivers immediately`
        : `${c.dim("·")} nothing to clear; that key wasn't in cooldown`,
    );
  }),
).pipe(Command.withDescription("Drop a page key's cooldown after a recovery"));

/** `infrawrench page <message>`: raise an alert to the org's transports. */
export const page = Command.make(
  "page",
  {
    message: Argument.String("message").pipe(
      Argument.withDescription("The alert text (the words join into one message)"),
      Argument.variadic(),
    ),
    source,
    key,
    title: Flag.String("title").pipe(
      Flag.withMetavar("t"),
      Flag.withDescription("A title above the message"),
      Flag.optional,
    ),
    cooldown: Flag.String("cooldown").pipe(
      Flag.withMetavar("min"),
      Flag.withDescription("Minutes to suppress repeat pages under the same key"),
      Flag.mapEffect((text) => {
        const minutes = Number(text);
        return Number.isInteger(minutes) && minutes >= 0
          ? Effect.succeed(minutes)
          : Effect.fail(
              new CliError.ValidationError({
                message: `--cooldown must be a whole number of minutes, got "${text}"`,
              }),
            );
      }),
      Flag.optional,
    ),
    voice: Flag.Boolean("voice").pipe(
      Flag.withDescription("Also place a voice call"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("page")(function* (input) {
    yield* refusePageLocal;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const message = input.message.join(" ").trim();
    if (!message) {
      return yield* usage("Nothing to say. Pass the alert text: `infrawrench page …`");
    }
    const name = yield* requireSource(input.source);
    const org = yield* currentOrg;
    const title = Option.getOrUndefined(input.title);
    const keyValue = Option.getOrUndefined(input.key);
    const path = "/pages";
    const body = yield* api.json(org.id, path, {
      method: "POST",
      body: JSON.stringify({
        source: name,
        message,
        ...(title ? { title } : {}),
        ...(keyValue ? { key: keyValue } : {}),
        ...(Option.isSome(input.cooldown) ? { cooldownMinutes: input.cooldown.value } : {}),
        ...(input.voice ? { voice: true } : {}),
      }),
    });
    if (session.output === "json") return yield* Print.json(body);
    const result = yield* decodeBody(PageResult, path)(body);

    if (result.suppressed) {
      const retry = result.retryAt ? ` until ${result.retryAt}` : "";
      return yield* Print.line(
        `${c.yellow("○")} suppressed: this key is still in cooldown${retry}`,
      );
    }
    const counts = [
      result.sms > 0 ? `${result.sms} sms/voice` : null,
      result.push > 0 ? `${result.push} push` : null,
      result.slack > 0 ? `${result.slack} slack` : null,
      result.msTeams > 0 ? `${result.msTeams} teams` : null,
    ].filter(Predicate.isNotNull);

    if (!result.delivered) {
      // Not an error: the page was accepted and its cooldown rolled back, so the
      // next call tries again. Say so rather than implying the alert is lost.
      return yield* Print.line(
        `${c.yellow("!")} nobody was reached; check the org's paging settings`,
      );
    }
    yield* Print.line(`${c.green("✓")} paged ${c.dim(counts.join(", "))}`);
  }),
).pipe(
  Command.withDescription("Alert the org's on-call transports (page clear drops a key's cooldown)"),
  Command.withSubcommands([clearPage]),
);

/** Rows from `--file`, or from stdin when it isn't a terminal. */
const readRowsInput = Effect.fnUntraced(function* (file: Option.Option<string>) {
  if (Option.isSome(file)) {
    const path = file.value;
    return yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (e) => usage(`Can't read ${path}: ${e instanceof Error ? e.message : String(e)}`),
    });
  }
  if (process.stdin.isTTY) {
    return yield* usage("No rows. Pass --file <path> or pipe rows on stdin.");
  }
  return yield* Effect.promise(async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  });
});

const Rows = Schema.Array(Schema.Unknown);
const RowsEnvelope = Schema.Struct({ rows: Rows });

/**
 * Accept either a bare array of rows or the request envelope, so output from
 * `costs push --json` (and anything shaped like the API body) round-trips.
 */
const parseRows = Effect.fnUntraced(function* (text: string) {
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (e) => usage(`Rows aren't valid JSON: ${e instanceof Error ? e.message : String(e)}`),
  });
  const rows = Schema.decodeUnknownOption(Rows)(parsed).pipe(
    Option.orElse(() =>
      Schema.decodeUnknownOption(RowsEnvelope)(parsed).pipe(Option.map((e) => e.rows)),
    ),
  );
  if (Option.isSome(rows)) return rows.value;
  return yield* usage('Expected a JSON array of rows, or an object with a "rows" array.');
});

/**
 * `infrawrench costs push --source <name> [--file rows.json]`: report spend
 * Infrawrench has no plugin for. Rows come from a file or stdin, so the usual
 * shape is a pipeline: `parse-invoice | infrawrench costs push --source colo`.
 *
 * When `--source` names a custom cost source (Settings → Custom Cost Sources),
 * the rows become an upload in that source's history instead, and
 * `--format csv|focus` uploads a billing file directly; see `custom-costs.ts`.
 */
export const costsPush = Command.make(
  "push",
  {
    source,
    file: fileFlag.pipe(
      Flag.withDescription("JSON rows, or a CSV / FOCUS file with --format (stdin when omitted)"),
    ),
    format: formatOf(
      ["json", "csv", "focus"],
      () => "--format for costs push must be json, csv or focus.",
    ).pipe(Flag.withDescription("What the rows are: json (default), csv or focus")),
    map: Flag.String("map").pipe(
      Flag.withMetavar("field=column"),
      Flag.withDescription(
        "--format csv: map a column (date, cost, currency, service, account, region, resource, usageQuantity, usageUnit, tags; tag=<col> keeps a column as a tag). Repeatable",
      ),
      Flag.atLeast(0),
    ),
    currency: Flag.String("currency").pipe(
      Flag.withMetavar("code"),
      Flag.withDescription("Currency for CSV rows with no currency column"),
      Flag.optional,
    ),
    dateFormat: Flag.String("date-format").pipe(
      Flag.withMetavar("ymd|mdy|dmy"),
      Flag.withDescription("Order of slash-separated CSV dates"),
      Flag.optional,
    ),
    replace: Flag.Boolean("replace").pipe(
      Flag.withDescription("Dates overlap an earlier upload: supersede its spend"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    append: Flag.Boolean("append").pipe(
      Flag.withDescription("Dates overlap an earlier upload: add to its spend"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
  },
  Effect.fn("costs.push")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) return yield* new CliFailure({ message: LOCAL_REFUSAL });
    const name = yield* requireSource(input.source);
    const format = Option.getOrElse(input.format, (): "json" | "csv" | "focus" => "json");
    const text = yield* readRowsInput(input.file);

    const org = yield* currentOrg;
    const custom = findCustomSource(
      (yield* decodePaired(Sources, SOURCES_PATH)(yield* api.json(org.id, SOURCES_PATH))).map(
        (s) => ({ id: s.row.id, name: s.row.name, paired: s }),
      ),
      name,
    );
    if (format !== "json" && !custom) {
      return yield* usage(
        `No custom cost source named "${name}". CSV and FOCUS files upload into one: create it ` +
          "under Settings → Custom Cost Sources (or with Terraform), then retry.",
      );
    }
    const options: PushOptions = {
      file: input.file,
      map: input.map,
      currency: input.currency,
      mode: input.replace ? "replace" : input.append ? "append" : undefined,
      dateFormat: input.dateFormat,
    };
    if (custom) {
      return yield* pushToCustomSource(
        org.id,
        custom.paired,
        format === "json" ? { format: "rows", rows: yield* parseRows(text) } : { text, format },
        options,
      );
    }
    const rows = yield* parseRows(text);

    const path = "/costs/rows";
    const body = yield* api.json(org.id, path, {
      method: "POST",
      body: JSON.stringify({ source: name, rows }),
    });
    if (session.output === "json") return yield* Print.json(body);
    const result = yield* decodeBody(Schema.Struct({ written: Schema.Finite }), path)(body);
    yield* Print.line(
      `${c.green("✓")} pushed ${result.written} row${result.written === 1 ? "" : "s"}`,
    );
  }),
).pipe(
  Command.withDescription(
    "Push your own cost rows (--file or stdin), or upload a CSV/FOCUS file into a custom source",
  ),
);
