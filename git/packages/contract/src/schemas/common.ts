/**
 * Schemas every group shares: ids, timestamps, path params and the one
 * pagination style.
 *
 * **Pagination is a cursor.** A list takes `?cursor=&limit=` and answers
 * `{ items, nextCursor }`; `nextCursor` is null on the last page and is
 * otherwise opaque (send it back as it came). Lists a person pages through by
 * count (issues, branch pages) also answer the counts their tabs show.
 */
import { Schema } from "effect";

/** A UUID. Documented, not checked: an id that is not one finds nothing (404). */
export const Uuid = Schema.String.annotate({
  format: "uuid",
  examples: ["00000000-0000-0000-0000-000000000000"],
});
export type Uuid = typeof Uuid.Type;

/** An ISO-8601 timestamp. */
export const IsoDateTime = Schema.String.annotate({ format: "date-time" });
export type IsoDateTime = typeof IsoDateTime.Type;

export const VISIBILITIES = ["public", "private"] as const;
export const Visibility = Schema.Literals(VISIBILITIES).annotate({ identifier: "Visibility" });
export type Visibility = typeof Visibility.Type;

/** `{ ok: true }`, what every delete and fire-and-forget write answers. */
export const Ok = Schema.Struct({ ok: Schema.Literal(true) }).annotate({ identifier: "Ok" });
export type Ok = typeof Ok.Type;
export const ok = { ok: true } as const;

/** A full SHA-1 object id: 40 lowercase hex characters. */
export const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).annotate({
  identifier: "Oid",
  description: "A Git object id: 40 lowercase hex characters.",
  examples: ["3b18e512dba79e4c8300dd08aeb37f8e728b8dad"],
});
export type Oid = typeof Oid.Type;

/**
 * A commit named the way a person names one: a full or abbreviated object id
 * (4 to 40 hex characters) in a path. Not a ref name; those travel as `ref`
 * query parameters because they contain slashes.
 */
export const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-fA-F]{4,40}$/)).annotate({
  description: "A full or abbreviated commit id.",
});
export type CommitSha = typeof CommitSha.Type;

/** A namespace slug: a username or an organisation's name. Rules in `names.ts`. */
export const NamespaceSlug = Schema.String.annotate({
  description: "A username or an organisation's namespace. Case-insensitive.",
  examples: ["acme"],
});
export type NamespaceSlug = typeof NamespaceSlug.Type;

export const RepositoryName = Schema.String.annotate({
  description: "A repository's name within its namespace. Case-insensitive.",
  examples: ["infra"],
});
export type RepositoryName = typeof RepositoryName.Type;

/** `:owner/:repo`, the start of every repository path. */
export const RepoParams = { owner: NamespaceSlug, repo: RepositoryName } as const;

/** An issue or branch page number; the two share one sequence per repository. */
export const ThreadNumber = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
).annotate({ description: "Issue or branch page number." });
export type ThreadNumber = typeof ThreadNumber.Type;

export const NumberParams = { ...RepoParams, number: ThreadNumber } as const;

/**
 * What names a branch's page in a path and in a link: the branch's name
 * (`feature/a`), `owner/name:branch` for a fork's branch proposed to this
 * repository, and either with `~2`, `~3`... for an earlier page of a name
 * that was used again (the bare name is the open page, or the newest). A
 * branch name holds neither `:` nor `~`, so nothing is escaped inside it;
 * in a path it is one segment, percent-encoded (`feature%2Fa`).
 */
export const BranchKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(600),
).annotate({
  description:
    "A branch's name, `owner/name:branch` for a fork's branch proposed here, either with `~n` for an earlier page of a reused name. One path segment, percent-encoded.",
});
export type BranchKey = typeof BranchKey.Type;

export const BranchParams = { ...RepoParams, branch: BranchKey } as const;

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 30;

/** `?cursor=&limit=` on every list. */
export const PageQuery = {
  cursor: Schema.optionalKey(
    Schema.String.annotate({
      description: "`nextCursor` of the previous page. Omitted for the first.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_SIZE }),
    ).annotate({ description: `Page size, 1 to ${MAX_PAGE_SIZE}. Default ${DEFAULT_PAGE_SIZE}.` }),
  ),
} as const;

const NextCursor = Schema.NullOr(Schema.String).annotate({
  description: "Send as `cursor` for the next page. Null on the last page.",
});

/** One page of `item`. */
export const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: NextCursor });

/** `"true"` or `"false"` in a query string. */
export const QueryFlag = Schema.Literals(["true", "false"]);
export type QueryFlag = typeof QueryFlag.Type;

/** Ascending or descending, on lists that sort. */
export const SortDirection = Schema.Literals(["asc", "desc"]);
export type SortDirection = typeof SortDirection.Type;

/**
 * A ref as a person or a link names it: a branch (`main`, `feature/x`), a tag
 * (`v1.2.0`), a full ref (`refs/heads/main`) or a commit id. Omitted means the
 * default branch.
 */
export const RefQuery = Schema.optionalKey(
  Schema.String.annotate({
    description:
      "A branch, tag, full ref name or commit id. The default branch when omitted. A name that is both a branch and a tag reads as the branch.",
    examples: ["main"],
  }),
);
export type RefQuery = typeof RefQuery.Type;

/** A path inside the tree: no leading slash, `/` between segments, empty for the root. */
export const PathQuery = Schema.optionalKey(
  Schema.String.annotate({
    description: "Path from the repository root, without a leading slash. The root when omitted.",
    examples: ["src/index.ts"],
  }),
);
export type PathQuery = typeof PathQuery.Type;
