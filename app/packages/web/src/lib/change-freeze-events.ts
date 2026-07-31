/**
 * Custom event name the freeze settings page dispatches after creating or
 * ending a freeze so the app-wide banner updates without waiting for the next
 * poll. Kept out of the banner component file so Fast Refresh can preserve
 * component state.
 */
export const CHANGE_FREEZE_CHANGED_EVENT = "infrawrench:change-freeze-changed";

export function dispatchChangeFreezeChanged(): void {
  window.dispatchEvent(new Event(CHANGE_FREEZE_CHANGED_EVENT));
}
