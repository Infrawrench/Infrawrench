// `infrawrench changes` — the cross-provider drift feed in the terminal,
// backed by the same /changes endpoint the web Changes page reads.
//
// Every poll cycle diffs a freshly fetched account against the stored snapshot
// and records what appeared, changed, or disappeared. The diff runs on the
// generic stored record, so this is cross-provider by construction: no plugin
// contributes anything to it, and a new plugin shows up here the moment its
// resources sync.
//
// Wire types and the row summary come from `@infrawrench/client-core` — the
// same definitions the web feed renders with, so a server-side change breaks
// the CLI's build instead of its output.
import {
  CliError,
  listCloudAccounts,
  orgFetch,
  resolveAccount,
  resolveOrg,
  type CliContext,
} from "../context";
import type { ResourceChangeEntry, ResourceChangeKind } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import type { RangeFlags } from "../args";
import { parseLastDays } from "../args";
import { c, printJson, println, printTable, printKeyValues } from "../output";
import { formatChangeTime } from "../format";

/** The endpoint's own `pageSize` bound. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const KINDS: ResourceChangeKind[] = ["created", "updated", "deleted"];

/** One glyph + color per kind, so a long feed reads at a glance. */
const KIND_STYLE: Record<ResourceChangeKind, { glyph: string; color: (s: string) => string }> = {
  created: { glyph: "+", color: c.green },
  updated: { glyph: "~", color: c.blue },
  deleted: { glyph: "-", color: c.red },
};

export async function cmdChanges(ctx: CliContext, range: RangeFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "The change timeline is recorded by Infrawrench Cloud's poller as it syncs your accounts — local-only mode has no poller, so there is no feed.",
    );
  }
  const org = await resolveOrg(ctx);

  if (range.kind !== undefined && !KINDS.includes(range.kind as ResourceChangeKind)) {
    throw new CliError(`--kind must be one of ${KINDS.join(", ")} — got "${range.kind}".`, 2);
  }
  const limit = Math.min(range.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const params = new URLSearchParams({ page: "1", pageSize: String(limit) });
  if (range.kind) params.set("kind", range.kind);
  if (range.resource) params.set("resourceId", range.resource);

  // --account takes the same id/name/prefix forms as every other command, so
  // resolve it against the org's accounts rather than pushing a raw string at
  // a uuid-typed query parameter.
  if (ctx.flags.account) {
    const account = resolveAccount(await listCloudAccounts(org.id), ctx.flags.account);
    params.set("accountId", account.id);
  }

  const { from, to } = resolveWindow(range);
  if (from) params.set("from", from);
  if (to) params.set("to", to);

  const response = await orgFetch<{ entries: ResourceChangeEntry[]; total: number }>(
    org.id,
    `/changes?${params.toString()}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, limit, total: response.total, entries: response.entries });
    return;
  }

  // The summary line ("name, size and 2 more") is shared with the web feed —
  // one definition of what an update reads as.
  const { summarizeChange, formatChangeValue } = await import("@infrawrench/client-core");

  const { entries, total } = response;
  if (entries.length === 0) {
    println(
      c.dim(
        "No changes recorded for this filter. Events start accumulating once the poller has synced an account at least twice.",
      ),
    );
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${entries.length} of ${total} event${total === 1 ? "" : "s"}, newest first`)}`,
  );
  println();

  printTable(entries, [
    { header: "when", value: (e) => c.dim(formatChangeTime(e.createdAt)) },
    {
      header: "",
      value: (e) => KIND_STYLE[e.changeKind].color(KIND_STYLE[e.changeKind].glyph),
    },
    { header: "resource", value: (e) => c.bold(e.displayName) },
    { header: "type", value: (e) => c.dim(`${e.pluginId}/${e.resourceTypeId}`) },
    { header: "account", value: (e) => e.accountName ?? c.dim("—") },
    { header: "what changed", value: (e) => summarizeChange(e) },
  ]);

  // Field-level diffs are the reason to look at one resource, so they print in
  // full when the feed is already narrowed to one — never for a whole org's
  // feed, which would be thousands of lines.
  if (range.resource) {
    for (const entry of entries) {
      if (entry.changeKind !== "updated" || entry.diff.length === 0) continue;
      println();
      println(`${c.dim(formatChangeTime(entry.createdAt))} ${c.bold(entry.displayName)}`);
      printKeyValues(
        entry.diff.map((d) => [
          d.field,
          `${c.dim(formatChangeValue(d.from))} ${c.dim("→")} ${formatChangeValue(d.to)}`,
        ]),
      );
    }
  }

  println();
  println(
    c.dim(
      range.resource
        ? "Pass --limit to see further back."
        : "Narrow with --account <id|name>, --resource <id>, --kind created|updated|deleted, or --last 7d.",
    ),
  );
}

/**
 * The `from`/`to` the feed should be asked for. `--last 7d` is the common case;
 * explicit `--from`/`--to` pass through as given (the endpoint wants ISO
 * date-times, which is also what a user typing a date gets).
 */
function resolveWindow(range: RangeFlags): { from?: string; to?: string } {
  const to = range.to;
  if (range.from) return { from: range.from, ...(to ? { to } : {}) };
  const days = range.days ?? (range.last ? parseLastDays(range.last) : null);
  if (days === null) return to ? { to } : {};
  const anchor = to ? Date.parse(to) : Date.now();
  if (Number.isNaN(anchor)) {
    throw new CliError(`Invalid --to "${to}" — use an ISO 8601 date or date-time.`, 2);
  }
  return {
    from: new Date(anchor - days * 86_400_000).toISOString(),
    ...(to ? { to } : {}),
  };
}
