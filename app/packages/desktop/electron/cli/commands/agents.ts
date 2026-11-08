import type { AgentRegistration } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/agent-registrations";

const Registration = Schema.Struct({
  label: Schema.NullOr(Schema.String),
  prefix: Schema.NullOr(Schema.String),
  claimedAt: Schema.NullOr(Schema.String),
  claimedByEmail: Schema.NullOr(Schema.String),
  lastSeenAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  linkId: Schema.NullOr(Schema.String),
});
type Registration = typeof Registration.Type;

const Registrations = wire<AgentRegistration[]>()(Schema.Array(Registration));

function relative(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function statusCell(row: Registration): string {
  if (row.revokedAt) return c.red("revoked");
  // Made by a connected platform (Nibblets, ...) through an agent link.
  if (row.linkId) return c.cyan("platform");
  if (!row.claimedAt) return c.yellow("unclaimed");
  return c.green("claimed");
}

/**
 * `infrawrench agents`: the agent credentials that can reach this org.
 *
 * The same inventory the Agent Credentials settings page shows. Worth having
 * here for the same reason `hygiene` is: "what non-human things can touch our
 * cloud accounts" is a question that belongs in whatever the org already
 * reviews on a schedule, and nobody opens a settings page to check.
 */
export const agents = Command.make(
  "agents",
  {},
  Effect.fn("agents")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (session.output === "json") return yield* Print.json({ org: org.id, agents: body });
    const rows = yield* decodeBody(Registrations, PATH)(body);

    yield* Print.line(`${c.bold(org.displayName)} ${c.dim("· agent credentials")}`);
    yield* Print.line();

    if (rows.length === 0) {
      return yield* Print.line(c.dim("No agents have registered against this organization."));
    }

    const columns: Column<Registration>[] = [
      { header: "NAME", value: (r) => r.label ?? c.dim("unnamed") },
      { header: "STATUS", value: statusCell },
      { header: "CREDENTIAL", value: (r) => (r.prefix ? `${r.prefix}…` : c.dim("external")) },
      { header: "CLAIMED BY", value: (r) => r.claimedByEmail ?? c.dim("—") },
      { header: "LAST USED", value: (r) => relative(r.lastSeenAt) },
    ];
    yield* Print.table(rows, columns);

    const unclaimed = rows.filter((r) => !r.claimedAt && !r.revokedAt).length;
    if (unclaimed > 0) {
      yield* Print.line();
      yield* Print.line(
        c.yellow(
          `${unclaimed} unclaimed. Their workspaces are deleted 24 hours after they were created.`,
        ),
      );
    }
  }),
).pipe(Command.withDescription("Agent credentials that can reach this org"));
