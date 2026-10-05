// `infrawrench github-issues`: findings filed as GitHub issues (open first),
// and `infrawrench github-issues settings`: the routing document plus whether
// each GitHub App installation has accepted the permissions filing needs.
//
// Cloud-only: filing runs on the server's GitHub App. Read-only here; filing
// and pull requests happen from the Savings rows (or a routing rule), where
// the evidence is on screen. Types come from `@infrawrench/client-core`,
// type-only, so the CLI takes no new runtime dependency.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import type { GithubIssueLink, GithubIssuesStatus } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, type Column } from "../output";

export async function cmdGithubIssues(ctx: CliContext): Promise<void> {
  const org = await resolveOrg(ctx);
  const links = await orgFetch<GithubIssueLink[]>(org.id, "/github-issues/links");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, links });
    return;
  }
  if (links.length === 0) {
    println(c.dim("Nothing has been filed as a GitHub issue yet."));
    return;
  }
  const ordered = [...links].sort((a, b) =>
    a.state === b.state ? b.createdAt.localeCompare(a.createdAt) : a.state === "open" ? -1 : 1,
  );
  const open = links.filter((l) => l.state === "open").length;
  println(`${c.bold(org.displayName)} ${c.dim(`· ${open} open · ${links.length} filed`)}`);
  println();
  const columns: Column<GithubIssueLink>[] = [
    { header: "issue", value: (l) => `${l.repo}#${l.issueNumber}` },
    { header: "state", value: (l) => (l.state === "open" ? c.green("open") : c.dim("closed")) },
    { header: "finding", value: (l) => l.sourceKind.replace(/_/g, " ") },
    { header: "by", value: (l) => (l.autoFiled ? c.dim("rule") : "person") },
    { header: "pr", value: (l) => (l.pullRequestNumber ? `#${l.pullRequestNumber}` : c.dim("—")) },
    { header: "filed", value: (l) => c.dim(l.createdAt.slice(0, 10)) },
  ];
  printTable(ordered, columns);
}

export async function cmdGithubIssueSettings(ctx: CliContext): Promise<void> {
  const org = await resolveOrg(ctx);
  const status = await orgFetch<GithubIssuesStatus>(org.id, "/github-issues");

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...status });
    return;
  }
  const s = status.settings;
  println(
    `${c.bold(org.displayName)} ${c.dim("·")} filing ${s.enabled ? c.green("on") : c.dim("off")} ${c.dim(
      "·",
    )} pull requests ${s.pullRequestsEnabled ? c.green("on") : c.dim("off")}`,
  );
  if (!status.appConfigured) println(c.yellow("This server has no GitHub App configured."));
  println(`default repository  ${s.defaultRepo?.fullName ?? c.dim("none")}`);
  println(`labels              ${s.labels.join(", ") || c.dim("none")}`);
  println(`assignees           ${s.assignees.join(", ") || c.dim("none")}`);
  println(`when resolved       ${s.resolveAction}`);
  if (s.routes.length > 0) {
    println();
    println(c.bold("routes (first match wins)"));
    for (const r of s.routes) {
      const match =
        r.match.kind === "tag"
          ? `tag ${r.match.tagKey}${r.match.tagValue ? `=${r.match.tagValue}` : ""}`
          : `cost centre ${r.match.costCentreId}`;
      println(`  ${match} → ${r.repo.fullName}`);
    }
  }
  if (s.iacSources.length > 0) {
    println();
    println(c.bold("terraform sources"));
    for (const x of s.iacSources) {
      println(
        `  ${x.iacAccountId ?? "org-wide state"} → ${x.repo.fullName}/${x.directory || "."} @ ${x.baseBranch ?? "default branch"}`,
      );
    }
  }
  println();
  println(c.bold("installations"));
  for (const i of status.installations) {
    const ok = (lvl: string) => (lvl === "write" || lvl === "admin" ? c.green(lvl) : c.yellow(lvl));
    println(
      `  ${i.accountLogin ?? i.installationId}  issues ${ok(i.issues)}  contents ${ok(i.contents)}  pull requests ${ok(i.pullRequests)}${
        i.checked ? "" : c.dim("  (could not ask GitHub)")
      }`,
    );
    if (i.checked && i.issues !== "write" && i.manageUrl) {
      println(c.dim(`    approve the app's updated permissions: ${i.manageUrl}`));
    }
  }
}
