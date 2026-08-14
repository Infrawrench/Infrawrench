import { useEffect, useRef, useState } from "react";
import { useGT } from "gt-react";
import { ToolsIcon } from "../icons/ToolsIcon.js";

/**
 * The org-level tools — Agents, Workflows, Deploy, and friends. They used to
 * render as an icon grid pinned above the dashboard list (SidebarNavGrid),
 * but the grid stopped scaling past twenty tiles: every tool cost sidebar
 * height whether or not it was wanted. Now the sidebar carries a single
 * "Tools" button and the tools live in a searchable launcher overlay.
 *
 * Shared by web and desktop; each platform builds its own tool list because
 * navigation differs (web routes, desktop workspace tabs), so a tool's
 * navigation is an opaque `onClick` closure, same contract as the old grid.
 */
export interface SidebarToolDef {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

const GRID_COLUMNS = 4;

export function SidebarToolsButton({ tools }: { tools: SidebarToolDef[] }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-2 mb-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors"
      >
        <span className="flex items-center justify-center opacity-60" aria-hidden="true">
          <ToolsIcon />
        </span>
        {gt("Tools")}
      </button>
      {open && <SidebarToolsLauncher tools={tools} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The launcher overlay: a search field over a grid of every tool. Follows
 * SpotlightSearch's dialog conventions — native `<dialog>`/`showModal()` for
 * the top layer and focus containment, focus held in the input with an
 * `aria-activedescendant` listbox underneath, Escape via the cancel event,
 * backdrop mousedown to dismiss.
 */
export function SidebarToolsLauncher({
  tools,
  onClose,
}: {
  tools: SidebarToolDef[];
  onClose: () => void;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed ? tools.filter((t) => t.label.toLowerCase().includes(trimmed)) : tools;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    inputRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (e.target === dialog) onClose();
    };
    dialog.addEventListener("mousedown", handleMouseDown);
    return () => dialog.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  // Keep the selection on the grid whenever the filter shrinks it away.
  const clampedIndex = Math.min(selectedIndex, Math.max(filtered.length - 1, 0));

  function activate(tool: SidebarToolDef) {
    tool.onClick();
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const last = filtered.length - 1;
    if (last < 0) return;
    // Arrow keys walk the grid: left/right by one, up/down by a row. A down
    // move from the last partial row clamps onto the final tool rather than
    // dead-ending, so every tool stays reachable from the keyboard.
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setSelectedIndex(Math.min(clampedIndex + 1, last));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSelectedIndex(Math.max(clampedIndex - 1, 0));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(Math.min(clampedIndex + GRID_COLUMNS, last));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(Math.max(clampedIndex - GRID_COLUMNS, 0));
    } else if (e.key === "Enter") {
      const tool = filtered[clampedIndex];
      if (tool) activate(tool);
    }
  }

  useEffect(() => {
    const el = gridRef.current?.querySelector(`[data-idx="${clampedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={gt("Tools")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="mx-auto mt-[15vh] mb-auto p-0 w-[420px] max-w-[90vw] bg-surface-raised text-inherit border border-border-strong rounded-2xl shadow-2xl overflow-hidden open:flex flex-col backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      style={{ maxHeight: "65vh" }}
    >
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
        <span aria-hidden="true" className="text-on-surface-muted flex-shrink-0">
          <ToolsIcon />
        </span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={gt("Search tools…")}
          aria-label={gt("Search tools")}
          role="combobox"
          aria-expanded={filtered.length > 0}
          aria-controls="sidebar-tools-grid"
          aria-autocomplete="list"
          aria-activedescendant={
            filtered[clampedIndex] ? `sidebar-tools-option-${clampedIndex}` : undefined
          }
          className="flex-1 bg-transparent text-on-surface placeholder:text-on-surface-faint text-sm focus:outline-none"
        />
        <kbd className="text-xs text-on-surface-faint flex-shrink-0">esc</kbd>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {filtered.length === 1 ? gt("1 tool") : gt("{n} tools", { n: filtered.length })}
      </div>

      {filtered.length === 0 && (
        <div className="flex flex-1 items-center justify-center py-12 text-sm text-on-surface-faint">
          {gt("No tools match “{query}”", { query })}
        </div>
      )}
      <div
        ref={gridRef}
        id="sidebar-tools-grid"
        role="listbox"
        aria-label={gt("Tools")}
        className={
          filtered.length === 0
            ? "hidden"
            : "grid grid-cols-4 gap-1 p-3 overflow-y-auto flex-1 content-start"
        }
      >
        {filtered.map((tool, idx) => {
          const isSelected = idx === clampedIndex;
          return (
            <div
              key={tool.key}
              id={`sidebar-tools-option-${idx}`}
              role="option"
              tabIndex={-1}
              aria-selected={isSelected}
              data-idx={idx}
              onClick={() => activate(tool)}
              onMouseEnter={() => setSelectedIndex(idx)}
              className={`flex flex-col items-center gap-1.5 rounded-lg px-1 py-2.5 cursor-pointer transition-colors ${
                isSelected
                  ? "bg-surface-overlay text-on-surface"
                  : "text-on-surface-secondary hover:bg-surface-overlay"
              }`}
            >
              <span
                aria-hidden="true"
                className="flex h-6 items-center justify-center opacity-70 [&_svg]:h-[18px] [&_svg]:w-[18px]"
              >
                {tool.icon}
              </span>
              <span className="w-full truncate text-center text-[11px] leading-tight">
                {tool.label}
              </span>
            </div>
          );
        })}
      </div>

      {filtered.length > 0 && (
        <div className="px-4 py-2 border-t border-border flex items-center gap-4 text-xs text-on-surface-faint">
          <span>&uarr;&darr;&larr;&rarr; {gt("navigate")}</span>
          <span>&#8629; {gt("open")}</span>
          <span>esc close</span>
        </div>
      )}
    </dialog>
  );
}
