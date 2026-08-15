/**
 * Layout rules shared by the `select` field kind's two renderings — the inline
 * chip row (few, short options) and {@link SelectPicker}'s searchable option
 * grid. Kept as pure functions so the choice can be unit-tested without a DOM.
 *
 * The numbers come from the create modal, which is a fixed 560px wide: after
 * the modal padding, the picker's border and its `p-3`, a two-column cell has
 * roughly 220px of text — about 30 characters at `text-sm`. Anything longer
 * used to truncate, which is how a size option built as
 * `gpu-h100x1-80gb (1× GPU, $3219/mo)` rendered as `gpu-h100x1-80gb (1× GPU, $3…`
 * and hid the price the option existed to show.
 */
import type { SelectOption } from "@infrawrench/plugin-base";

/**
 * Longest label that reliably fits one two-column cell. Also the cutoff for
 * rendering the options as a plain chip row instead of the picker.
 */
export const SELECT_NARROW_LABEL_LIMIT = 28;

/** Most options a chip row shows before the picker takes over. */
export const SELECT_CHIP_MAX_OPTIONS = 4;

const longestLabel = (options: SelectOption[]): number =>
  options.reduce((max, opt) => Math.max(max, opt.label.length), 0);

/**
 * Number of columns the option grid should use. Long labels get the full width
 * of the picker rather than half of it; they still wrap if that isn't enough.
 */
export function selectPickerColumns(options: SelectOption[]): 1 | 2 {
  return longestLabel(options) > SELECT_NARROW_LABEL_LIMIT ? 1 : 2;
}

/**
 * Whether the options can be drawn as a row of chips. Options carrying a
 * `description` always need the picker — a chip has nowhere to put a second
 * line, and dropping the description would lose exactly the pricing/spec
 * detail the plugin moved out of the label.
 */
export function selectRendersAsChips(options: SelectOption[]): boolean {
  // An empty list stays on the chip branch, which renders nothing — routing it
  // to the picker would show a search box over "No matches".
  if (options.length > SELECT_CHIP_MAX_OPTIONS) return false;
  if (options.some((opt) => opt.description)) return false;
  return longestLabel(options) < SELECT_NARROW_LABEL_LIMIT;
}

/**
 * The lines an option card shows under its label: the plugin-supplied
 * `description` first, then the raw `id` when it differs from the label (so a
 * human-readable label never hides the value that gets submitted).
 */
export function selectOptionSecondaryLines(opt: SelectOption): {
  description: string | null;
  id: string | null;
} {
  return {
    description: opt.description ?? null,
    id: opt.label === opt.id ? null : opt.id,
  };
}
