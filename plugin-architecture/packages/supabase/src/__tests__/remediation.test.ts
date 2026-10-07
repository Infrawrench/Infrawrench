import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { supabaseRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "my-project", externalId, fields: {} };
}

function commands(finding: RemediationFinding): string[] {
  return supabaseRemediationCommands(finding).map((c) => c.command);
}

describe("supabaseRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(supabaseRemediationCommands);
  });

  it("pauses and restores a project", () => {
    const result = supabaseRemediationCommands({
      kind: "sleep-schedule",
      resource: res("supabase-project", "abcdefghijklmnopqrst"),
    });
    expect(result.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X POST https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/pause -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"",
        "curl -sS -X POST https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/restore -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN"",
      ]
    `);
    expect(result.every((c) => !c.destructive)).toBe(true);
    expect(result[0]?.placeholders?.map((p) => p.name)).toEqual(["SUPABASE_ACCESS_TOKEN"]);
  });

  it("keeps a ref with shell metacharacters inside the quoted URL", () => {
    expect(
      commands({ kind: "sleep-schedule", resource: res("supabase-project", "a'; rm -rf ~") })[0],
    ).toMatchInlineSnapshot(
      `"curl -sS -X POST 'https://api.supabase.com/v1/projects/a'"'"'%3B%20rm%20-rf%20~/pause' -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN""`,
    );
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(commands({ kind: "sleep-schedule", resource: res("supabase-project", null) })).toEqual(
      [],
    );
    expect(
      commands({ kind: "sleep-schedule", resource: res("supabase-branch", "ref/branch") }),
    ).toEqual([]);
    expect(
      commands({ kind: "orphan", reason: "x", resource: res("supabase-project", "abc") }),
    ).toEqual([]);
  });
});
