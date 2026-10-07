import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { pineconeRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "nightly", externalId, fields };
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "source deleted",
  resource,
});

describe("pineconeRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(pineconeRemediationCommands);
  });

  it("deletes a backup whose index is gone", () => {
    const [cmd, ...rest] = pineconeRemediationCommands(
      orphan(res("backup", "c84725e5-5956-41ba-ab62-21ac7b5f2a2f")),
    );
    expect(rest).toEqual([]);
    expect(cmd?.command).toBe(
      "pc index backup delete --id c84725e5-5956-41ba-ab62-21ac7b5f2a2f --skip-confirmation",
    );
    expect(cmd?.destructive).toBe(true);
    expect(cmd?.placeholders?.map((p) => p.name)).toEqual(["PINECONE_API_KEY"]);
  });

  it("prefers the backupId field and quotes it", () => {
    const [cmd] = pineconeRemediationCommands(orphan(res("backup", "x", { backupId: "a b" })));
    expect(cmd?.command).toBe("pc index backup delete --id 'a b' --skip-confirmation");
  });

  it("returns nothing without an id or for other findings", () => {
    expect(pineconeRemediationCommands(orphan(res("backup", null)))).toEqual([]);
    expect(pineconeRemediationCommands(orphan(res("index", "idx")))).toEqual([]);
    expect(
      pineconeRemediationCommands({ kind: "sleep-schedule", resource: res("backup", "b") }),
    ).toEqual([]);
  });
});
