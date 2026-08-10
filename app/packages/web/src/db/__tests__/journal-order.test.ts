import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Drizzle only applies migrations whose journal `when` is greater than the
 * latest applied row's `created_at` (`Number(last.created_at) < folderMillis`).
 * A branch-generated migration whose `when` lands *before* a migration that
 * already shipped is silently skipped, and the next migration that depends on
 * it then either fails mid-transaction or — worse — the app deploys against a
 * schema that never got the tables/columns the new code selects.
 *
 * Hit in prod twice:
 * - 2026-08-08: `0074_smart_slipstream` (session recordings)
 * - 2026-08-09: `0079_alert_routing_rules` (`muted_triggers` / `alert_rules` —
 *   "Your mobile notifications" 500s in Settings → Notifications)
 */
const journal = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "migrations",
      "meta",
      "_journal.json",
    ),
    "utf8",
  ),
) as {
  entries: { idx: number; when: number; tag: string }[];
};

describe("drizzle journal order", () => {
  it("has strictly increasing idx and when across every entry", () => {
    const { entries } = journal;
    expect(entries.length).toBeGreaterThan(0);

    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const cur = entries[i]!;
      expect(cur.idx, `${cur.tag} idx must follow ${prev.tag}`).toBe(prev.idx + 1);
      expect(
        cur.when,
        `${cur.tag} when (${cur.when}) must be > ${prev.tag} when (${prev.when}). ` +
          "Bump the out-of-order entry in meta/_journal.json past the previous " +
          "entry (and before the next) — otherwise drizzle silently skips it on prod.",
      ).toBeGreaterThan(prev.when);
    }
  });
});
