// `infrawrench search <query>`: the command palette's index from a terminal.
// Every kind the caller's role can read (resources, workflows, cost reports,
// dashboards, budgets, SLOs, services, runbooks, …), narrowed server-side to
// what the caller could open and fuzzy-ranked, each with the web address that
// opens it. `--kind cost_report,slo` narrows; `--json` for scripts.
//
// `infrawrench starred` lists the caller's stars (the palette's first
// section); `starred add|remove <kind> <id>` toggles one, with the kind and id
// exactly as `search --json` prints them.
//
// Types come from `@infrawrench/client-core` type-only; the runtime helpers
// (kind list, labels, URLs) load with a dynamic import, the CLI's rule for
// client-core code. Zero new runtime dependencies.
import { CLOUD_URL } from "../../../env";
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  SearchResult,
  SearchResultKind,
  StarredItem,
  StarredListResponse,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe } from "../output";

type Core = typeof import("@infrawrench/client-core", { with: { "resolution-mode": "import" } });

function requireCloud(ctx: CliContext, what: string): void {
  if (ctx.flags.local) {
    throw new CliError(`${what} live in Infrawrench Cloud, per organization. Drop --local.`);
  }
}

/** The web address a hit opens at, for clicking from a terminal. */
function hitUrl(core: Core, orgId: string, hit: SearchResult): string {
  const kind = core.searchResultKind(hit);
  if (kind === "resource") {
    return core.webResourceUrl(CLOUD_URL, orgId, {
      accountId: hit.accountId,
      pluginId: hit.pluginId,
      resourceTypeId: hit.resourceTypeId,
      resourceId: hit.id,
    });
  }
  if (kind === "workflow") return core.webWorkflowUrl(CLOUD_URL, orgId, hit.id);
  return core.webObjectUrl(CLOUD_URL, orgId, kind, hit.id);
}

function parseKinds(core: Core, raw: string | undefined): SearchResultKind[] | "all" {
  if (!raw) return "all";
  const kinds = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const unknown = kinds.filter((k) => !core.isSearchResultKind(k));
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown kind ${unknown.map((k) => `"${k}"`).join(", ")}. Valid: ${core.SEARCH_RESULT_KINDS.join(", ")}.`,
      2,
    );
  }
  return kinds as SearchResultKind[];
}

function printHits(core: Core, orgId: string, hits: readonly SearchResult[]): void {
  printTable(
    [...hits],
    [
      { header: "KIND", value: (h) => core.SEARCH_KIND_LABELS[core.searchResultKind(h)].singular },
      { header: "NAME", value: (h) => safe(h.displayName) },
      {
        header: "DETAIL",
        value: (h) =>
          safe(
            core.searchResultKind(h) === "resource"
              ? [h.resourceTypeLabel, h.accountName].filter(Boolean).join(" · ")
              : (h.subtitle ?? ""),
          ),
      },
      { header: "OPEN", value: (h) => c.dim(hitUrl(core, orgId, h)) },
    ],
  );
}

/** `infrawrench search <query> [--kind a,b] [--json]`. */
export async function cmdSearch(
  ctx: CliContext,
  query: string,
  kindFlag: string | undefined,
): Promise<void> {
  requireCloud(ctx, "The search index and its saved objects");
  if (!query.trim()) {
    throw new CliError("Give something to search for: `infrawrench search <query>`.", 2);
  }
  const core: Core = await import("@infrawrench/client-core");
  const kinds = parseKinds(core, kindFlag);
  const org = await resolveOrg(ctx);
  const hits = await orgFetch<SearchResult[]>(
    org.id,
    `/search?${core.searchQueryString(query, { kinds })}`,
  );

  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      query,
      results: hits.map((h) => ({
        ...h,
        kind: core.searchResultKind(h),
        url: hitUrl(core, org.id, h),
      })),
    });
    return;
  }

  if (hits.length === 0) {
    println(c.dim(`Nothing you can open matches "${safe(query)}".`));
    return;
  }
  printHits(core, org.id, hits);
}

/** `infrawrench starred`, `starred add <kind> <id>`, `starred remove <kind> <id>`. */
export async function cmdStarred(ctx: CliContext, args: readonly string[]): Promise<void> {
  requireCloud(ctx, "Stars");
  const core: Core = await import("@infrawrench/client-core");
  const org = await resolveOrg(ctx);
  const [sub, kindArg, ...idParts] = args;

  if (sub === "add" || sub === "remove") {
    const id = idParts.join(" ");
    if (!kindArg || !id) {
      throw new CliError(
        `Usage: infrawrench starred ${sub} <kind> <id>. \`infrawrench search <query> --json\` prints both.`,
        2,
      );
    }
    if (!core.isSearchResultKind(kindArg)) {
      throw new CliError(
        `Unknown kind "${kindArg}". Valid: ${core.SEARCH_RESULT_KINDS.join(", ")}.`,
        2,
      );
    }
    const ref = { kind: kindArg, id };
    if (sub === "add") {
      const res = await orgFetch<{ item: StarredItem }>(org.id, core.starPath(ref), {
        method: "PUT",
      });
      if (ctx.flags.output === "json") printJson({ org: org.id, item: res.item });
      else println(`Starred ${safe(res.item.displayName)}.`);
    } else {
      await orgFetch(org.id, core.starPath(ref), { method: "DELETE" });
      if (ctx.flags.output === "json") printJson({ org: org.id, removed: ref });
      else println("Unstarred.");
    }
    return;
  }
  if (sub !== undefined && sub !== "list") {
    throw new CliError(
      `Unknown subcommand "starred ${sub}". Try: starred, starred add, starred remove.`,
      2,
    );
  }

  const { items } = await orgFetch<StarredListResponse>(org.id, "/starred");
  if (ctx.flags.output === "json") {
    printJson({
      org: org.id,
      items: items.map((i) => ({ ...i, url: hitUrl(core, org.id, i) })),
    });
    return;
  }
  if (items.length === 0) {
    println(
      c.dim(
        "Nothing starred yet. Star a report, dashboard, SLO or resource from its page header or " +
          "with the modifier+S in Cmd+K, or `infrawrench starred add <kind> <id>`.",
      ),
    );
    return;
  }
  printHits(core, org.id, items);
}
