/**
 * Importing a repository's issues from another host (Settings > Import).
 * An import is a row that a background job works through a page at a time;
 * these are its shapes on the API. The source's token goes in once and never
 * comes back out.
 */
import { Schema } from "effect";
import { IsoDateTime } from "./common";
import { UserRef } from "./people";

export const IMPORT_SOURCES = ["github"] as const;
export const ImportSource = Schema.Literals(IMPORT_SOURCES).annotate({
  identifier: "ImportSource",
});
export type ImportSource = typeof ImportSource.Type;

export const ISSUE_IMPORT_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export const IssueImportStatus = Schema.Literals(ISSUE_IMPORT_STATUSES).annotate({
  identifier: "IssueImportStatus",
});
export type IssueImportStatus = typeof IssueImportStatus.Type;

export const ISSUE_IMPORT_PHASES = [
  "labels",
  "milestones",
  "issues",
  "comments",
  "finish",
] as const;
export const IssueImportPhase = Schema.Literals(ISSUE_IMPORT_PHASES).annotate({
  identifier: "IssueImportPhase",
  description: "What the import is reading now, in this order.",
});
export type IssueImportPhase = typeof IssueImportPhase.Type;

/** Where an imported issue or comment came from, on the views that show one. */
export const ImportedFrom = Schema.Struct({
  source: ImportSource,
  author: Schema.NullOr(Schema.String).annotate({
    description: "Who wrote it there: their login at the source.",
  }),
  url: Schema.NullOr(Schema.String).annotate({ description: "Its page at the source." }),
  number: Schema.NullOr(Schema.Int).annotate({
    description:
      "An issue's number at the source. It differs from the issue's number here when that one was taken. Null on a comment.",
  }),
}).annotate({ identifier: "ImportedFrom" });
export type ImportedFrom = typeof ImportedFrom.Type;

export const IssueImport = Schema.Struct({
  id: Schema.String,
  source: ImportSource,
  repository: Schema.String.annotate({
    description: "`owner/name` at the source.",
    examples: ["acme/widgets"],
  }),
  status: IssueImportStatus,
  phase: IssueImportPhase,
  counts: Schema.Struct({
    labels: Schema.Int,
    milestones: Schema.Int,
    issues: Schema.Int,
    comments: Schema.Int,
  }).annotate({ description: "What has been read and written so far." }),
  error: Schema.NullOr(Schema.String).annotate({ description: "Why it failed." }),
  resumeAt: Schema.NullOr(IsoDateTime).annotate({
    description: "It is waiting for the source's rate limit, which resets then.",
  }),
  startedBy: Schema.NullOr(UserRef),
  createdAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "IssueImport" });
export type IssueImport = typeof IssueImport.Type;

/** `owner/name`, as GitHub spells both halves. */
export const SOURCE_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export const IssueImportCreate = Schema.Struct({
  source: ImportSource,
  repository: Schema.String.check(Schema.isMaxLength(141)).annotate({
    description: "`owner/name` at the source.",
  }),
  token: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
    description:
      "A token that can read the source repository's issues. Kept sealed while the import runs and removed when it ends.",
  }),
}).annotate({ identifier: "IssueImportCreate" });
export type IssueImportCreate = typeof IssueImportCreate.Type;
