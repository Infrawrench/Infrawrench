// `infrawrench seats`; paid SaaS seats (Copilot, Cursor, GitLab, Okta, ...)
// worth acting on: inactive for the org's threshold, the same person paying
// for two tools in one category, or a cheaper tier their usage fits.
//
//   seats                 the findings, with remediation commands
//   seats all             every seat and how its activity was determined
//   seats remove <id>     remove a flagged seat through its provider [-y]
//   seats refresh         re-collect seats now
//
// Cloud only: the inventory is collected by the cloud poller from the org's
// connected accounts. The response type comes from `@infrawrench/client-core`
// as a type-only import, so the CLI ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  SeatFinding,
  SeatListResponse,
  SeatRemovalResponse,
  SeatTotal,
  SeatView,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe, type Column } from "../output";
import { confirm } from "../prompt";
import { printRemediation } from "../remediation";

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

function totals(list: SeatTotal[]): string {
  return list.map((t) => `${money(t.monthly, t.currency)}/mo`).join(" + ");
}

function holder(seat: SeatView): string {
  return seat.name || seat.email || seat.login || seat.memberId;
}

function activityText(seat: SeatView): string {
  if (seat.activityBasis === "none") return c.dim("not reported");
  if (seat.status === "unknown") return c.dim("unknown");
  if (seat.neverActive) {
    return seat.daysInactive !== null ? `never (${seat.daysInactive}d held)` : "never";
  }
  if (seat.lastActiveAt) return `${seat.lastActiveAt.slice(0, 10)} (${seat.daysInactive ?? 0}d)`;
  return c.dim("none");
}

const BASIS: Record<SeatView["activityBasis"], string> = {
  "last-activity": "last use",
  "last-login": "last sign-in",
  "usage-window": "daily usage",
  none: "not reported",
};

function findingText(f: SeatFinding, seat: SeatView, days: number): string {
  switch (f.kind) {
    case "inactive":
      return c.yellow(`unused ${days}d+`);
    case "duplicate":
      return `also on ${f.duplicate?.keptProduct ?? "?"} (${f.duplicate?.keptAccountName ?? "?"})`;
    case "downgrade":
      return `${seat.seatType} -> ${f.targetSeatType ?? "?"}`;
  }
}

function priceText(amount: number | null, currency: string | null, seat: SeatView): string {
  if (amount === null || currency === null) return c.dim("not priced");
  const source = seat.priceSource === "list-price" ? "list" : (seat.priceSource ?? "");
  return `${money(amount, currency)}/mo ${c.dim(source)}`;
}

function printAccountProblems(response: SeatListResponse): void {
  for (const a of response.accounts) {
    if (a.lastError) {
      println(c.yellow(`Couldn't read seats from ${safe(a.accountName)}: ${safe(a.lastError)}`));
    } else if (a.lastPolledAt === null) {
      println(c.dim(`Waiting for the first seat read from ${safe(a.accountName)}.`));
    }
  }
}

async function listFindings(ctx: CliContext, orgId: string, label: string): Promise<void> {
  const response = await orgFetch<SeatListResponse>(orgId, "/seats");
  if (ctx.flags.output === "json") {
    printJson({ org: orgId, ...response });
    return;
  }
  if (response.accounts.length === 0) {
    println(
      c.dim(
        "No connected account reports seats. Connect GitHub (Copilot), Cursor, GitLab, Okta, Claude Enterprise, Docker Hub or Tailscale.",
      ),
    );
    return;
  }
  const header = [
    response.savingsMonthly.length > 0 ? `to save ${totals(response.savingsMonthly)}` : "",
    response.spendMonthly.length > 0 ? c.dim(`seats cost ${totals(response.spendMonthly)}`) : "",
  ]
    .filter(Boolean)
    .join(c.dim(" · "));
  println(
    `${c.bold(safe(label))} ${c.dim(`· ${response.counts.seats} seats, threshold ${response.inactiveDays}d`)}  ${header}`,
  );
  if (response.counts.unknownActivity > 0) {
    println(
      c.dim(
        `${response.counts.unknownActivity} seat(s) on providers that report no usable activity are never flagged.`,
      ),
    );
  }
  printAccountProblems(response);
  println();
  if (response.findings.length === 0) {
    println(c.dim("No seat is inactive, duplicated or on a dearer tier than it needs."));
    return;
  }

  const byId = new Map(response.seats.map((s) => [s.id, s]));
  const rows = response.findings.flatMap((f) => {
    const seat = byId.get(f.seatId);
    return seat ? [{ f, seat }] : [];
  });
  const columns: Column<{ f: SeatFinding; seat: SeatView }>[] = [
    { header: "finding", value: (r) => findingText(r.f, r.seat, response.inactiveDays) },
    { header: "who", value: (r) => safe(holder(r.seat)) },
    { header: "seat", value: (r) => safe(`${r.seat.product} · ${r.seat.seatType}`) },
    { header: "account", value: (r) => c.dim(safe(r.seat.accountName)) },
    { header: "last active", value: (r) => activityText(r.seat) },
    { header: "saves", value: (r) => priceText(r.f.monthlySaving, r.f.currency, r.seat) },
    { header: "id", value: (r) => c.dim(r.seat.removable ? r.seat.id : "-") },
  ];
  printTable(rows, columns);
  printRemediation(
    rows.map((r) => ({
      displayName: `${holder(r.seat)} (${r.seat.product})`,
      remediation: r.f.remediation,
    })),
  );
  println();
  println(c.dim("Remove a flagged seat through its provider: infrawrench seats remove <id>"));
}

async function listAll(ctx: CliContext, orgId: string): Promise<void> {
  const response = await orgFetch<SeatListResponse>(orgId, "/seats");
  if (ctx.flags.output === "json") {
    printJson({ org: orgId, inactiveDays: response.inactiveDays, seats: response.seats });
    return;
  }
  const columns: Column<SeatView>[] = [
    { header: "who", value: (s) => safe(holder(s)) },
    { header: "email", value: (s) => c.dim(safe(s.email ?? "")) },
    { header: "seat", value: (s) => safe(`${s.product} · ${s.seatType}`) },
    { header: "account", value: (s) => c.dim(safe(s.accountName)) },
    { header: "status", value: (s) => s.status },
    { header: "last active", value: (s) => activityText(s) },
    { header: "evidence", value: (s) => c.dim(BASIS[s.activityBasis]) },
    { header: "price", value: (s) => priceText(s.monthlyPrice, s.currency, s) },
  ];
  printTable(response.seats, columns);
  printAccountProblems(response);
}

async function removeOne(
  ctx: CliContext,
  orgId: string,
  seatId: string | undefined,
  yes: boolean,
): Promise<void> {
  if (!seatId) throw new CliError("Usage: infrawrench seats remove <seat id> [-y]");
  const list = await orgFetch<SeatListResponse>(orgId, "/seats");
  const seat = list.seats.find((s) => s.id === seatId);
  if (!seat) throw new CliError(`No seat ${seatId}. List them with: infrawrench seats`);
  if (!yes) {
    const note = seat.removalNote ? ` ${seat.removalNote}` : "";
    const ok = await confirm(
      `Remove the ${safe(seat.product)} seat for ${safe(holder(seat))} on ${safe(seat.accountName)}?${safe(note)}`,
    );
    if (!ok) return;
  }
  const result = await orgFetch<SeatRemovalResponse>(
    orgId,
    `/seats/${encodeURIComponent(seatId)}/remove`,
    { method: "POST" },
  );
  if (ctx.flags.output === "json") {
    printJson({ org: orgId, seatId, ...result });
    return;
  }
  println(
    result.message
      ? safe(result.message)
      : result.effective === "end-of-cycle"
        ? "Removed. The provider bills it until the end of the cycle."
        : "Removed.",
  );
}

export async function cmdSeats(ctx: CliContext, args: string[], yes: boolean): Promise<void> {
  if (ctx.flags.local) throw new CliError("Seats are collected in the cloud; drop --local.");
  const org = await resolveOrg(ctx);
  switch (args[0]) {
    case undefined:
      return listFindings(ctx, org.id, org.displayName);
    case "all":
      return listAll(ctx, org.id);
    case "remove":
      return removeOne(ctx, org.id, args[1], yes);
    case "refresh": {
      const { queued } = await orgFetch<{ queued: number }>(org.id, "/seats/refresh", {
        method: "POST",
      });
      if (ctx.flags.output === "json") printJson({ org: org.id, queued });
      else println(`Re-collecting seats for ${queued} account(s); this takes a few minutes.`);
      return;
    }
    default:
      throw new CliError(
        `Unknown seats subcommand "${args[0]}". Try: seats, seats all, seats remove <id>, seats refresh`,
      );
  }
}
