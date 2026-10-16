/** True on macOS (and iPadOS with a keyboard), where the modifier is ⌘. */
export function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad/i.test(platform);
}

/** "⌘" or "Ctrl+", for composing shortcut hints. */
export function modKeyPrefix(): string {
  return isMacLike() ? "⌘" : "Ctrl+";
}

/** The palette's own shortcut, as the platform writes it. */
export function paletteShortcutLabel(): string {
  return `${modKeyPrefix()}K`;
}

/** The platform's command modifier is held (⌘ on macOS, Ctrl elsewhere). */
export function isModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacLike() ? e.metaKey : e.ctrlKey;
}
