import type { CostDimensionOption } from "@infrawrench/client-core";

/**
 * Tag key chips for a phone picker: the native counterpart of web's
 * `TagKeySelect`/`TagKeyInput`.
 *
 * The server has already applied the org's tag key settings (preferred keys
 * first and flagged, hidden keys left out); this marks the preferred ones with
 * a star, since a chip row has no room for a "Preferred" group heading, and
 * keeps a selected key the list no longer offers (hidden after the card was
 * saved) as a chip so it stays visibly selected rather than silently unset.
 */
export function tagKeyChipOptions(
  options: readonly CostDimensionOption[],
  selected: string | null | undefined,
): Array<{ value: string; label: string }> {
  const chips = options.map((o) => ({
    value: o.value,
    label: o.preferred ? `★ ${o.label}` : o.label,
  }));
  if (selected && !options.some((o) => o.value === selected)) {
    chips.push({ value: selected, label: selected });
  }
  return chips;
}

/** Most suggestion chips under a free-text tag key field. */
const MAX_SUGGESTIONS = 12;

/**
 * Suggestions under a free-text tag key field: keys starting with what has
 * been typed (case-insensitively), in the server's order so preferred keys
 * lead. Empty once the field holds an exact key.
 */
export function tagKeySuggestions(
  options: readonly CostDimensionOption[],
  typed: string,
): Array<{ value: string; label: string }> {
  const q = typed.trim().toLowerCase();
  if (options.some((o) => o.value === typed)) return [];
  return tagKeyChipOptions(
    options.filter((o) => o.value.toLowerCase().startsWith(q)),
    null,
  ).slice(0, MAX_SUGGESTIONS);
}
