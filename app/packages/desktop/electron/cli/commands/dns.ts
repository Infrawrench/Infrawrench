// `infrawrench dns` — every DNS zone and record across your providers, with
// each record's target judged against the rest of the workspace. Dangling
// targets (a name pointing into a provider namespace you manage that nothing
// synced claims) print first and in red: that is the subdomain-takeover
// signature.
//
// Works in both modes, because the classification is declarative and runs
// over stored state rather than a live provider call — and it resolves no DNS
// in either mode:
//   - cloud (default) — GET /dns, the same endpoint the web + desktop Domains
//     screens render.
//   - --local — electron/local-dns.ts runs the shared computation over this
//     machine's SQLite workspace. No credentials, no network.
//
// The response shape comes from `@infrawrench/client-core` — the same
// definition every other surface uses — so a server-side change breaks the
// CLI's build instead of its output. The import is type-only, so the CLI
// still ships zero new runtime dependencies.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import { listLocalDns } from "../../local-dns";
import type {
  DnsInventoryResponse,
  DnsRecordEntry,
  DnsTargetClassification,
  DnsZoneEntry,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

/** Terminal tone per bucket: red = takeover risk, green = resolves here, dim = nothing to say. */
const STATUS_COLOR: Record<DnsTargetClassification, (s: string) => string> = {
  dangling: c.red,
  owned: c.green,
  external: (s) => s,
  "not-analysed": c.dim,
};

const STATUS_LABEL: Record<DnsTargetClassification, string> = {
  dangling: "dangling",
  owned: "internal",
  external: "external",
  "not-analysed": "—",
};

/** The header's tally, e.g. "2 dangling · 31 internal · 12 external". */
function countsSummary(response: DnsInventoryResponse): string {
  const { counts } = response;
  const parts: string[] = [];
  if (counts.dangling > 0) parts.push(c.red(`${counts.dangling} dangling`));
  if (counts.owned > 0) parts.push(c.green(`${counts.owned} internal`));
  if (counts.external > 0) parts.push(`${counts.external} external`);
  if (counts.notAnalysed > 0) parts.push(c.dim(`${counts.notAnalysed} not analysed`));
  return parts.join(c.dim(" · "));
}

/** All of a record's targets on one line; the table has no room for more. */
function targetsCell(record: DnsRecordEntry): string {
  if (record.targets.length === 0) return c.dim("—");
  return record.targets.map((t) => t.value).join(", ");
}

export async function cmdDns(ctx: CliContext): Promise<void> {
  const scope = ctx.flags.local
    ? { label: "Local workspace", response: await listLocalDns(), json: {} }
    : await (async () => {
        const org = await resolveOrg(ctx);
        return {
          label: org.displayName,
          response: await orgFetch<DnsInventoryResponse>(org.id, "/dns"),
          json: { org: org.id },
        };
      })();
  const { response } = scope;

  if (ctx.flags.output === "json") {
    printJson({ ...scope.json, ...response });
    return;
  }

  if (response.zones.length === 0 && response.records.length === 0) {
    println(
      c.dim(
        "No DNS zones synced. Connect an account on a provider that manages DNS — Cloudflare, Route 53, Cloud DNS, DigitalOcean, Netlify, Azure DNS or Vercel.",
      ),
    );
    if (ctx.flags.local) {
      println(
        c.dim("This scan covered the local workspace only; drop --local for your organization."),
      );
    }
    return;
  }

  println(
    `${c.bold(scope.label)} ${c.dim(
      `· ${response.counts.zones} zone${response.counts.zones === 1 ? "" : "s"}, ` +
        `${response.counts.records} record${response.counts.records === 1 ? "" : "s"}`,
    )}  ${countsSummary(response)}`,
  );
  println();

  if (response.zones.length > 0) {
    const zoneColumns: Column<DnsZoneEntry>[] = [
      { header: "domain", value: (z) => (z.isPrivate ? c.dim(`${z.domain} (private)`) : z.domain) },
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
    printTable(response.zones, zoneColumns);
    println();
  }

  if (response.records.length > 0) {
    // The contract serves records worst-status first; the table keeps that order.
    const recordColumns: Column<DnsRecordEntry>[] = [
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
    printTable(response.records, recordColumns);
    println();
  }

  for (const record of response.records) {
    for (const target of record.targets) {
      if (!target.service) continue;
      println(
        `${c.red("dangling")} ${c.bold(`${record.type} ${record.name}`)} → ${target.value}\n` +
          `  ${target.service.label} — nothing synced claims "${target.service.claimLabel}". ${target.service.reason}`,
      );
    }
  }

  if (response.skippedNamespaces.length > 0) {
    println();
    println(c.bold("Not checked"));
    for (const entry of response.skippedNamespaces) {
      println(c.dim(`  ${entry.label} — ${entry.reason}`));
    }
  }

  println();
  println(
    c.dim(
      "Computed from already-synced state — no provider was contacted and no DNS was resolved. Dangling records also appear on Posture and feed the posture alerts.",
    ),
  );
}
