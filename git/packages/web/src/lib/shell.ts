/**
 * The column a page sits in, beside the sidebar: the window's width with the
 * bar's gutters, or a centred narrow column for a form.
 */
export const pageColumn = (width: "wide" | "narrow" = "wide"): string =>
  width === "narrow"
    ? "mx-auto w-full max-w-2xl px-4 py-5"
    : "mx-auto w-full max-w-[112rem] px-4 py-6 md:px-10";
