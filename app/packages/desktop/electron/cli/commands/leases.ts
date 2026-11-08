import type { ResourceLeaseListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/leases";

const LeaseList = wire<ResourceLeaseListResponse>()(
  Schema.Struct({
    leases: Schema.Array(
      Schema.Struct({
        resourceName: Schema.String,
        accountName: Schema.String,
        expiresAt: Schema.String,
        autoDelete: Schema.Boolean,
        note: Schema.NullOr(Schema.String),
        status: Schema.Literals(["active", "deleted", "failed", "canceled"]),
        firstWarningAt: Schema.NullOr(Schema.String),
        finalWarningAt: Schema.NullOr(Schema.String),
        lastError: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
type Lease = (typeof LeaseList.Type)["leases"][number];

/** "in 3d" / "in 5h" / "2d overdue": the lease countdown cell. */
function expiresSummary(lease: Lease): string {
  const ms = Date.parse(lease.expiresAt) - Date.now();
  const abs = Math.abs(ms);
  const label =
    abs >= 86_400_000
      ? `${Math.round(abs / 86_400_000)}d`
      : abs >= 3_600_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.max(1, Math.round(abs / 60_000))}m`;
  const when = lease.expiresAt.replace("T", " ").slice(0, 16);
  if (lease.status !== "active") return c.dim(`${when}Z`);
  return ms >= 0 ? `in ${label} (${when}Z)` : c.red(`${label} overdue (${when}Z)`);
}

function statusSummary(lease: Lease): string {
  switch (lease.status) {
    case "active":
      if (lease.autoDelete && lease.finalWarningAt) return c.yellow("final warning sent");
      if (lease.autoDelete && lease.firstWarningAt) return c.yellow("first warning sent");
      return c.green("active");
    case "deleted":
      return c.dim("deleted");
    case "canceled":
      return c.dim("canceled");
    case "failed":
      return c.red(`failed${lease.lastError ? `: ${lease.lastError}` : ""}`);
  }
}

/**
 * `infrawrench leases`; every resource lease in the org: deadline,
 * auto-delete flag and status. (The `expiring` command already shows lease
 * deadlines inside the expiry radar; this is the lease-management view.)
 */
export const leases = Command.make(
  "leases",
  {},
  Effect.fn("leases")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, PATH);

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, PATH));
    }
    const response = yield* decodeBody(LeaseList, PATH)(body);

    if (response.leases.length === 0) {
      return yield* Print.line(
        c.dim(
          "No resource leases. Set one from a resource's Lease tab (web or desktop) to put an expiry on it, optionally auto-deleting it when the lease runs out.",
        ),
      );
    }

    const active = response.leases.filter((l) => l.status === "active").length;
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(
        `· ${response.leases.length} lease${response.leases.length === 1 ? "" : "s"} (${active} active)`,
      )}`,
    );
    yield* Print.line();

    const columns: Column<Lease>[] = [
      { header: "resource", value: (l) => l.resourceName },
      { header: "account", value: (l) => c.dim(l.accountName) },
      { header: "expires", value: (l) => expiresSummary(l) },
      { header: "auto-delete", value: (l) => (l.autoDelete ? c.red("yes") : c.dim("no")) },
      { header: "status", value: (l) => statusSummary(l) },
      { header: "note", value: (l) => (l.note ? c.dim(l.note) : c.dim("—")) },
    ];
    yield* Print.table(response.leases, columns);
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Active leases also appear in `infrawrench expiring`. Auto-deletes are announced twice before they fire and pause during change freezes.",
      ),
    );
  }),
).pipe(Command.withDescription("Resource leases (TTLs): deadlines, auto-delete flags and status"));
