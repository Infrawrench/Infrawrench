// `infrawrench issues`: every finding filed as an issue, across Jira, Linear
// and GitHub, with the issue's live status (status, tracker-neutral category,
// assignee, last change). Unfinished issues first.
//
// Cloud-only and read-only: filing happens from the finding's row, where the
// evidence is on screen. A tracker the caller cannot read (no `:read`
// permission, or not connected) is skipped rather than failing the listing.
// Types come from `@infrawrench/client-core`, type-only, so the CLI takes no
// new runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type {
  GithubIssueLink,
  IssueStatusCategory,
  JiraIssueLink,
  LinearIssueLink,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { wire } from "../effect/wire";
import { c, type Column } from "../output";

/** One filed issue, tracker-neutral: the `--json` shape. */
export interface FiledIssueRow {
  tracker: "jira" | "linear" | "github";
  issue: string;
  url: string;
  sourceKind: string;
  sourceId: string;
  status: string | null;
  /** An `IssueStatusCategory`; a category a newer server adds passes through as sent. */
  statusCategory: IssueStatusCategory | (string & {}) | null;
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

// The status columns every tracker's link row carries; all optional until
// the first sync.
const statusColumns = {
  sourceKind: Schema.String,
  sourceId: Schema.String,
  issueUrl: Schema.String,
  createdAt: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  statusCategory: Schema.optional(Schema.NullOr(Schema.String)),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
  issueUpdatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  statusSyncedAt: Schema.optional(Schema.NullOr(Schema.String)),
};

const JiraLinks = wire<JiraIssueLink[]>()(
  Schema.Array(Schema.Struct({ ...statusColumns, issueKey: Schema.String })),
);
const LinearLinks = wire<LinearIssueLink[]>()(
  Schema.Array(Schema.Struct({ ...statusColumns, issueIdentifier: Schema.String })),
);
const GithubLinks = wire<GithubIssueLink[]>()(
  Schema.Array(
    Schema.Struct({ ...statusColumns, repo: Schema.String, issueNumber: Schema.Finite }),
  ),
);

function statusFields(link: {
  status?: string | null | undefined;
  statusCategory?: string | null | undefined;
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

const TRACKERS = ["jira", "linear", "github"] as const;
type Tracker = (typeof TRACKERS)[number];

/**
 * One tracker's links as rows, or none: a tracker the caller cannot read
 * (no `:read` permission, not connected, any failure at all) is skipped
 * rather than failing the listing.
 */
const trackerRows = Effect.fnUntraced(function* (orgId: string, tracker: Tracker) {
  const api = yield* CloudApi;
  switch (tracker) {
    case "jira": {
      const path = "/jira/links";
      const links = yield* api.json(orgId, path).pipe(Effect.flatMap(decodeBody(JiraLinks, path)));
      return links.map((l): FiledIssueRow => ({
        tracker: "jira",
        issue: l.issueKey,
        url: l.issueUrl,
        sourceKind: l.sourceKind,
        sourceId: l.sourceId,
        ...statusFields(l),
        filedAt: l.createdAt,
      }));
    }
    case "linear": {
      const path = "/linear/links";
      const links = yield* api
        .json(orgId, path)
        .pipe(Effect.flatMap(decodeBody(LinearLinks, path)));
      return links.map((l): FiledIssueRow => ({
        tracker: "linear",
        issue: l.issueIdentifier,
        url: l.issueUrl,
        sourceKind: l.sourceKind,
        sourceId: l.sourceId,
        ...statusFields(l),
        filedAt: l.createdAt,
      }));
    }
    case "github": {
      const path = "/github-issues/links";
      const links = yield* api
        .json(orgId, path)
        .pipe(Effect.flatMap(decodeBody(GithubLinks, path)));
      return links.map((l): FiledIssueRow => ({
        tracker: "github",
        issue: `${l.repo}#${l.issueNumber}`,
        url: l.issueUrl,
        sourceKind: l.sourceKind,
        sourceId: l.sourceId,
        ...statusFields(l),
        filedAt: l.createdAt,
      }));
    }
  }
});

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

export const issues = Command.make(
  "issues",
  {
    tracker: Argument.Literals("tracker", TRACKERS).pipe(
      Argument.withDescription("Only this tracker's issues"),
      Argument.optional,
    ),
  },
  Effect.fn("issues")(function* ({ tracker }) {
    const session = yield* CliSession;
    const org = yield* currentOrg;
    const wanted = TRACKERS.filter((t) => Option.isNone(tracker) || tracker.value === t);
    const perTracker = yield* Effect.forEach(
      wanted,
      (t) =>
        trackerRows(org.id, t).pipe(
          Effect.orElseSucceed((): FiledIssueRow[] => []),
          Effect.catchDefect(() => Effect.succeed<FiledIssueRow[]>([])),
        ),
      { concurrency: "unbounded" },
    );
    const rows = sortFiledIssues(perTracker.flat());

    if (session.output === "json") return yield* Print.json({ org: org.id, issues: rows });
    if (rows.length === 0) {
      return yield* Print.line(c.dim("Nothing has been filed as an issue yet."));
    }
    const open = rows.filter((r) => r.statusCategory !== "done" && r.statusCategory !== "canceled");
    yield* Print.line(
      `${c.bold(org.displayName)} ${c.dim(`· ${open.length} open · ${rows.length} filed`)}`,
    );
    yield* Print.line();
    const columns: Column<FiledIssueRow>[] = [
      { header: "tracker", value: (r) => r.tracker },
      { header: "issue", value: (r) => r.issue },
      { header: "status", value: colourStatus },
      { header: "assignee", value: (r) => r.assignee ?? c.dim("-") },
      { header: "finding", value: (r) => r.sourceKind.replace(/_/g, " ") },
      { header: "updated", value: (r) => c.dim((r.issueUpdatedAt ?? r.filedAt).slice(0, 10)) },
    ];
    yield* Print.table(rows, columns);
  }),
).pipe(
  Command.withDescription(
    "Findings filed to Jira, Linear and GitHub with each issue's live status, unfinished first",
  ),
);
