// `infrawrench status-pages` — the org's public status pages, what each one
// publishes, and the URL it is live at.
//
// Cloud-only, like the probes they publish: the checks run in the cloud poller
// and the page is served by the cloud web app, so a local workspace has
// nothing to list. The CLI lists; creating and editing pages — and the
// publish decision in particular — lives on the web/desktop Probes tab.
//
// Listing it here is the point, though: the one thing worth being able to ask
// from a terminal is "what of our monitoring is currently public, and where?".
//
// The response shapes come from `@infrawrench/client-core` — the same
// definitions every other surface renders — so a server-side change breaks the
// CLI's build instead of its output. The imports are type-only, so the CLI
// still ships zero new runtime dependencies.
import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { StatusPage, StatusPageListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";
import { CLOUD_URL } from "../../../env";

/** The public URL of a page. Mirrors client-core's `statusPageUrl`. */
function pageUrl(origin: string, page: StatusPage): string {
  return `${origin.replace(/\/+$/, "")}/status/${page.slug}`;
}

export async function cmdStatusPages(ctx: CliContext, pageArg?: string): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError(
      "Status pages live in Infrawrench Cloud — the page is served by the web app. Drop --local.",
    );
  }
  const org = await resolveOrg(ctx);
  const { pages } = await orgFetch<StatusPageListResponse>(org.id, "/status-pages");

  if (pageArg) {
    const needle = pageArg.toLowerCase();
    const page =
      pages.find((p) => p.id === pageArg) ??
      pages.find((p) => p.title.toLowerCase() === needle) ??
      pages.find((p) => p.title.toLowerCase().includes(needle));
    if (!page) {
      throw new CliError(
        `No status page matches "${pageArg}". Run \`infrawrench status-pages\` to list.`,
      );
    }
    printPageDetail(ctx, page);
    return;
  }

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, pages });
    return;
  }

  if (pages.length === 0) {
    println(
      c.dim(
        "No status pages yet. Create one from the Probes tab — a page publishes probes you already run.",
      ),
    );
    return;
  }

  const columns: Column<StatusPage>[] = [
    { header: "page", value: (p) => p.title },
    {
      header: "state",
      value: (p) => (p.published ? c.green("● live") : c.dim("○ draft")),
    },
    { header: "components", value: (p) => String(p.components.length), align: "right" },
    // The URL is printed for drafts too: knowing where a page *will* be is how
    // you check it before publishing.
    { header: "url", value: (p) => c.dim(pageUrl(CLOUD_URL, p)) },
  ];

  println(
    `${c.bold(org.displayName)} ${c.dim(`· ${pages.length} status page${pages.length === 1 ? "" : "s"}`)}`,
  );
  println();
  printTable(pages, columns);

  const live = pages.filter((p) => p.published).length;
  println();
  println(
    c.dim(
      live === 0
        ? "Nothing is published. A page is reachable only once you publish it."
        : `${live} page${live === 1 ? " is" : "s are"} readable by anyone with the link.`,
    ),
  );
}

function printPageDetail(ctx: CliContext, page: StatusPage): void {
  if (ctx.flags.output === "json") {
    printJson(page);
    return;
  }

  println(`${c.bold(page.title)} ${page.published ? c.green("· live") : c.dim("· draft")}`);
  if (page.description) println(c.dim(page.description));
  println();
  println(`${c.dim("url")}  ${pageUrl(CLOUD_URL, page)}`);
  println(
    `${c.dim("shows")}  ${
      [page.showUptime ? "24h uptime" : null, page.showHistory ? "90d history" : null]
        .filter(Boolean)
        .join(", ") || "current state only"
    }`,
  );

  if (page.components.length === 0) {
    println();
    println(c.dim("No components — this page publishes nothing."));
    return;
  }

  println();
  printTable(page.components, [
    { header: "public name", value: (comp) => comp.label ?? comp.probeName },
    { header: "group", value: (comp) => c.dim(comp.groupName ?? "—") },
    { header: "probe", value: (comp) => c.dim(comp.probeName) },
    {
      header: "state",
      value: (comp) =>
        !comp.probeEnabled
          ? c.dim("○ paused")
          : comp.probeStatus === "up"
            ? c.green("● up")
            : comp.probeStatus === "down"
              ? c.red("● down")
              : c.yellow("● pending"),
    },
  ]);

  const paused = page.components.filter((comp) => !comp.probeEnabled).length;
  if (paused > 0) {
    println();
    println(
      c.dim(
        `${paused} probe${paused === 1 ? "" : "s"} paused — those components show as "No data" to visitors.`,
      ),
    );
  }
}
