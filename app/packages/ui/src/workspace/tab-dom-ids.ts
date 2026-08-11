/**
 * DOM ids that tie the workspace tab strip (`GlobalTabBar`) to the panels the
 * viewport renders (`WorkspaceTabsViewport`).
 *
 * The two components are siblings in the shell, not parent and child, so they
 * cannot share a `useId()` — that hook returns a value scoped to one component
 * instance, and two instances asking for one independently get two different
 * answers. `aria-controls` / `aria-labelledby` need both sides to agree on a
 * single string, so the id is derived from the workspace tab id itself, which
 * is already unique per tab (`getWorkspaceTabId`) and already the key both
 * components render by. The fixed prefix is safe because the shell renders
 * exactly one tab strip and one viewport; if a second workspace ever shares a
 * document, give it a distinguishing prefix rather than reaching for `useId`.
 *
 * Tab ids are content-derived (`resource:acct:i-123`, `dashboard:<uuid>`, …)
 * and can contain characters that are awkward in a DOM id — a space would
 * split an `aria-controls` IDREF list in two, and `:` / `.` / `/` need
 * escaping in a CSS selector. `encodeTabIdForDom` maps everything outside
 * `[A-Za-z0-9-]` to `_<hex>_`, which stays injective (distinct tab ids can
 * never collide on one DOM id) because a literal `_` is escaped too.
 */

const WORKSPACE_TAB_ID_PREFIX = "workspace-tab";
const WORKSPACE_PANEL_ID_PREFIX = "workspace-tabpanel";

function encodeTabIdForDom(tabId: string): string {
  return tabId.replace(
    /[^A-Za-z0-9-]/g,
    (char) => `_${char.codePointAt(0)!.toString(16).padStart(2, "0")}_`,
  );
}

/** DOM id of the `role="tab"` button for a workspace tab. */
export function workspaceTabDomId(tabId: string): string {
  return `${WORKSPACE_TAB_ID_PREFIX}-${encodeTabIdForDom(tabId)}`;
}

/** DOM id of the `role="tabpanel"` element a workspace tab controls. */
export function workspaceTabPanelDomId(tabId: string): string {
  return `${WORKSPACE_PANEL_ID_PREFIX}-${encodeTabIdForDom(tabId)}`;
}

/**
 * The full attribute set that makes an element a workspace tab's panel.
 *
 * `WorkspaceTabsViewport` spreads this onto every panel it renders. A host
 * that renders a tab's content outside the viewport — web's Settings tab,
 * whose sections are a router subtree — spreads it onto the element that
 * actually contains that content, and tells the viewport not to render a
 * second element for the tab (`panelRenderedByHost`). Either way the tab's
 * `aria-controls` resolves to the one element holding what the tab opens.
 */
export function workspaceTabPanelProps(tabId: string): {
  id: string;
  role: "tabpanel";
  "aria-labelledby": string;
} {
  return {
    id: workspaceTabPanelDomId(tabId),
    role: "tabpanel",
    "aria-labelledby": workspaceTabDomId(tabId),
  };
}
