/**
 * Peer-pane group titles arrive from the plugin with the count already written
 * into the string — `Pods (12)`, `Namespaces (5) · by cost`. The count is
 * therefore not a separate field the host can re-render; it has to be found in
 * the title and rewritten whenever the host knows a different number (an
 * optimistic create/delete, or a listing the host filtered further).
 *
 * The grammar is "name, count, optional ordering suffix", so the count is a
 * parenthesised integer that either ends the title or is followed by the ` · `
 * that introduces the suffix. Anchoring on that rather than on the end of the
 * string is the whole point: `Namespaces (5) · by cost` was previously read as
 * having no count at all, and the host appended a second one.
 */
const PEER_PANE_COUNT = /\((\d+)\)(?=\s*(?:·|$))/;

/**
 * Rewrite the count a group title already carries. Titles without one are
 * returned unchanged — use {@link peerPaneGroupTitle} when a count must appear.
 */
export function replacePeerPaneCount(title: string, count: number): string {
  return PEER_PANE_COUNT.test(title) ? title.replace(PEER_PANE_COUNT, `(${count})`) : title;
}

/**
 * The title as the header renders it: the plugin's own count replaced by the
 * number of items actually on screen, or appended when the plugin supplied
 * none. Never appends to a title that already counts itself.
 */
export function peerPaneGroupTitle(title: string, count: number): string {
  return PEER_PANE_COUNT.test(title)
    ? title.replace(PEER_PANE_COUNT, `(${count})`)
    : `${title} (${count})`;
}

/** The group's plain plural name: no count, no ordering suffix. `Namespaces`. */
export function peerPaneGroupName(title: string): string {
  const beforeSuffix = title.split(" · ")[0] ?? title;
  return beforeSuffix.replace(/\s*\(\d+\)\s*$/, "").trim();
}

/** The noun a "Create …" button should use — the group name, singularised. */
export function peerPaneCreateLabel(title: string): string {
  return peerPaneGroupName(title).replace(/s$/i, "");
}
