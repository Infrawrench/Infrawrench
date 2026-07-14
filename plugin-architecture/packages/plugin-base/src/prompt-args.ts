/**
 * Parse the JSON-encoded form-values payload the host attaches as `args[0]`
 * of a prompt-backed action. Returns `{}` for missing / non-JSON payloads so
 * action handlers can treat every field as simply optional.
 */
export function decodePromptArgs(args: (string | number)[]): Record<string, string> {
  const first = args[0];
  if (typeof first !== "string") return {};
  try {
    const parsed = JSON.parse(first) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
