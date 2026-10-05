// `infrawrench extended-support`; resources on versions past (or about to
// leave) their provider's standard support, with the monthly surcharge an
// upgrade removes.
//
// Works in both modes, because the support calendars are plugin declarations
// evaluated over stored versions:
//   - cloud (default): GET /extended-support, the same endpoint the Costs
//     panel's Extended support section renders, including billed amounts
//     where the provider's billing can be attributed.
//   - --local: electron/local-extended-support.ts runs the shared computation
//     over this machine's SQLite workspace. List price only; no credentials,
//     no network.
//
// The response type comes from `@infrawrench/client-core` as a type-only
// import, so the CLI ships zero new runtime dependencies.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import { listLocalExtendedSupport } from "../../local-extended-support";
import type {
  ExtendedSupportFinding,
  ExtendedSupportListResponse,
  ExtendedSupportStatus,
  ExtendedSupportTotal,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

const STATUS_LABEL: Record<ExtendedSupportStatus, string> = {
  "end-of-life": "past end of support",
  surcharged: "paying extended support",
  unsupported: "out of standard support",
  upcoming: "surcharge upcoming",
};

const STATUS_COLOR: Record<ExtendedSupportStatus, (s: string) => string> = {
  "end-of-life": c.red,
  surcharged: c.yellow,
  unsupported: c.yellow,
  upcoming: c.dim,
};

/** Plain currency formatting; Intl is built into Node, so no dependency. */
function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function totals(list: ExtendedSupportTotal[]): string {
  return list.map((t) => `${money(t.monthly, t.currency)}/mo`).join(" + ");
}

function whenText(f: ExtendedSupportFinding): string {
  if (f.status === "upcoming") return `starts ${f.surchargeStartsOn} (${f.daysUntilSurcharge}d)`;
  if (f.status === "end-of-life") return `ended ${f.extendedSupportEnds ?? "?"}`;
  return f.extendedSupportEnds
    ? `since ${f.surchargeStartsOn}, forced ${f.extendedSupportEnds}`
    : `since ${f.surchargeStartsOn}`;
}

function costText(f: ExtendedSupportFinding): string {
  if (f.monthlySurcharge === null || f.currency === null)
    return c.dim(f.charged ? "not priced" : "no surcharge");
  const basis =
    f.costBasis === "billed" ? "billed" : f.costBasis === "billed-share" ? "billed share" : "list";
  return `${money(f.monthlySurcharge, f.currency)}/mo ${c.dim(basis)}`;
}

export async function cmdExtendedSupport(ctx: CliContext): Promise<void> {
  const scope = ctx.flags.local
    ? { label: "Local workspace", response: await listLocalExtendedSupport(), json: {} }
    : await (async () => {
        const org = await resolveOrg(ctx);
        return {
          label: org.displayName,
          response: await orgFetch<ExtendedSupportListResponse>(org.id, "/extended-support"),
          json: { org: org.id },
        };
      })();
  const { response } = scope;

  if (ctx.flags.output === "json") {
    printJson({ ...scope.json, ...response });
    return;
  }

  if (response.findings.length === 0) {
    println(
      c.dim(
        `Nothing is on an extended-support or end-of-life version (upcoming surcharges are listed ${response.leadDays} days ahead).`,
      ),
    );
    return;
  }

  const header = [
    response.currentMonthly.length > 0 ? `paying ${totals(response.currentMonthly)}` : "",
    response.upcomingMonthly.length > 0 ? `upcoming ${totals(response.upcomingMonthly)}` : "",
  ]
    .filter(Boolean)
    .join(c.dim(" · "));
  println(
    `${c.bold(scope.label)} ${c.dim(
      `· ${response.totalCount} resource${response.totalCount === 1 ? "" : "s"}`,
    )}  ${header}`,
  );
  println();

  const columns: Column<ExtendedSupportFinding>[] = [
    {
      header: "status",
      value: (f) =>
        (STATUS_COLOR[f.status] ?? ((s: string) => s))(STATUS_LABEL[f.status] ?? f.status),
    },
    { header: "resource", value: (f) => f.displayName },
    { header: "account", value: (f) => c.dim(f.accountName) },
    { header: "version", value: (f) => `${f.product} ${f.currentVersion} → ${f.targetVersion}` },
    { header: "when", value: (f) => whenText(f) },
    { header: "surcharge", value: (f) => costText(f), align: "right" },
  ];
  printTable(response.findings, columns);

  const failed = response.billing?.accounts.filter((a) => a.status === "failed") ?? [];
  if (failed.length > 0) {
    println();
    println(
      c.yellow(
        `Billing unreadable for ${failed.map((a) => a.accountName).join(", ")}; those rows are list price.`,
      ),
    );
  }
  for (const u of response.billing?.unattributed ?? []) {
    println(
      c.dim(
        `Unattributed billed line: ${u.accountName} ${u.lineItem}${u.region ? ` ${u.region}` : ""} ${money(u.monthlyAmount, u.currency)}/mo`,
      ),
    );
  }

  println();
  println(
    c.dim(
      ctx.flags.local
        ? "Local workspace, list price only. Upgrade guides are in --json (upgradeUrl)."
        : "Billed amounts where the provider's billing names the charge, list price otherwise. Upgrade guides are in --json (upgradeUrl).",
    ),
  );
}
