/**
 * Parsing for the free-text create and edit form values. Kept apart from the
 * client so the rules are unit-testable and shared by create and update.
 */

import { HOOK_EVENTS, GROUP_ONLY_HOOK_EVENTS } from "./mappers.js";

export const truthy = (v: string | undefined): boolean =>
  ["true", "1", "yes", "on"].includes((v ?? "").trim().toLowerCase());

/** `a, b ,c` -> `["a","b","c"]`. */
export function commaList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pipeline variables typed one per line as `KEY=value`. Keys follow GitLab's
 * rule (letters, digits and underscores); a value may contain `=`.
 */
export function parseVariableLines(
  raw: string | undefined,
): Array<{ key: string; value: string; variable_type: "env_var" }> {
  const out: Array<{ key: string; value: string; variable_type: "env_var" }> = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `GitLab plugin: pipeline variables are KEY=value, one per line (got "${trimmed}")`,
      );
    }
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      throw new Error(
        `GitLab plugin: "${key}" is not a valid variable name (letters, digits and _ only)`,
      );
    }
    out.push({ key, value: trimmed.slice(eq + 1), variable_type: "env_var" });
  }
  return out;
}

/** Variable keys: at most 255 characters of `A-Z a-z 0-9 _`. */
export function validateVariableKey(key: string): string {
  const k = key.trim();
  if (!/^[A-Za-z0-9_]{1,255}$/.test(k)) {
    throw new Error(
      "GitLab plugin: a variable key may only contain letters, digits and underscores (at most 255)",
    );
  }
  return k;
}

/**
 * Webhook event flags from the comma-separated "Events" field. Every known
 * flag is sent (true or false), so an edit that removes an event really
 * turns it off. Unknown names are refused rather than silently dropped.
 */
export function hookEventFlags(
  raw: string | undefined,
  kind: "project" | "group",
): Record<string, boolean> {
  const wanted = new Set(
    commaList(raw).map((e) =>
      e
        .toLowerCase()
        .replace(/_events$/, "")
        .replace(/[\s-]+/g, "_"),
    ),
  );
  const allowed = HOOK_EVENTS.filter((e) => kind === "group" || !GROUP_ONLY_HOOK_EVENTS.has(e));
  for (const e of wanted) {
    if (!(allowed as readonly string[]).includes(e)) {
      throw new Error(
        `GitLab plugin: "${e}" is not a ${kind} webhook event. Use: ${allowed.join(", ")}`,
      );
    }
  }
  const out: Record<string, boolean> = {};
  for (const e of allowed) out[`${e}_events`] = wanted.has(e);
  return out;
}

/** `YYYY-MM-DD` or an ISO timestamp, or nothing. */
export function optionalDate(raw: string | undefined, label: string): string | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  if (Number.isNaN(Date.parse(v))) {
    throw new Error(`GitLab plugin: "${label}" must be a date like 2027-03-31`);
  }
  return v;
}

/** Five-field cron. GitLab validates the rest; this catches the obvious typo early. */
export function validateCron(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  if (v.split(/\s+/).length !== 5) {
    throw new Error('GitLab plugin: the cron schedule needs five fields, e.g. "0 3 * * 1-5"');
  }
  return v;
}

export function optionalInt(
  raw: string | undefined,
  label: string,
  min: number,
): number | undefined {
  const v = (raw ?? "").trim();
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`GitLab plugin: "${label}" must be a whole number of at least ${min}`);
  }
  return n;
}
