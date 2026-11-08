// `infrawrench dns`: every DNS zone and record across your providers, with
// each record's target judged against the rest of the workspace. Dangling
// targets (a name pointing into a provider namespace you manage that nothing
// synced claims) print first and in red: that is the subdomain-takeover
// signature.
//
// Works in both modes, because the classification is declarative and runs
// over stored state rather than a live provider call, and it resolves no DNS
// in either mode:
//   - cloud (default): GET /dns, the same endpoint the web + desktop Domains
//     screens render.
//   - --local: electron/local-dns.ts runs the shared computation over this
//     machine's SQLite workspace. No credentials, no network.
//
// The response shape comes from `@infrawrench/client-core` (the same
// definition every other surface uses) so a server-side change breaks the
// CLI's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { Effect, Schema } from "effect";
import { Command } from "effect/cli";
import { listLocalDns } from "../../local-dns";
import type { DnsInventoryResponse, DnsTargetClassification } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { spreadBody, wire } from "../effect/wire";
import { c, type Column } from "../output";

const PATH = "/dns";

// `status` stays a string: a classification from a newer server renders
// uncolored rather than failing the whole listing.
const Inventory = wire<DnsInventoryResponse>()(
  Schema.Struct({
    zones: Schema.Array(
      Schema.Struct({
        domain: Schema.String,
        pluginName: Schema.String,
        accountName: Schema.String,
        isPrivate: Schema.Boolean,
        recordCount: Schema.Finite,
        providerRecordCount: Schema.NullOr(Schema.Finite),
        danglingCount: Schema.Finite,
      }),
    ),
    records: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        type: Schema.String,
        pluginName: Schema.String,
        status: Schema.String,
        targets: Schema.Array(
          Schema.Struct({
            value: Schema.String,
            service: Schema.NullOr(
              Schema.Struct({
                label: Schema.String,
                claimLabel: Schema.String,
                reason: Schema.String,
              }),
            ),
          }),
        ),
      }),
    ),
    counts: Schema.Struct({
      zones: Schema.Finite,
      records: Schema.Finite,
      owned: Schema.Finite,
      dangling: Schema.Finite,
      external: Schema.Finite,
      notAnalysed: Schema.Finite,
    }),
    skippedNamespaces: Schema.Array(Schema.Struct({ label: Schema.String, reason: Schema.String })),
  }),
);
type Inventory = typeof Inventory.Type;
type ZoneEntry = Inventory["zones"][number];
type RecordEntry = Inventory["records"][number];

type Tone = (s: string) => string;

/** Terminal tone per bucket: red = takeover risk, green = resolves here, dim = nothing to say. */
const STATUS_COLOR: Partial<Record<string, Tone>> = {
  dangling: c.red,
  owned: c.green,
  external: (s) => s,
  "not-analysed": c.dim,
} satisfies Record<DnsTargetClassification, Tone>;

const STATUS_LABEL: Partial<Record<string, string>> = {
  dangling: "dangling",
  owned: "internal",
  external: "external",
  "not-analysed": "—",
} satisfies Record<DnsTargetClassification, string>;

/** The header's tally, e.g. "2 dangling · 31 internal · 12 external". */
function countsSummary(response: Inventory): string {
  const { counts } = response;
  const parts: string[] = [];
  if (counts.dangling > 0) parts.push(c.red(`${counts.dangling} dangling`));
  if (counts.owned > 0) parts.push(c.green(`${counts.owned} internal`));
  if (counts.external > 0) parts.push(`${counts.external} external`);
  if (counts.notAnalysed > 0) parts.push(c.dim(`${counts.notAnalysed} not analysed`));
  return parts.join(c.dim(" · "));
}

/** All of a record's targets on one line; the table has no room for more. */
function targetsCell(record: RecordEntry): string {
  if (record.targets.length === 0) return c.dim("—");
  return record.targets.map((t) => t.value).join(", ");
}

/** The inventory in scope: the local workspace, or the `--org` org's. */
const loadInventory = Effect.fn("dns.load")(function* () {
  const session = yield* CliSession;
  if (session.local) {
    const response = yield* Effect.promise(listLocalDns);
    return { label: "Local workspace", json: { ...response }, response };
  }
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const body = yield* api.json(org.id, PATH);
  return {
    label: org.displayName,
    json: yield* spreadBody({ org: org.id }, body, PATH),
    response: yield* decodeBody(Inventory, PATH)(body),
  };
});

export const dns = Command.make(
  "dns",
  {},
  Effect.fn("dns")(function* () {
    const session = yield* CliSession;
    const scope = yield* loadInventory();
    const { response } = scope;

    if (session.output === "json") return yield* Print.json(scope.json);

    if (response.zones.length === 0 && response.records.length === 0) {
      yield* Print.line(
        c.dim(
          "No DNS zones synced. Connect an account on a provider that manages DNS (Cloudflare, Route 53, Cloud DNS, DigitalOcean, Netlify, Azure DNS or Vercel).",
        ),
      );
      if (session.local) {
        yield* Print.line(
          c.dim("This scan covered the local workspace only; drop --local for your organization."),
        );
      }
      return;
    }

    yield* Print.line(
      `${c.bold(scope.label)} ${c.dim(
        `· ${response.counts.zones} zone${response.counts.zones === 1 ? "" : "s"}, ` +
          `${response.counts.records} record${response.counts.records === 1 ? "" : "s"}`,
      )}  ${countsSummary(response)}`,
    );
    yield* Print.line();

    if (response.zones.length > 0) {
      const zoneColumns: Column<ZoneEntry>[] = [
        {
          header: "domain",
          value: (z) => (z.isPrivate ? c.dim(`${z.domain} (private)`) : z.domain),
        },
        { header: "provider", value: (z) => c.dim(z.pluginName) },
        { header: "account", value: (z) => c.dim(z.accountName) },
        {
          header: "records",
          value: (z) =>
            z.providerRecordCount !== null && z.providerRecordCount !== z.recordCount
              ? `${z.recordCount} ${c.dim(`(${z.providerRecordCount} reported)`)}`
              : String(z.recordCount),
        },
        {
          header: "dangling",
          value: (z) => (z.danglingCount > 0 ? c.red(String(z.danglingCount)) : c.dim("0")),
        },
      ];
      yield* Print.table(response.zones, zoneColumns);
      yield* Print.line();
    }

    if (response.records.length > 0) {
      // The contract serves records worst-status first; the table keeps that order.
      const recordColumns: Column<RecordEntry>[] = [
        {
          header: "status",
          // Unknown classifications from a newer server render uncolored rather
          // than crashing the whole listing.
          value: (r) =>
            (STATUS_COLOR[r.status] ?? ((s: string) => s))(STATUS_LABEL[r.status] ?? r.status),
        },
        { header: "type", value: (r) => r.type },
        { header: "name", value: (r) => r.name },
        { header: "target", value: targetsCell },
        { header: "provider", value: (r) => c.dim(r.pluginName) },
      ];
      yield* Print.table(response.records, recordColumns);
      yield* Print.line();
    }

    for (const record of response.records) {
      for (const target of record.targets) {
        if (!target.service) continue;
        yield* Print.line(
          `${c.red("dangling")} ${c.bold(`${record.type} ${record.name}`)} → ${target.value}\n` +
            `  ${target.service.label}. Nothing synced claims "${target.service.claimLabel}". ${target.service.reason}`,
        );
      }
    }

    if (response.skippedNamespaces.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold("Not checked"));
      for (const entry of response.skippedNamespaces) {
        yield* Print.line(c.dim(`  ${entry.label}, ${entry.reason}`));
      }
    }

    yield* Print.line();
    yield* Print.line(
      c.dim("Computed from synced state; no provider was contacted and no DNS was resolved."),
    );
  }),
).pipe(
  Command.withDescription(
    "Every DNS zone and record across your providers, with dangling targets flagged",
  ),
);
