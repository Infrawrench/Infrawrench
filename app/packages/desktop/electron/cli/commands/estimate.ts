// `infrawrench estimate <resource>` — what a resource costs per month at
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
// the lookup — same friendly resolution accounts get via `resolveAccount`.
import type { CostEstimate } from "@infrawrench/plugin-base" with { "resolution-mode": "import" };

import {
  CliError,
  listCloudAccounts,
  listCloudResources,
  orgFetch,
  resolveAccount,
  resolveOrg,
  type CliContext,
  type ResourceRow,
} from "../context";
import { c, printJson, printKeyValues, println } from "../output";

/** `{accountId}:{typeId}:{externalId}` — the id shape every surface uses. */
function isCompoundResourceId(value: string): boolean {
  // accountId and typeId never contain colons; externalId may. Need at least
  // two separators so a bare name is never mistaken for an id.
  const first = value.indexOf(":");
  if (first <= 0) return false;
  const second = value.indexOf(":", first + 1);
  return second > first + 1 && second < value.length - 1;
}

function splitResourceId(resourceId: string): { accountId: string; resourceTypeId: string } {
  const [accountId, resourceTypeId] = resourceId.split(":");
  if (!accountId || !resourceTypeId) {
    throw new CliError(
      `"${resourceId}" is not a resource id. Expected {accountId}:{typeId}:{externalId}, or a name with --account — see \`infrawrench resources\`.`,
    );
  }
  return { accountId, resourceTypeId };
}

/**
 * Resolve a display name / external id / full id against an account's cloud
 * resources. Ambiguous names fail loud rather than estimate the wrong row.
 */
function matchResource(rows: ResourceRow[], wanted: string): ResourceRow {
  const byId = rows.find((r) => r.id === wanted);
  if (byId) return byId;
  const needle = wanted.toLowerCase();
  const exact = rows.filter(
    (r) =>
      r.displayName.toLowerCase() === needle ||
      (r.externalId !== "" && r.externalId.toLowerCase() === needle),
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new CliError(
      `"${wanted}" matches several resources: ${exact
        .map((r) => `${r.displayName} (${r.resourceTypeId})`)
        .join(", ")}. Pass the full id from \`infrawrench resources --json\`.`,
    );
  }
  const prefix = rows.filter(
    (r) =>
      r.displayName.toLowerCase().startsWith(needle) ||
      r.externalId.toLowerCase().startsWith(needle),
  );
  if (prefix.length === 1) return prefix[0]!;
  throw new CliError(
    prefix.length === 0
      ? `No resource matches "${wanted}" on this account. See \`infrawrench resources --account …\`.`
      : `"${wanted}" matches several resources: ${prefix
          .map((r) => r.displayName)
          .join(", ")}. Be more specific or pass the full id.`,
  );
}

async function resolveEstimateTarget(
  ctx: CliContext,
  wanted: string,
): Promise<{ accountId: string; resourceTypeId: string; resourceId: string }> {
  if (isCompoundResourceId(wanted)) {
    const parts = splitResourceId(wanted);
    return { ...parts, resourceId: wanted };
  }

  // Friendly name / external id — needs an account scope, same as `resources`.
  if (!ctx.flags.account) {
    throw new CliError(
      `"${wanted}" is not a full resource id. Pass {accountId}:{typeId}:{externalId}, or a name with --account <id|name> (see \`infrawrench resources\`).`,
    );
  }
  const org = await resolveOrg(ctx);
  const account = resolveAccount(await listCloudAccounts(org.id), ctx.flags.account);
  const row = matchResource(await listCloudResources(org.id, account.id), wanted);
  return {
    accountId: row.accountId,
    resourceTypeId: row.resourceTypeId,
    resourceId: row.id,
  };
}

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

export async function cmdEstimate(ctx: CliContext, resourceArg: string): Promise<void> {
  if (!resourceArg) {
    throw new CliError(
      "Usage: infrawrench estimate <resource-id|name> [--account <id|name>] [--org <id|name>]",
    );
  }
  if (ctx.flags.local) {
    throw new CliError("`estimate` is cloud-only — drop --local, or pass --org <id|name>.");
  }
  const { accountId, resourceTypeId, resourceId } = await resolveEstimateTarget(ctx, resourceArg);
  const org = await resolveOrg(ctx);

  const { estimate } = await orgFetch<{ estimate: CostEstimate | null }>(
    org.id,
    "/resources/cost-estimate",
    { method: "POST", body: JSON.stringify({ accountId, resourceTypeId, resourceId }) },
  );

  if (ctx.flags.output === "json") {
    // `null` rather than a zeroed object: a caller scripting against this has
    // to be able to tell "we can't price it" from "it's free".
    printJson({ resourceId, estimate });
    return;
  }

  if (!estimate) {
    println(
      `${c.dim("No estimate available for")} ${c.bold(resourceTypeId)} ${c.dim("— this provider plugin doesn't publish rates for it.")}`,
    );
    return;
  }

  println(
    `${c.bold(`${estimate.partial ? "at least " : ""}${money(estimate.monthlyAmount, estimate.currency)}/month`)} ${c.dim(`· ${resourceTypeId}`)}`,
  );
  println();
  printKeyValues(
    estimate.lineItems.map(
      (item) =>
        [
          item.label,
          `${money(item.monthlyAmount, estimate.currency)}${item.detail ? c.dim(`  ${item.detail}`) : ""}`,
        ] as [string, string],
    ),
  );
  if (estimate.partial) {
    println();
    println(c.yellow("! Partial — some components of this resource have no published rate."));
  }
  for (const note of estimate.notes ?? []) println(c.dim(`  ${note}`));
}
