/**
 * Which frame a page is drawn in. Inside the sidebar shell of agent mode a
 * page has the shell's bar to put its name and controls in, and the width of
 * the window; under the top nav it heads itself and sits in a centred column.
 */
import { createContext, useContext } from "react";

export const SidebarShellContext = createContext(false);

/** Whether the page is inside the sidebar shell. */
export const useSidebarShell = (): boolean => useContext(SidebarShellContext);

/** The column a page sits in: the window's width in the sidebar shell, centred under the top nav. */
export const pageColumn = (sidebar: boolean, width: "wide" | "narrow" = "wide"): string =>
  width === "narrow"
    ? "mx-auto w-full max-w-2xl px-4 py-5"
    : sidebar
      ? "mx-auto w-full max-w-[112rem] px-4 py-6 md:px-10"
      : "mx-auto w-full max-w-6xl px-4 py-5";
