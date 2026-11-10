import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { SidebarToolDef } from "../components/sidebar/SidebarTools.js";
import { useUIStore } from "../store/ui.store.js";
import { ProductIcon } from "./ProductIcon.js";
import { useProductCopy } from "./copy.js";
import {
  PRODUCTS,
  groupToolsByProduct,
  productForTool,
  showsInfrastructureSidebar,
  toolKeyForTabTarget,
} from "./registry.js";

const RECENT_LIMIT = 4;

function useActiveTabTarget() {
  return useUIStore(
    (s) => s.workspaceTabs.find((tab) => tab.id === s.activeWorkspaceTabId)?.target,
  );
}

/** Whether the sidebar shows the provider accounts tree right now. */
export function useShowsInfrastructureSidebar(): boolean {
  return showsInfrastructureSidebar(useActiveTabTarget());
}

function readRecent(storageKey: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The tools this person used most recently, newest first. A tool counts as
 * used when its tab becomes the active one, however it was opened (Home, the
 * launcher, a link, the command palette). Kept per `scope` (the organization,
 * or local mode) in this browser only: it is a convenience, not state anyone
 * else should see.
 */
export function useRecentTools(tools: SidebarToolDef[], scope: string): SidebarToolDef[] {
  const storageKey = `infrawrench-recent-tools:${scope}`;
  const [recent, setRecent] = useState<string[]>(() => readRecent(storageKey));
  const activeKey = toolKeyForTabTarget(useActiveTabTarget());

  useEffect(() => {
    setRecent(readRecent(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!activeKey) return;
    setRecent((current) => {
      if (current[0] === activeKey) return current;
      const next = [activeKey, ...current.filter((k) => k !== activeKey)].slice(0, RECENT_LIMIT);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage is unavailable (private window): the list lasts the session.
      }
      return next;
    });
  }, [activeKey, storageKey]);

  // A remembered tool this platform no longer offers is skipped, not shown
  // broken.
  return recent.flatMap((key) => tools.find((tool) => tool.key === key) ?? []);
}

/** The recently used tools, as sidebar rows. Renders nothing until one is used. */
export function SidebarRecentTools({ tools, scope }: { tools: SidebarToolDef[]; scope: string }) {
  const gt = useGT();
  const recent = useRecentTools(tools, scope);
  const activeKey = toolKeyForTabTarget(useActiveTabTarget());
  if (recent.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="px-3 py-1">
        <span className="text-xs font-medium uppercase tracking-wide text-on-surface-muted">
          {gt("Recent")}
        </span>
      </div>
      {recent.map((tool) => (
        <button
          key={tool.key}
          type="button"
          onClick={tool.onClick}
          aria-current={tool.key === activeKey ? "page" : undefined}
          className={`mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
            tool.key === activeKey
              ? "bg-surface-overlay text-on-surface"
              : "text-on-surface-tertiary hover:bg-surface-overlay hover:text-on-surface-secondary"
          }`}
        >
          <span
            aria-hidden="true"
            className="flex h-3.5 w-3.5 items-center justify-center opacity-60 [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            {tool.icon}
          </span>
          <span className="truncate">{tool.label}</span>
        </button>
      ))}
    </div>
  );
}

const ROW =
  "mx-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs transition-colors";
const ROW_IDLE =
  "text-on-surface-tertiary hover:bg-surface-overlay hover:text-on-surface-secondary";
const ROW_ACTIVE = "bg-surface-overlay text-on-surface";

function ToolRow({ tool, active }: { tool: SidebarToolDef; active: boolean }) {
  return (
    <button
      type="button"
      onClick={tool.onClick}
      aria-current={active ? "page" : undefined}
      className={`${ROW} pl-7 ${active ? ROW_ACTIVE : ROW_IDLE}`}
    >
      <span
        aria-hidden="true"
        className="flex h-3.5 w-3.5 items-center justify-center opacity-60 [&_svg]:h-3.5 [&_svg]:w-3.5"
      >
        {tool.icon}
      </span>
      <span className="truncate">{tool.label}</span>
    </button>
  );
}

/**
 * The apps as a tree: one row per product, which expands to its tools, so a
 * tool is one click from anywhere without a trip through Home. Which rows
 * are open is remembered in this browser; the product of the tool in view is
 * always open, so the sidebar shows where you are.
 */
export function SidebarApps({ tools }: { tools: SidebarToolDef[] }) {
  const gt = useGT();
  const copy = useProductCopy();
  const { byProduct, unclaimed } = groupToolsByProduct(tools);
  const activeKey = toolKeyForTabTarget(useActiveTabTarget());
  const activeProduct = activeKey ? productForTool(activeKey) : undefined;
  const storageKey = "infrawrench-sidebar-apps-open";
  const [open, setOpen] = useState<string[]>(() => readRecent(storageKey));

  function toggle(id: string) {
    setOpen((current) => {
      const next = current.includes(id) ? current.filter((k) => k !== id) : [...current, id];
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage is unavailable (private window): the state lasts the session.
      }
      return next;
    });
  }

  const groups = [
    ...PRODUCTS.map((product) => ({
      id: product.id as string,
      name: copy[product.id].name,
      icon: <ProductIcon product={product.id} size={18} />,
      tools: byProduct[product.id],
    })),
    { id: "more", name: gt("More tools"), icon: null, tools: unclaimed },
  ].filter((group) => group.tools.length > 0);
  if (groups.length === 0) return null;

  return (
    <div className="mb-2">
      <div className="px-3 py-1">
        <span className="text-xs font-medium uppercase tracking-wide text-on-surface-muted">
          {gt("Apps")}
        </span>
      </div>
      {groups.map((group) => {
        // The tool in view keeps its app open even if it was collapsed.
        const expanded = open.includes(group.id) || group.id === activeProduct;
        return (
          <div key={group.id}>
            <button
              type="button"
              onClick={() => toggle(group.id)}
              aria-expanded={expanded}
              className={`${ROW} ${ROW_IDLE}`}
            >
              <svg
                aria-hidden="true"
                width={10}
                height={10}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`flex-shrink-0 opacity-60 transition-transform ${expanded ? "rotate-90" : ""}`}
              >
                {/* lucide: chevron-right */}
                <path d="m9 18 6-6-6-6" />
              </svg>
              {group.icon}
              <span className="truncate text-on-surface-secondary">{group.name}</span>
            </button>
            {expanded &&
              group.tools.map((tool) => (
                <ToolRow key={tool.key} tool={tool} active={tool.key === activeKey} />
              ))}
          </div>
        );
      })}
    </div>
  );
}
