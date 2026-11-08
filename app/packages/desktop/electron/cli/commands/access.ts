import type { AccessRequest } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, type Column } from "../output";

const AccessRow = Schema.Struct({
  userName: Schema.NullOr(Schema.String),
  permissions: Schema.Array(Schema.String),
  reason: Schema.String,
  durationMinutes: Schema.Finite,
  status: Schema.Literals(["pending", "approved", "denied", "expired"]),
  expiresAt: Schema.String,
  grantExpiresAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
});
type AccessRow = typeof AccessRow.Type;

const Requests = wire<AccessRequest[]>()(Schema.Array(AccessRow));

/** "45m" / "2h": kept local so the CLI pulls nothing UI-shaped. */
function duration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** "in 24m" / "24m ago": the countdown cell. */
function countdown(at: string | null): string {
  if (!at) return c.dim("—");
  const ms = Date.parse(at) - Date.now();
  if (Number.isNaN(ms)) return c.dim("—");
  const abs = Math.abs(ms);
  const label =
    abs >= 86_400_000
      ? `${Math.round(abs / 86_400_000)}d`
      : abs >= 3_600_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.max(1, Math.round(abs / 60_000))}m`;
  return ms >= 0 ? `in ${label}` : c.dim(`${label} ago`);
}

function statusCell(request: AccessRow): string {
  if (request.active) return c.yellow("LIVE");
  switch (request.status) {
    case "pending":
      return c.cyan("waiting");
    case "approved":
      return c.dim(request.revokedAt ? "ended early" : "lapsed");
    case "denied":
      return c.red("denied");
    case "expired":
      return c.dim("expired");
  }
}

/**
 * `infrawrench access`: break-glass requests and live elevations.
 *
 * Read-only by design. Raising a request needs a reason someone will read and
 * a permission picker that cannot drift from the server's catalog, and both of
 * those belong on a screen; deciding one is a judgement call that should
 * involve looking at what is being asked for. What the CLI is genuinely good
 * at is the question an on-call engineer actually types at 3am ("who is
 * elevated right now") so that is what it answers.
 */
const listRequests = Effect.fn("access.list")(function* (activeOnly: boolean) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const path = `/access-requests${activeOnly ? "?active=1" : ""}`;
  const body = yield* api.json(org.id, path);

  if (session.output === "json") return yield* Print.json({ org: org.id, requests: body });
  const requests = yield* decodeBody(Requests, path)(body);

  if (requests.length === 0) {
    return yield* Print.line(
      c.dim(
        activeOnly
          ? "Nobody is holding elevated access right now."
          : "No break-glass requests. Ask for one from Settings → Break-glass Access.",
      ),
    );
  }

  const live = requests.filter((r) => r.active).length;
  const waiting = requests.filter((r) => r.status === "pending").length;
  yield* Print.line(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${live} live elevation${live === 1 ? "" : "s"}, ${waiting} waiting for a decision`,
    )}`,
  );
  yield* Print.line();

  const columns: Column<AccessRow>[] = [
    { header: "who", value: (r) => r.userName ?? c.dim("unknown") },
    { header: "permissions", value: (r) => r.permissions.join(", ") },
    { header: "for", value: (r) => duration(r.durationMinutes) },
    { header: "status", value: (r) => statusCell(r) },
    {
      header: "clock",
      value: (r) =>
        countdown(r.active ? r.grantExpiresAt : r.status === "pending" ? r.expiresAt : null),
    },
    { header: "reason", value: (r) => c.dim(r.reason) },
  ];
  yield* Print.table(requests, columns);

  if (live > 0) {
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Live elevations lapse on their own. End one early from Settings → Break-glass Access.",
      ),
    );
  }
});

export const access = Command.make("access", {}, () => listRequests(false)).pipe(
  Command.withDescription("Break-glass requests and live permission elevations (bare: list)"),
  Command.withSubcommands([
    Command.make("list", {}, () => listRequests(false)).pipe(
      Command.withDescription("Every break-glass request and live elevation"),
    ),
    Command.make("active", {}, () => listRequests(true)).pipe(
      Command.withDescription("Only the elevations in force right now"),
    ),
  ]),
);
