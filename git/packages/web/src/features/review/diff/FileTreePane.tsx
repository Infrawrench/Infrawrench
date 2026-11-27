/**
 * The changed files as a tree, drawn by `@pierre/trees` (Apache-2.0): folders
 * with one folder in them fold into one row, a file carries how it changed
 * and its added and removed lines, and picking one goes to it in the diff.
 *
 * Lazy, like the diff beside it (`LazyFileTree`); nothing else imports it.
 */
import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { DiffFile } from "@infrawrench/git-contract";

export interface FileTreePaneProps {
  readonly files: ReadonlyArray<DiffFile>;
  /** The files with something on them, and whether it is something that must be fixed. */
  readonly marked?: ReadonlyMap<string, "must_fix" | "noted">;
  readonly onPick: (path: string) => void;
}

const STATUS: Record<DiffFile["status"], GitStatusEntry["status"]> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  copied: "added",
  type_changed: "modified",
};

const ROW_HEIGHT = 26;

/** The tree on the page's tokens: its surface, text, selection and status colours. */
const STYLE = {
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--color-on-surface-secondary)",
  "--trees-fg-muted-override": "var(--color-on-surface-muted)",
  "--trees-bg-muted-override": "var(--color-surface-sunken)",
  "--trees-selected-bg-override": "var(--color-surface-sunken)",
  "--trees-selected-fg-override": "var(--color-on-surface)",
  "--trees-border-color-override": "var(--color-border)",
  "--trees-accent-override": "var(--color-accent)",
  "--trees-focus-ring-color-override": "var(--color-accent)",
  "--trees-status-added-override": "var(--color-success)",
  "--trees-status-deleted-override": "var(--color-danger)",
  "--trees-status-modified-override": "var(--color-warning)",
  "--trees-status-renamed-override": "var(--color-notice)",
  "--trees-font-size-override": "12px",
  "--trees-padding-inline-override": 0,
  "--trees-density-override": 0.8,
} as CSSProperties;

const NO_MARKS: ReadonlyMap<string, "must_fix" | "noted"> = new Map();

export default function FileTreePane({ files, marked = NO_MARKS, onPick }: FileTreePaneProps) {
  const marks = useRef(marked);
  marks.current = marked;
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  // The model is made once and reads these through refs, so it always has the newest.
  const lookup = useRef(byPath);
  lookup.current = byPath;
  const pick = useRef(onPick);
  pick.current = onPick;
  const pathList = useMemo(() => files.map((file) => file.path), [files]);
  const statuses = useMemo(
    () => files.map((file) => ({ path: file.path, status: STATUS[file.status] })),
    [files],
  );

  const { model } = useFileTree({
    paths: pathList,
    gitStatus: statuses,
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    search: false,
    stickyFolders: true,
    itemHeight: ROW_HEIGHT,
    onSelectionChange: (selected) => {
      const [path] = selected;
      if (selected.length === 1 && path !== undefined && lookup.current.has(path)) {
        pick.current(path);
      }
    },
    renderRowDecoration: ({ item }) => {
      const file = item.kind === "file" ? lookup.current.get(item.path) : undefined;
      if (file === undefined) return null;
      const mark = marks.current.get(file.path);
      const parts = [
        // A dot on a file with something on it: red when it must be fixed.
        ...(mark === undefined
          ? []
          : [
              {
                text: "\u25cf",
                color: mark === "must_fix" ? "var(--color-danger)" : "var(--color-notice)",
              },
            ]),
        ...(file.binary || file.additions === 0
          ? []
          : [{ text: `+${file.additions}`, color: "var(--color-success)" }]),
        ...(file.binary || file.deletions === 0
          ? []
          : [{ text: `-${file.deletions}`, color: "var(--color-danger)" }]),
      ];
      if (parts.length === 0) return null;
      return {
        text: parts.map((part) => part.text).join(" "),
        parts: parts.flatMap((part, index) => (index === 0 ? [part] : [{ text: " " }, part])),
      };
    },
  });

  // More files arrive as the diff's pages load.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    model.resetPaths(pathList);
    model.setGitStatus(statuses);
  }, [model, pathList, statuses, marked]);

  // Every row shows: the list scrolls with its column, not inside itself.
  return (
    <FileTree
      model={model}
      aria-label="Changed files"
      style={{ ...STYLE, display: "block", height: "100%" }}
    />
  );
}
