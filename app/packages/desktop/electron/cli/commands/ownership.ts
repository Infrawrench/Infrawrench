// `infrawrench ownership`: who owns each resource, what it is for, and the
// ticket that authorized it.
//
// Cloud-only: ownership names an org member, and a local workspace has neither
// an org nor members. The CLI lists; setting an owner lives on the resource
// detail view's Ownership tab, where the owner is a picker over real members
// rather than a string you can typo.
//
// The listing is sorted so the *un*claimed resources are what you see first
// when you pass a query: "who owns this?" is usually asked because nobody
// seems to.
//
// The response shapes come from `@infrawrench/client-core` (the same
// definitions every other surface renders) so a server-side change breaks the
// CLI's build instead of its output. The imports are type-only, so the CLI
// still ships zero new runtime dependencies.
import type { ResourceOwnershipListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/ownership";

const OwnershipList = wire<ResourceOwnershipListResponse>()(
  Schema.Struct({
    ownership: Schema.Array(
      Schema.Struct({
        resourceId: Schema.String,
        resourceName: Schema.String,
        ownerUserId: Schema.NullOr(Schema.String),
        ownerName: Schema.NullOr(Schema.String),
        ownerEmail: Schema.NullOr(Schema.String),
        ownerLabel: Schema.NullOr(Schema.String),
        purpose: Schema.NullOr(Schema.String),
        ticketUrl: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
type Ownership = (typeof OwnershipList.Type)["ownership"][number];

/** The same list with each record as the server sent it, for `--json`. */
const RawOwnershipList = Schema.Struct({ ownership: Schema.Array(Schema.Unknown) });

function matches(record: Ownership, needle: string): boolean {
  return (
    record.resourceName.toLowerCase().includes(needle) ||
    record.resourceId.toLowerCase().includes(needle) ||
    (record.ownerName?.toLowerCase().includes(needle) ?? false) ||
    (record.ownerEmail?.toLowerCase().includes(needle) ?? false) ||
    (record.ownerLabel?.toLowerCase().includes(needle) ?? false) ||
    (record.purpose?.toLowerCase().includes(needle) ?? false)
  );
}

function ownerCell(record: Ownership): string {
  const member = record.ownerName ?? record.ownerEmail;
  if (record.ownerUserId && member) return member;
  // A free-text owner is marked, because the difference that matters is
  // whether an alert can reach it, not how it reads.
  if (record.ownerLabel) return `${record.ownerLabel} ${c.dim("(team)")}`;
  return c.dim("unowned");
}

export const ownership = Command.make(
  "ownership",
  {
    query: Argument.String("query").pipe(
      Argument.withDescription("Only resources whose name, id, owner or purpose contains this"),
      Argument.optional,
    ),
  },
  Effect.fn("ownership")(function* (input) {
    const session = yield* CliSession;
    if (session.local) {
      return yield* new CliFailure({
        message: "Ownership lives in Infrawrench Cloud. It names an org member. Drop --local.",
      });
    }
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const query = Option.getOrUndefined(input.query);
    const body = yield* api.json(org.id, PATH);
    // The filter reads the records even under --json, so the body is decoded
    // first; the rows `--json` prints are the server's own, every field kept.
    const { ownership: records } = yield* decodeBody(OwnershipList, PATH)(body);
    const raw = yield* decodeBody(RawOwnershipList, PATH)(body);

    const needle = query?.toLowerCase();
    const kept = records.map((record) => needle === undefined || matches(record, needle));
    const rows = records.filter((_, i) => kept[i]);

    if (session.output === "json") {
      return yield* Print.json({ org: org.id, ownership: raw.ownership.filter((_, i) => kept[i]) });
    }

    if (rows.length === 0) {
      return yield* Print.line(
        c.dim(
          query
            ? `Nothing recorded matches "${query}".`
            : "No ownership recorded yet. Set an owner from a resource's Ownership tab. The orphan finder will then name them against anything it flags.",
        ),
      );
    }

    const columns: Column<Ownership>[] = [
      { header: "resource", value: (r) => r.resourceName },
      { header: "owner", value: ownerCell },
      { header: "purpose", value: (r) => r.purpose ?? c.dim("—") },
      { header: "ticket", value: (r) => c.dim(r.ticketUrl ?? "—") },
    ];

    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(`· ${rows.length} resource${rows.length === 1 ? "" : "s"} with ownership recorded`)}`,
    );
    yield* Print.line();
    yield* Print.table(rows, columns);

    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Only resources with something recorded appear here. Everything else is unowned. " +
          "Run `infrawrench orphans` to see the unowned resources that also look wasted.",
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Who owns each resource, what it's for and its ticket (give a query to filter)",
  ),
);
