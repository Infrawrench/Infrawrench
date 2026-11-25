/**
 * The search box of the issue and pull request lists: `is:open label:bug
 * author:mara flow logs`. The text is the whole state of the list (it is the
 * `?q=` of the URL), so the filter menus edit it rather than keeping state of
 * their own.
 */

export type SearchState = "open" | "closed" | "merged" | "all";
export type SearchSort = "created" | "updated" | "comments";

export interface ThreadSearch {
  readonly state: SearchState;
  readonly author: string | null;
  /** A username, `@me`, or `none` for `no:assignee`. */
  readonly assignee: string | null;
  readonly labels: ReadonlyArray<string>;
  /** A milestone's title, or `none` for `no:milestone`. */
  readonly milestone: string | null;
  readonly draft: boolean | null;
  readonly reviewer: string | null;
  readonly base: string | null;
  readonly head: string | null;
  readonly sort: SearchSort;
  readonly direction: "asc" | "desc";
  /** Everything that is not a qualifier: words to find in the title and body. */
  readonly words: string;
}

export const EMPTY_SEARCH: ThreadSearch = {
  state: "all",
  author: null,
  assignee: null,
  labels: [],
  milestone: null,
  draft: null,
  reviewer: null,
  base: null,
  head: null,
  sort: "created",
  direction: "desc",
  words: "",
};

/** What a list shows when its URL has no `?q=`. */
export const DEFAULT_SEARCH_TEXT = "is:open";

/** The text split on spaces, keeping a quoted value (`label:"good first issue"`) whole. */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (/\s/.test(char) && !quoted) {
      if (current !== "") tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value.replace(/"/g, "");

const SORTS: ReadonlyArray<SearchSort> = ["created", "updated", "comments"];

export function parseSearch(text: string): ThreadSearch {
  const search = { ...EMPTY_SEARCH, labels: [] as string[] };
  const words: string[] = [];
  for (const token of tokenize(text)) {
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? unquote(token.slice(colon + 1)) : "";
    if (key === "" || value === "") {
      words.push(token);
      continue;
    }
    const lower = value.toLowerCase();
    switch (key) {
      case "is":
      case "state":
        if (lower === "open" || lower === "closed" || lower === "merged") search.state = lower;
        else if (lower === "draft") search.draft = true;
        else if (lower !== "issue" && lower !== "pr" && lower !== "all") words.push(token);
        break;
      case "draft":
        if (lower === "true" || lower === "false") search.draft = lower === "true";
        else words.push(token);
        break;
      case "author":
        search.author = value;
        break;
      case "assignee":
        search.assignee = value;
        break;
      case "label":
        if (!search.labels.includes(value)) search.labels.push(value);
        break;
      case "milestone":
        search.milestone = value;
        break;
      case "no":
        if (lower === "assignee") search.assignee = "none";
        else if (lower === "milestone") search.milestone = "none";
        else words.push(token);
        break;
      case "reviewed-by":
        search.reviewer = value;
        break;
      case "base":
        search.base = value;
        break;
      case "head":
        search.head = value;
        break;
      case "sort": {
        const [field, direction] = lower.split("-");
        if (SORTS.includes(field as SearchSort) && (direction ?? "desc").match(/^(asc|desc)$/)) {
          search.sort = field as SearchSort;
          search.direction = direction === "asc" ? "asc" : "desc";
        } else words.push(token);
        break;
      }
      default:
        words.push(token);
    }
  }
  return { ...search, words: words.join(" ") };
}

const quote = (value: string): string => (/\s/.test(value) ? `"${value}"` : value);

/** The search as text, qualifiers in a fixed order, so the same search is always the same URL. */
export function formatSearch(search: ThreadSearch): string {
  const parts: string[] = [];
  if (search.state !== "all") parts.push(`is:${search.state}`);
  if (search.draft !== null) parts.push(search.draft ? "is:draft" : "draft:false");
  if (search.author !== null) parts.push(`author:${quote(search.author)}`);
  if (search.assignee === "none") parts.push("no:assignee");
  else if (search.assignee !== null) parts.push(`assignee:${quote(search.assignee)}`);
  for (const label of search.labels) parts.push(`label:${quote(label)}`);
  if (search.milestone === "none") parts.push("no:milestone");
  else if (search.milestone !== null) parts.push(`milestone:${quote(search.milestone)}`);
  if (search.reviewer !== null) parts.push(`reviewed-by:${quote(search.reviewer)}`);
  if (search.base !== null) parts.push(`base:${quote(search.base)}`);
  if (search.head !== null) parts.push(`head:${quote(search.head)}`);
  if (search.sort !== "created" || search.direction !== "desc") {
    parts.push(`sort:${search.sort}-${search.direction}`);
  }
  if (search.words !== "") parts.push(search.words);
  return parts.join(" ");
}

/** `text` with some of its search replaced: what a filter menu's pick does. */
export function editSearch(text: string, patch: Partial<ThreadSearch>): string {
  return formatSearch({ ...parseSearch(text), ...patch });
}

/** Whether anything but the state narrows the list: there is something to clear. */
export function isFiltered(search: ThreadSearch): boolean {
  return formatSearch({ ...search, state: "all" }) !== "";
}

export interface ThreadListQuery {
  state: SearchState;
  label?: string;
  assignee?: string;
  author?: string;
  milestone?: string;
  q?: string;
  sort?: SearchSort;
  direction?: "asc" | "desc";
  draft?: "true" | "false";
  reviewer?: string;
  base?: string;
  head?: string;
}

/**
 * The search as the list endpoints take it. A milestone is named by its title
 * in the box and by its number in the API; a title nothing has becomes a
 * number nothing has, so the list is empty rather than unfiltered.
 */
export function toListQuery(
  search: ThreadSearch,
  milestones: ReadonlyArray<{ readonly number: number; readonly title: string }>,
): ThreadListQuery {
  const query: ThreadListQuery = { state: search.state };
  if (search.labels.length > 0) query.label = search.labels.join(",");
  if (search.assignee !== null) query.assignee = search.assignee;
  if (search.author !== null) query.author = search.author;
  if (search.milestone === "none") query.milestone = "none";
  else if (search.milestone !== null) {
    const wanted = search.milestone.toLowerCase();
    const found = milestones.find((item) => item.title.toLowerCase() === wanted);
    query.milestone = String(found?.number ?? 0);
  }
  if (search.words !== "") query.q = search.words;
  if (search.sort !== "created") query.sort = search.sort;
  if (search.direction !== "desc") query.direction = search.direction;
  if (search.draft !== null) query.draft = search.draft ? "true" : "false";
  if (search.reviewer !== null) query.reviewer = search.reviewer;
  if (search.base !== null) query.base = search.base;
  if (search.head !== null) query.head = search.head;
  return query;
}
