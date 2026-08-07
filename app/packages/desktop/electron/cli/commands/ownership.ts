// `infrawrench ownership` — who owns each resource, what it is for, and the
// ticket that authorized it.
//
// Cloud-only: ownership names an org member, and a local workspace has neither
// an org nor members. The CLI lists; setting an owner lives on the resource
// detail view's Ownership tab, where the owner is a picker over real members
// rather than a string you can typo.
//
// The listing is sorted so the *un*claimed resources are what you see first
// when you pass a query — "who owns this?" is usually asked because nobody
// seems to.
//
// The response shapes come from `@infrawrench/client-core` — the same
// definitions every other surface renders — so a server-side change breaks the
// CLI's build instead of its output. The imports are type-only, so the CLI
// still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  ResourceOwnership,
  ResourceOwnershipListResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

function ownerCell(record: ResourceOwnership): string {
  const member = record.ownerName ?? record.ownerEmail;
  if (record.ownerUserId && member) return member;
  // A free-text owner is marked, because the difference that matters is
  // whether an alert can reach it — not how it reads.
  if (record.ownerLabel) return `${record.ownerLabel} ${c.dim("(team)")}`;
  return c.dim("unowned");
}

export async function cmdOwnership(ctx: CliContext, query?: string): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Ownership lives in Infrawrench Cloud — it names an org member. Drop --local.",
    );
  }
  const org = await resolveOrg(ctx);
  const { ownership } = await orgFetch<ResourceOwnershipListResponse>(org.id, "/ownership");

  const needle = query?.toLowerCase();
  const rows = needle
    ? ownership.filter(
        (record) =>
          record.resourceName.toLowerCase().includes(needle) ||
          record.resourceId.toLowerCase().includes(needle) ||
          (record.ownerName?.toLowerCase().includes(needle) ?? false) ||
          (record.ownerEmail?.toLowerCase().includes(needle) ?? false) ||
          (record.ownerLabel?.toLowerCase().includes(needle) ?? false) ||
          (record.purpose?.toLowerCase().includes(needle) ?? false),
      )
    : ownership;

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ownership: rows });
    return;
  }

  if (rows.length === 0) {
    println(
      c.dim(
        query
          ? `Nothing recorded matches "${query}".`
          : "No ownership recorded yet. Set an owner from a resource's Ownership tab — the orphan finder will then name them against anything it flags.",
      ),
    );
    return;
  }

  const columns: Column<ResourceOwnership>[] = [
    { header: "resource", value: (r) => r.resourceName },
    { header: "owner", value: ownerCell },
    { header: "purpose", value: (r) => r.purpose ?? c.dim("—") },
    { header: "ticket", value: (r) => c.dim(r.ticketUrl ?? "—") },
  ];

  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${rows.length} resource${rows.length === 1 ? "" : "s"} with ownership recorded`)}`,
  );
  println();
  printTable(rows, columns);

  println();
  println(
    c.dim(
      "Only resources with something recorded appear here — everything else is unowned. " +
        "Run `infrawrench orphans` to see the unowned resources that also look wasted.",
    ),
  );
}
