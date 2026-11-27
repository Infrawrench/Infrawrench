export type PageWidth = "wide" | "reading" | "narrow";

/**
 * The column a page sits in, beside the sidebar. All three start at the bar's
 * gutter, under the page's name:
 *
 * - `wide`: the window's width. Lists, tables, code and diffs, which read by
 *   the row and use the room.
 * - `reading`: a conversation and what sits beside it. It stops growing where
 *   a comment's lines would get too long to read.
 * - `narrow`: a centred column for a form.
 */
export const pageColumn = (width: PageWidth = "wide"): string =>
  width === "narrow"
    ? "mx-auto w-full max-w-2xl px-4 py-6"
    : width === "reading"
      ? "w-full max-w-[84rem] px-4 py-6 md:px-10"
      : "mx-auto w-full max-w-[112rem] px-4 py-6 md:px-10";
