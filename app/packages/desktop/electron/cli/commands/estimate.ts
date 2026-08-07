// `infrawrench estimate <resource-id>` — what a resource costs per month at
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
import type { CostEstimate } from "@infrawrench/plugin-base" with { "resolution-mode": "import" };

import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import { c, printJson, printKeyValues, println } from "../output";

/** `{accountId}:{typeId}:{externalId}` — the id shape every surface uses. */
function splitResourceId(resourceId: string): { accountId: string; resourceTypeId: string } {
  const [accountId, resourceTypeId] = resourceId.split(":");
  if (!accountId || !resourceTypeId) {
    throw new CliError(
      `"${resourceId}" is not a resource id. Expected {accountId}:{typeId}:{externalId} — see \`infrawrench resources\`.`,
    );
  }
  return { accountId, resourceTypeId };
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

export async function cmdEstimate(ctx: CliContext, resourceId: string): Promise<void> {
  if (!resourceId) throw new CliError("Usage: infrawrench estimate <resource-id>");
  if (ctx.flags.local) {
    throw new CliError("`estimate` is cloud-only — drop --local, or pass --org <id|name>.");
  }
  const { accountId, resourceTypeId } = splitResourceId(resourceId);
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
