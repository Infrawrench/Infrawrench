/**
 * Splits a relative download path into the segments to join beneath a
 * destination folder, or returns null when the path is unsafe to write.
 *
 * Remote names come from servers we do not control: an SFTP listing can hand
 * back `..`, and a name that is legal on Linux (`..\x`, `C:x`) is a separator
 * or a drive on Windows. Only `/` separates segments here; anything that could
 * be read as another separator, a drive, a parent hop or an absolute root is
 * rejected outright rather than rewritten, so the caller can tell the user
 * which entries were skipped.
 */
export function safeRelativePathSegments(relativePath: string): string[] | null {
  if (relativePath === "" || relativePath.startsWith("/")) return null;
  if (/[\\:\0]/.test(relativePath)) return null;
  const segments = relativePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return segments;
}
