// `infrawrench issues`: every finding filed as an issue, across Jira, Linear
// and GitHub, with the issue's live status (status, tracker-neutral category,
// assignee, last change). Unfinished issues first.
//
// Cloud-only and read-only: filing happens from the finding's row, where the
// evidence is on screen. A tracker the caller cannot read (no `:read`
// permission, or not connected) is skipped rather than failing the listing.
// Types come from `@infrawrench/client-core`, type-only, so the CLI takes no
// new runtime dependency.
import { orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  GithubIssueLink,
  IssueStatusCategory,
  JiraIssueLink,
  LinearIssueLink,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

/** One filed issue, tracker-neutral: the `--json` shape. */
export interface FiledIssueRow {
  tracker: "jira" | "linear" | "github";
  issue: string;
  url: string;
  sourceKind: string;
  sourceId: string;
  status: string | null;
  statusCategory: IssueStatusCategory | null;
  assignee: string | null;
  issueUpdatedAt: string | null;
  statusSyncedAt: string | null;
  filedAt: string;
}

const CATEGORY_ORDER: Record<string, number> = {
  in_progress: 0,
  todo: 1,
  "": 2,
  done: 3,
  canceled: 4,
};

/** Unfinished first (in progress before to do), then newest filed. Pure. */
export function sortFiledIssues(rows: FiledIssueRow[]): FiledIssueRow[] {
  return [...rows].sort((a, b) => {
    const ca = CATEGORY_ORDER[a.statusCategory ?? ""] ?? 2;
    const cb = CATEGORY_ORDER[b.statusCategory ?? ""] ?? 2;
    return ca !== cb ? ca - cb : b.filedAt.localeCompare(a.filedAt);
  });
}

function statusFields(link: {
  status?: string | null | undefined;
  statusCategory?: IssueStatusCategory | null | undefined;
  assignee?: string | null | undefined;
  issueUpdatedAt?: string | null | undefined;
  statusSyncedAt?: string | null | undefined;
}) {
  return {
    status: link.status ?? null,
    statusCategory: link.statusCategory ?? null,
    assignee: link.assignee ?? null,
    issueUpdatedAt: link.issueUpdatedAt ?? null,
    statusSyncedAt: link.statusSyncedAt ?? null,
  };
}

async function soft<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch {
    return [];
  }
}

function colourStatus(row: FiledIssueRow): string {
  const text = row.status ?? c.dim("unknown");
  switch (row.statusCategory) {
    case "in_progress":
      return c.cyan(text);
    case "done":
      return c.green(text);
    case "canceled":
      return c.dim(text);
    default:
      return text;
  }
}

export async function cmdIssues(ctx: CliContext, tracker?: string): Promise<void> {
  const org = await resolveOrg(ctx);
  const want = (t: string) => !tracker || tracker === t;
  const [jira, linear, github] = await Promise.all([
    want("jira") ? soft(() => orgFetch<JiraIssueLink[]>(org.id, "/jira/links")) : [],
    want("linear") ? soft(() => orgFetch<LinearIssueLink[]>(org.id, "/linear/links")) : [],
    want("github") ? soft(() => orgFetch<GithubIssueLink[]>(org.id, "/github-issues/links")) : [],
  ]);
  const rows = sortFiledIssues([
    ...jira.map((l): FiledIssueRow => ({
      tracker: "jira",
      issue: l.issueKey,
      url: l.issueUrl,
      sourceKind: l.sourceKind,
      sourceId: l.sourceId,
      ...statusFields(l),
      filedAt: l.createdAt,
    })),
    ...linear.map((l): FiledIssueRow => ({
      tracker: "linear",
      issue: l.issueIdentifier,
      url: l.issueUrl,
      sourceKind: l.sourceKind,
      sourceId: l.sourceId,
      ...statusFields(l),
      filedAt: l.createdAt,
    })),
    ...github.map((l): FiledIssueRow => ({
      tracker: "github",
      issue: `${l.repo}#${l.issueNumber}`,
      url: l.issueUrl,
      sourceKind: l.sourceKind,
      sourceId: l.sourceId,
      ...statusFields(l),
      filedAt: l.createdAt,
    })),
  ]);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, issues: rows });
    return;
  }
  if (rows.length === 0) {
    println(c.dim("Nothing has been filed as an issue yet."));
    return;
  }
  const open = rows.filter((r) => r.statusCategory !== "done" && r.statusCategory !== "canceled");
  println(`${c.bold(org.displayName)} ${c.dim(`· ${open.length} open · ${rows.length} filed`)}`);
  println();
  const columns: Column<FiledIssueRow>[] = [
    { header: "tracker", value: (r) => r.tracker },
    { header: "issue", value: (r) => r.issue },
    { header: "status", value: colourStatus },
    { header: "assignee", value: (r) => r.assignee ?? c.dim("-") },
    { header: "finding", value: (r) => r.sourceKind.replace(/_/g, " ") },
    { header: "updated", value: (r) => c.dim((r.issueUpdatedAt ?? r.filedAt).slice(0, 10)) },
  ];
  printTable(rows, columns);
}
