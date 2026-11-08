// `infrawrench estimate <resource>`: what a resource costs per month at
// the provider's list price, itemized.
//
// The counterpart to `infrawrench costs`, and deliberately a separate command
// rather than a flag on it: `costs` reports what was billed for days that
// already happened, this projects a run-rate forward from the resource's
// current shape. Conflating the two under one name is how a $0 "no spend yet"
// gets mistaken for a $0 bill.
//
// Cloud-only. Estimation runs through the same `/resources/cost-estimate`
// route the app's create form, edit modal and detail page use, so the number
// here is the number they show. Local mode has no equivalent because the CLI
// does not instantiate plugin clients for this path.
//
// The argument may be the compound `{accountId}:{typeId}:{externalId}` id, or
// a display name / external id when `--account` (and usually `--org`) scopes
// the lookup: same friendly resolution accounts get via `findAccount`.
import type { CostEstimate } from "@infrawrench/plugin-base" with { "resolution-mode": "import" };
import type { ResourceCarbonEstimate } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import { cloudAccounts, cloudResources, findAccount, type ResourceRow } from "../context";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, formatCo2e } from "../output";

const PATH = "/resources/cost-estimate";

// `reason` and `role` stay strings: the renderer falls back on both.
const EstimateResponse = wire<{
  estimate: CostEstimate | null;
  carbon?: ResourceCarbonEstimate | null;
}>()(
  Schema.Struct({
    estimate: Schema.NullOr(
      Schema.Struct({
        monthlyAmount: Schema.Finite,
        currency: Schema.String,
        lineItems: Schema.Array(
          Schema.Struct({
            label: Schema.String,
            monthlyAmount: Schema.Finite,
            detail: Schema.optional(Schema.String),
          }),
        ),
        partial: Schema.optional(Schema.Boolean),
        notes: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    carbon: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          estimate: Schema.NullOr(
            Schema.Struct({
              vcpus: Schema.Finite,
              count: Schema.Finite,
              gridZone: Schema.String,
              gridIntensity: Schema.Finite,
              pue: Schema.Finite,
              kgCo2e: Schema.Finite,
            }),
          ),
          reason: Schema.NullOr(Schema.String),
          inScope: Schema.Boolean,
          role: Schema.String,
        }),
      ),
    ),
  }),
);
type Carbon = NonNullable<(typeof EstimateResponse.Type)["carbon"]>;

/** The two values `--json` prints, left as the server sent them. */
const RawEstimateResponse = Schema.Struct({
  estimate: Schema.optional(Schema.Unknown),
  carbon: Schema.optional(Schema.Unknown),
});

/** `{accountId}:{typeId}:{externalId}`: the id shape every surface uses. */
function isCompoundResourceId(value: string): boolean {
  // accountId and typeId never contain colons; externalId may. Need at least
  // two separators so a bare name is never mistaken for an id.
  const first = value.indexOf(":");
  if (first <= 0) return false;
  const second = value.indexOf(":", first + 1);
  return second > first + 1 && second < value.length - 1;
}

const splitResourceId = Effect.fnUntraced(function* (resourceId: string) {
  const [accountId, resourceTypeId] = resourceId.split(":");
  if (!accountId || !resourceTypeId) {
    return yield* new CliFailure({
      message: `"${resourceId}" is not a resource id. Expected {accountId}:{typeId}:{externalId}, or a name with --account. See \`infrawrench resources\`.`,
    });
  }
  return { accountId, resourceTypeId };
});

/**
 * Resolve a display name / external id / full id against an account's cloud
 * resources. Ambiguous names fail loud rather than estimate the wrong row.
 */
const matchResource = Effect.fnUntraced(function* (rows: ResourceRow[], wanted: string) {
  const byId = rows.find((r) => r.id === wanted);
  if (byId) return byId;
  const needle = wanted.toLowerCase();
  const exact = rows.filter(
    (r) =>
      r.displayName.toLowerCase() === needle ||
      (r.externalId !== "" && r.externalId.toLowerCase() === needle),
  );
  const [onlyExact] = exact;
  if (onlyExact && exact.length === 1) return onlyExact;
  if (exact.length > 1) {
    return yield* new CliFailure({
      message: `"${wanted}" matches several resources: ${exact
        .map((r) => `${r.displayName} (${r.resourceTypeId})`)
        .join(", ")}. Pass the full id from \`infrawrench resources --json\`.`,
    });
  }
  const prefix = rows.filter(
    (r) =>
      r.displayName.toLowerCase().startsWith(needle) ||
      r.externalId.toLowerCase().startsWith(needle),
  );
  const [onlyPrefix] = prefix;
  if (onlyPrefix && prefix.length === 1) return onlyPrefix;
  return yield* new CliFailure({
    message:
      prefix.length === 0
        ? `No resource matches "${wanted}" on this account. See \`infrawrench resources --account …\`.`
        : `"${wanted}" matches several resources: ${prefix
            .map((r) => r.displayName)
            .join(", ")}. Be more specific or pass the full id.`,
  });
});

const resolveEstimateTarget = Effect.fnUntraced(function* (wanted: string) {
  if (isCompoundResourceId(wanted)) {
    const parts = yield* splitResourceId(wanted);
    return { ...parts, resourceId: wanted };
  }

  // Friendly name / external id: needs an account scope, same as `resources`.
  const session = yield* CliSession;
  const accountArg = session.account;
  if (!accountArg) {
    return yield* new CliFailure({
      message: `"${wanted}" is not a full resource id. Pass {accountId}:{typeId}:{externalId}, or a name with --account <id|name> (see \`infrawrench resources\`).`,
    });
  }
  const org = yield* currentOrg;
  const account = yield* findAccount(yield* cloudAccounts(org.id), accountArg);
  const rows = yield* cloudResources(org.id, account.id);
  const row = yield* matchResource(rows, wanted);
  return {
    accountId: row.accountId,
    resourceTypeId: row.resourceTypeId,
    resourceId: row.id,
  };
});

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

const CARBON_UNPLACED: Partial<Record<string, string>> = {
  "unsupported-provider": "no grid data for this provider",
  "unknown-region": "region not covered",
  "unknown-size": "size unknown",
};

/** The carbon line beside the price, with what it rests on. */
const printCarbon = Effect.fnUntraced(function* (carbon: Carbon | null) {
  if (!carbon?.inScope) return;
  yield* Print.line();
  const f = carbon.estimate;
  if (!f) {
    return yield* Print.line(
      c.dim(`No carbon estimate: ${CARBON_UNPLACED[carbon.reason ?? ""] ?? "not placeable"}.`),
    );
  }
  const units = f.count === 1 ? `${f.vcpus} vCPU` : `${f.count} × ${f.vcpus} vCPU`;
  yield* Print.line(`${c.bold(`~${formatCo2e(f.kgCo2e)} CO2e/month`)} ${c.dim("· estimated")}`);
  yield* Print.line(
    c.dim(
      `  ${units} · ${f.gridZone} · ${Math.round(f.gridIntensity)} g/kWh · PUE ${f.pue}${
        carbon.role === "aggregate" ? " · nodes counted on their own" : ""
      }`,
    ),
  );
});

export const estimate = Command.make(
  "estimate",
  {
    resource: Argument.String("id|name").pipe(
      Argument.withDescription(
        "A full resource id, or a name or external id with --account <id|name>",
      ),
      Argument.optional,
    ),
  },
  Effect.fn("estimate")(function* ({ resource }) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    if (Option.isNone(resource) || !resource.value) {
      return yield* new CliFailure({
        message:
          "Usage: infrawrench estimate <resource-id|name> [--account <id|name>] [--org <id|name>]",
      });
    }
    if (session.local) {
      return yield* new CliFailure({
        message: "`estimate` is cloud-only. Drop --local, or pass --org <id|name>.",
      });
    }
    const [{ accountId, resourceTypeId, resourceId }, org] = yield* Effect.all(
      [resolveEstimateTarget(resource.value), currentOrg],
      { concurrency: 2 },
    );

    const body = yield* api.json(org.id, PATH, {
      method: "POST",
      body: JSON.stringify({ accountId, resourceTypeId, resourceId }),
    });

    if (session.output === "json") {
      // `null` rather than a zeroed object: a caller scripting against this has
      // to be able to tell "we can't price it" from "it's free".
      const raw = yield* decodeBody(RawEstimateResponse, PATH)(body);
      return yield* Print.json({ resourceId, estimate: raw.estimate, carbon: raw.carbon ?? null });
    }

    const { estimate, carbon } = yield* decodeBody(EstimateResponse, PATH)(body);
    if (!estimate) {
      yield* Print.line(
        `${c.dim("No estimate available for")} ${c.bold(resourceTypeId)} ${c.dim("(this provider plugin doesn't publish rates for it)")}`,
      );
      return yield* printCarbon(carbon ?? null);
    }

    yield* Print.line(
      `${c.bold(`${estimate.partial ? "at least " : ""}${money(estimate.monthlyAmount, estimate.currency)}/month`)} ${c.dim(`· ${resourceTypeId}`)}`,
    );
    yield* Print.line();
    yield* Print.keyValues(
      estimate.lineItems.map((item): [string, string] => [
        item.label,
        `${money(item.monthlyAmount, estimate.currency)}${item.detail ? c.dim(`  ${item.detail}`) : ""}`,
      ]),
    );
    if (estimate.partial) {
      yield* Print.line();
      yield* Print.line(
        c.yellow("! Partial. Some components of this resource have no published rate."),
      );
    }
    for (const note of estimate.notes ?? []) yield* Print.line(c.dim(`  ${note}`));
    yield* printCarbon(carbon ?? null);
  }),
).pipe(
  Command.withDescription(
    "What a resource costs per month at list price, itemized (cloud only; a full id, or a name with --account)",
  ),
);
