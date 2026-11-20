// `infrawrench migrate-estimate`: what a service (or a set of resources)
// would cost on another provider.
//
// Each resource is matched to the target provider's type of the same
// category, sized at least as large as it is today, and priced from the
// target's published list prices beside what it costs now (billed spend when
// the cost data has it, else the plugin's estimate). Resources with no
// equivalent are listed apart with the reason. Unknown figures print as
// "unknown", never as zero.
//
// Cloud-only. It runs through the same `/migration-estimates/preview` route
// the app's Migration estimates tab uses, so the numbers agree; `--save`
// stores the estimate so it opens in the app.
import type { MigrationEstimateResult, ServiceListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { knownOr, spreadBody, Unrecognized, wire } from "../effect/wire";
import { matchService } from "../format";
import { c, safe, type Column } from "../output";

const PREVIEW_PATH = "/migration-estimates/preview";
const SAVE_PATH = "/migration-estimates";
const SERVICES_PATH = "/services";

const Basis = knownOr(["billed", "estimate", "list-price"]);

const Cost = Schema.NullOr(
  Schema.Struct({
    amount: Schema.Finite,
    currency: Schema.String,
    basis: Basis,
    partial: Schema.Boolean,
  }),
);
type Cost = typeof Cost.Type;

const Money = Schema.Struct({ amount: Schema.Finite, currency: Schema.String });

// Category, note and reason stay strings: the server may add values, and the
// text output prints what it does not know as sent.
const Result = wire<MigrationEstimateResult>()(
  Schema.Struct({
    name: Schema.String,
    source: Schema.Struct({ label: Schema.String, resourceCount: Schema.Finite }),
    target: Schema.Struct({ pluginId: Schema.String, pluginName: Schema.String }),
    region: Schema.Struct({
      region: Schema.NullOr(Schema.String),
      regionLabel: Schema.NullOr(Schema.String),
      area: Schema.NullOr(Schema.String),
      choice: Schema.String,
      crossesArea: Schema.NullOr(Schema.Boolean),
    }),
    rows: Schema.Array(
      Schema.Struct({
        resourceId: Schema.String,
        displayName: Schema.String,
        pluginName: Schema.String,
        category: Schema.String,
        instanceType: Schema.NullOr(Schema.String),
        specs: Schema.Struct({
          vcpus: Schema.NullOr(Schema.Finite),
          memoryGb: Schema.NullOr(Schema.Finite),
          count: Schema.Finite,
        }),
        current: Cost,
        target: Schema.Struct({
          resourceTypeName: Schema.String,
          sizeLabel: Schema.NullOr(Schema.String),
          cost: Cost,
        }),
        note: Schema.NullOr(Schema.String),
      }),
    ),
    unmatched: Schema.Array(
      Schema.Struct({
        displayName: Schema.String,
        pluginName: Schema.String,
        resourceTypeName: Schema.String,
        reason: Schema.String,
        category: Schema.NullOr(Schema.String),
      }),
    ),
    totals: Schema.Struct({
      current: Schema.Array(Money),
      target: Schema.Array(Money),
      currentUnknown: Schema.Finite,
      targetUnknown: Schema.Finite,
      comparable: Schema.NullOr(
        Schema.Struct({
          currency: Schema.String,
          current: Schema.Finite,
          target: Schema.Finite,
          pairedDelta: Schema.Finite,
          pairedRows: Schema.Finite,
        }),
      ),
    }),
    terraform: Schema.Boolean,
    truncated: Schema.Boolean,
  }),
);
type Row = (typeof Result.Type)["rows"][number];

const Services = wire<ServiceListResponse>()(
  Schema.Struct({
    services: Schema.Array(
      Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
    ),
  }),
);

const Saved = Schema.Struct({ id: Schema.String, name: Schema.String });

const NOTES: Record<string, string> = {
  "no-account": "needs an account on the target provider",
  "source-size-unknown": "source size unknown",
  "no-size-match": "no size meets the source",
  "no-price": "no published price",
  "catalog-unavailable": "price list unavailable, run again shortly",
};
const REASONS: Record<string, string> = {
  "no-category": "no cross-provider equivalent",
  "no-target-type": "the target has no equivalent type",
};

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function costText(cost: Cost): string {
  if (!cost) return c.dim("unknown");
  const basis = cost.basis instanceof Unrecognized ? safe(cost.basis.raw) : cost.basis;
  return `${cost.partial ? "≥" : ""}${money(cost.amount, cost.currency)} ${c.dim(basis)}`;
}

function specsText(row: Row): string {
  const parts: string[] = [];
  if (row.instanceType) parts.push(safe(row.instanceType));
  if (row.specs.vcpus !== null) parts.push(`${row.specs.vcpus} vCPU`);
  if (row.specs.memoryGb !== null) parts.push(`${row.specs.memoryGb} GB`);
  if (row.specs.count > 1) parts.push(`×${row.specs.count}`);
  return parts.join(" ");
}

const optionalString = (name: string, metavar: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withMetavar(metavar),
    Flag.withDescription(description),
    Flag.optional,
  );

const USAGE =
  "Usage: infrawrench migrate-estimate --service <id|slug|name> --to <provider> [--region <id>] [--save [name]] [--json]\n" +
  "       infrawrench migrate-estimate --resources <id,id,...> --to <provider> [...]";

export const migrateEstimate = Command.make(
  "migrate-estimate",
  {
    service: optionalString("service", "id|slug|name", "The service whose members to price"),
    resources: optionalString("resources", "id[,id]", "Resource ids to price instead of a service"),
    to: optionalString("to", "plugin", "The provider to price on, as a plugin id (hetzner, gcp)"),
    region: optionalString(
      "region",
      "id",
      "A region of the target provider (default: the one nearest the resources)",
    ),
    save: optionalString(
      "save",
      "name",
      "Save the estimate under this name so it opens in the app",
    ),
  },
  Effect.fn("migrateEstimate")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (session.local) {
      return yield* new CliFailure({
        message: "`migrate-estimate` is cloud-only. Drop --local, or pass --org <id|name>.",
      });
    }
    const to = Option.getOrUndefined(input.to)?.trim();
    const serviceQuery = Option.getOrUndefined(input.service)?.trim();
    const resourceList = Option.getOrUndefined(input.resources)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!to || (!serviceQuery && !resourceList?.length) || (serviceQuery && resourceList?.length)) {
      return yield* new CliUsageError({ message: USAGE });
    }
    const org = yield* currentOrg;

    let source:
      { kind: "service"; serviceId: string } | { kind: "resources"; resourceIds: string[] };
    let label: string;
    if (serviceQuery) {
      const { services } = yield* api.decode(Services, org.id, SERVICES_PATH);
      const found = matchService(services, serviceQuery);
      if (!found.match) {
        return yield* new CliFailure({
          message:
            found.candidates.length > 1
              ? `"${serviceQuery}" matches ${found.candidates.length} services: ${found.candidates
                  .map((s) => safe(s.slug))
                  .join(", ")}. Use the slug.`
              : `No service matches "${serviceQuery}". Run \`infrawrench services\` to list.`,
        });
      }
      source = { kind: "service", serviceId: found.match.id };
      label = found.match.name;
    } else {
      source = { kind: "resources", resourceIds: resourceList! };
      label = `${resourceList!.length} resources`;
    }

    const region = Option.getOrUndefined(input.region)?.trim() || null;
    const saveName = Option.getOrUndefined(input.save)?.trim();
    const estimateInput = {
      name: saveName || `${label} on ${to}`,
      source,
      targetPluginId: to,
      targetRegion: region,
      overrides: {},
    };

    let savedId: string | null = null;
    if (saveName !== undefined) {
      const saved = yield* api.decode(Saved, org.id, SAVE_PATH, {
        method: "POST",
        body: JSON.stringify(estimateInput),
      });
      savedId = saved.id;
    }
    const path = savedId ? `${SAVE_PATH}/${encodeURIComponent(savedId)}/result` : PREVIEW_PATH;
    const body = yield* api.json(
      org.id,
      path,
      savedId ? undefined : { method: "POST", body: JSON.stringify(estimateInput) },
    );

    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id, savedId }, body, path));
    }
    const res = yield* decodeBody(Result, path)(body);
    const where = res.region.regionLabel ?? res.region.region;
    yield* Print.line(
      `${c.bold(safe(res.source.label))} ${c.dim("on")} ${c.bold(safe(res.target.pluginName))}${
        where
          ? c.dim(` · ${safe(where)}${res.region.choice === "nearest" ? " (nearest)" : ""}`)
          : ""
      }`,
    );
    if (res.region.crossesArea) {
      yield* Print.line(
        c.yellow(
          "! Some resources run in another part of the world; latency to their users will change.",
        ),
      );
    }
    yield* Print.line();

    if (res.rows.length > 0) {
      const columns: Column<Row>[] = [
        { header: "resource", value: (r) => safe(r.displayName) },
        { header: "provider", value: (r) => c.dim(safe(r.pluginName)) },
        { header: "today", value: (r) => specsText(r) },
        { header: "cost now", value: (r) => costText(r.current), align: "right" },
        {
          header: `on ${res.target.pluginName}`,
          value: (r) =>
            r.target.sizeLabel ? safe(r.target.sizeLabel) : c.dim(safe(r.target.resourceTypeName)),
        },
        {
          header: "estimate",
          value: (r) =>
            r.target.cost
              ? costText(r.target.cost)
              : c.dim(r.note ? (NOTES[r.note] ?? safe(r.note)) : "unknown"),
          align: "right",
        },
      ];
      yield* Print.table(res.rows, columns);
      yield* Print.line();
    }

    const t = res.totals;
    if (t.comparable) {
      const delta = t.comparable.pairedDelta;
      yield* Print.keyValues([
        ["today", money(t.comparable.current, t.comparable.currency)],
        [`on ${safe(res.target.pluginName)}`, money(t.comparable.target, t.comparable.currency)],
        [
          "change",
          t.comparable.pairedRows > 0
            ? `${delta > 0 ? c.red("+") : delta < 0 ? c.green("-") : ""}${money(
                Math.abs(delta),
                t.comparable.currency,
              )}/month ${c.dim(`over ${t.comparable.pairedRows} resource(s) priced on both sides`)}`
            : c.dim("no resource priced on both sides"),
        ],
      ]);
    } else {
      yield* Print.keyValues([
        ["today", t.current.map((m) => money(m.amount, m.currency)).join(" + ") || "unknown"],
        [
          `on ${safe(res.target.pluginName)}`,
          t.target.map((m) => money(m.amount, m.currency)).join(" + ") || "unknown",
        ],
      ]);
      yield* Print.line(
        c.yellow(
          "! Mixed currencies: set a display currency and exchange rates to compare in one.",
        ),
      );
    }
    if (t.currentUnknown > 0 || t.targetUnknown > 0) {
      yield* Print.line(
        c.dim(
          `  not priced: ${t.currentUnknown} today, ${t.targetUnknown} on ${safe(res.target.pluginName)}`,
        ),
      );
    }

    if (res.unmatched.length > 0) {
      yield* Print.line();
      yield* Print.line(c.bold(`No equivalent on ${safe(res.target.pluginName)}`));
      for (const u of res.unmatched) {
        yield* Print.line(
          `  ${safe(u.displayName)} ${c.dim(`${safe(u.pluginName)} ${safe(u.resourceTypeName)}`)}  ${c.dim(
            REASONS[u.reason] ?? safe(u.reason),
          )}`,
        );
      }
    }
    if (res.truncated) {
      yield* Print.line(c.yellow("! Only the first 500 resources were estimated."));
    }
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Target prices are published list prices; your discounts are not applied." +
          (res.terraform ? " Terraform for the target: open the estimate in the app." : ""),
      ),
    );
    if (savedId) yield* Print.line(c.dim(`Saved as ${safe(res.name)} (${savedId}).`));
  }),
).pipe(
  Command.withDescription(
    "What a service or a set of resources would cost on another provider, side by side (cloud only)",
  ),
);
