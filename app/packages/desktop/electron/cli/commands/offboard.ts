// `infrawrench offboard`; everything tied to someone who is leaving, across the
// org's connected providers and Infrawrench itself.
//
//   offboard                    every offboarding, with progress
//   offboard <email>            their checklist; without one, what a sweep would
//                               find (nothing is saved)
//   offboard <email> --start    start (or rejoin) their checklist
//   --alias <handle>            a name providers know them by (repeatable)
//
// Cloud only. The checklist's actions (revoke, remove a seat, remove from the
// org) are confirmed one row at a time in the app, where each shows what it
// will do; the CLI reads and starts. The response schemas are checked against
// `@infrawrench/client-core` by `wire`, and enums decode leniently with
// `knownOr`, so a kind or a status a newer server adds still renders.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  Offboarding,
  OffboardingListResponse,
  OffboardingPreview,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { knownOr, Unrecognized, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";

const PATH = "/offboardings";

const KINDS = [
  "member",
  "api-key",
  "ssh-key",
  "principal",
  "seat",
  "resource",
  "on-call",
  "on-call-cover",
  "lease",
  "jit-grant",
] as const;

const KIND_LABELS: Record<(typeof KINDS)[number], string> = {
  member: "membership",
  "api-key": "API key",
  "ssh-key": "SSH key",
  principal: "cloud access",
  seat: "seat",
  resource: "resource",
  "on-call": "rotation",
  "on-call-cover": "cover",
  lease: "lease",
  "jit-grant": "JIT grant",
};

const Progress = Schema.Struct({
  total: Schema.Finite,
  resolved: Schema.Finite,
  open: Schema.Finite,
  failed: Schema.Finite,
  unconfirmed: Schema.Finite,
});

const summaryFields = {
  id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  aliases: Schema.Array(Schema.String),
  status: knownOr(["open", "completed", "canceled"]),
  source: knownOr(["manual", "directory"]),
  createdAt: Schema.String,
  scanTruncated: Schema.Boolean,
  progress: Progress,
};

const Summary = Schema.Struct(summaryFields);
type Summary = typeof Summary.Type;

const Listing = wire<OffboardingListResponse>()(
  Schema.Struct({ offboardings: Schema.Array(Summary) }),
);

const Item = Schema.Struct({
  id: Schema.String,
  kind: knownOr(KINDS),
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  confidence: knownOr(["exact", "alias", "possible"]),
  matchReason: Schema.String,
  matchState: knownOr(["matched", "unconfirmed", "confirmed", "rejected"]),
  actions: Schema.Array(Schema.String),
  status: knownOr(["open", "done", "skipped", "failed", "gone"]),
  lastError: Schema.NullOr(Schema.String),
});
type Item = typeof Item.Type;

const Checklist = wire<Offboarding>()(
  Schema.Struct({ ...summaryFields, items: Schema.Array(Item) }),
);
type Checklist = typeof Checklist.Type;

const Started = Schema.Struct({ offboarding: Checklist, created: Schema.Boolean });

const Candidate = Schema.Struct({
  kind: knownOr(KINDS),
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  providerName: Schema.NullOr(Schema.String),
  accountName: Schema.NullOr(Schema.String),
  confidence: knownOr(["exact", "alias", "possible"]),
  matchReason: Schema.String,
  actions: Schema.Array(Schema.String),
});
type Candidate = typeof Candidate.Type;

const Preview = wire<OffboardingPreview>()(
  Schema.Struct({
    email: Schema.String,
    aliases: Schema.Array(Schema.String),
    candidates: Schema.Array(Candidate),
    scanTruncated: Schema.Boolean,
  }),
);

const raw = (value: string | Unrecognized): string =>
  value instanceof Unrecognized ? value.raw : value;

function kindText(kind: (typeof KINDS)[number] | Unrecognized): string {
  return kind instanceof Unrecognized ? safe(kind.raw) : KIND_LABELS[kind];
}

function whereText(row: { providerName: string | null; accountName: string | null }): string {
  return safe([row.providerName ?? "Infrawrench", row.accountName].filter(Boolean).join(" · "));
}

function matchText(row: { confidence: string | Unrecognized; matchState?: string | Unrecognized }) {
  const confidence = raw(row.confidence);
  if (confidence === "possible") {
    return raw(row.matchState ?? "") === "confirmed" ? "confirmed" : c.yellow("possible");
  }
  return confidence;
}

function statusText(status: Item["status"]): string {
  if (status instanceof Unrecognized) return safe(status.raw);
  switch (status) {
    case "open":
      return "open";
    case "done":
      return c.green("done");
    case "skipped":
      return c.dim("skipped");
    case "failed":
      return c.red("failed");
    case "gone":
      return c.dim("no longer found");
  }
}

function progressText(o: Summary): string {
  return `${o.progress.resolved}/${o.progress.total}${
    o.progress.failed > 0 ? c.red(` · ${o.progress.failed} failed`) : ""
  }${o.progress.unconfirmed > 0 ? c.yellow(` · ${o.progress.unconfirmed} to confirm`) : ""}`;
}

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliFailure({ message: "Offboarding runs in the cloud; drop --local." });
  }
});

const printChecklist = Effect.fnUntraced(function* (o: Checklist) {
  yield* Print.line(
    `${c.bold(safe(o.name ?? o.email))} ${c.dim(
      `· ${o.name ? `${safe(o.email)} · ` : ""}${raw(o.status)} · started ${o.createdAt.slice(0, 10)}`,
    )}  ${progressText(o)}`,
  );
  if (o.aliases.length > 0) yield* Print.line(c.dim(`aliases: ${safe(o.aliases.join(", "))}`));
  if (o.scanTruncated) {
    yield* Print.line(
      c.yellow("The last scan matched more resources than it reads at once; some may be missing."),
    );
  }
  yield* Print.line();
  const rows = o.items.filter((i) => raw(i.matchState) !== "rejected");
  if (rows.length === 0) return yield* Print.line(c.dim("Nothing found for this person."));
  const columns: Column<Item>[] = [
    { header: "kind", value: (i) => kindText(i.kind) },
    { header: "item", value: (i) => safe(i.title) },
    { header: "where", value: (i) => c.dim(whereText(i)) },
    { header: "match", value: (i) => matchText(i) },
    { header: "status", value: (i) => statusText(i.status) },
    { header: "actions", value: (i) => c.dim(safe(i.actions.join(", ") || "manual")) },
  ];
  yield* Print.table(rows, columns);
  const failed = rows.filter((i) => i.lastError && raw(i.status) === "failed");
  for (const i of failed) {
    yield* Print.line(c.red(`${safe(i.title)}: ${safe(i.lastError ?? "")}`));
  }
});

const list = Effect.fnUntraced(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);
  if (session.output === "json") return yield* Print.json({ org: org.id, ...(body as object) });
  const { offboardings } = yield* decodeBody(Listing, PATH)(body);
  if (offboardings.length === 0) {
    return yield* Print.line(
      c.dim("No offboardings yet. Start one with: infrawrench offboard <email> --start"),
    );
  }
  const columns: Column<Summary>[] = [
    { header: "person", value: (o) => safe(o.name ?? o.email) },
    { header: "email", value: (o) => c.dim(safe(o.email)) },
    { header: "status", value: (o) => raw(o.status) },
    { header: "progress", value: (o) => progressText(o) },
    { header: "started", value: (o) => o.createdAt.slice(0, 10) },
    { header: "source", value: (o) => c.dim(raw(o.source)) },
  ];
  yield* Print.table(offboardings, columns);
});

export const offboard = Command.make(
  "offboard",
  {
    email: Argument.String("email").pipe(
      Argument.withDescription("The email address the person signed in with"),
      Argument.optional,
    ),
    start: Flag.Boolean("start").pipe(
      Flag.withDescription("Start (or rejoin) their offboarding checklist"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    alias: Flag.String("alias").pipe(
      Flag.withMetavar("handle"),
      Flag.withDescription("A name providers know them by, such as a GitHub login (repeatable)"),
      Flag.atLeast(0),
    ),
  },
  Effect.fn("offboard")(function* (input) {
    yield* requireCloud;
    if (Option.isNone(input.email)) return yield* list();
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const email = input.email.value.trim().toLowerCase();
    const aliases = [...input.alias];

    if (input.start) {
      const body = yield* api.json(org.id, PATH, {
        method: "POST",
        body: JSON.stringify({ email, ...(aliases.length > 0 ? { aliases } : {}) }),
      });
      if (session.output === "json") return yield* Print.json({ org: org.id, ...(body as object) });
      const started = yield* decodeBody(Started, PATH)(body);
      if (!started.created) yield* Print.line(c.dim("Already being offboarded; rescanned."));
      return yield* printChecklist(started.offboarding);
    }

    // An existing checklist for them wins: the newest open one, else the newest.
    const { offboardings } = yield* api.decode(Listing, org.id, PATH);
    const mine = offboardings.filter((o) => o.email === email);
    const existing = mine.find((o) => raw(o.status) === "open") ?? mine[0];
    if (existing && aliases.length === 0) {
      const path = `${PATH}/${encodeURIComponent(existing.id)}`;
      const body = yield* api.json(org.id, path);
      if (session.output === "json") return yield* Print.json({ org: org.id, ...(body as object) });
      return yield* printChecklist(yield* decodeBody(Checklist, path)(body));
    }

    const previewPath = `${PATH}/preview`;
    const body = yield* api.json(org.id, previewPath, {
      method: "POST",
      body: JSON.stringify({ email, ...(aliases.length > 0 ? { aliases } : {}) }),
    });
    if (session.output === "json") {
      return yield* Print.json({ org: org.id, saved: false, ...(body as object) });
    }
    const preview = yield* decodeBody(Preview, previewPath)(body);
    yield* Print.line(
      `${c.bold(safe(preview.email))} ${c.dim(`· ${preview.candidates.length} found · not saved`)}`,
    );
    if (preview.scanTruncated) {
      yield* Print.line(
        c.yellow("The scan matched more resources than it reads at once; some may be missing."),
      );
    }
    yield* Print.line();
    if (preview.candidates.length === 0) {
      yield* Print.line(c.dim("Nothing found. Add the names providers know them by with --alias."));
    } else {
      const columns: Column<Candidate>[] = [
        { header: "kind", value: (i) => kindText(i.kind) },
        { header: "item", value: (i) => safe(i.title) },
        { header: "where", value: (i) => c.dim(whereText(i)) },
        { header: "match", value: (i) => matchText(i) },
        { header: "why", value: (i) => c.dim(safe(i.matchReason)) },
      ];
      yield* Print.table(preview.candidates, columns);
    }
    yield* Print.line();
    yield* Print.line(
      c.dim(
        `Save it as a checklist with: infrawrench offboard ${safe(preview.email)} --start${aliases
          .map((a) => ` --alias ${safe(a)}`)
          .join("")}`,
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Everything tied to someone who is leaving, across connected providers and Infrawrench",
  ),
);
