import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { pulumiCloudRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "thing", externalId, fields };
}

const orphan = (resource: RemediationResource): RemediationFinding => ({
  kind: "orphan",
  reason: "unused",
  resource,
});

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return pulumiCloudRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("pulumiCloudRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(pulumiCloudRemediationCommands);
  });

  it("removes an empty stack by its fully qualified name", () => {
    expect(lines(orphan(res("stack", "infra/dev", { fullyQualifiedName: "acme/infra/dev" }))))
      .toMatchInlineSnapshot(`
      [
        "! pulumi stack rm --yes --preserve-config --stack acme/infra/dev",
      ]
    `);
  });

  it("revokes a never-used org token over the REST API", () => {
    const [cmd] = pulumiCloudRemediationCommands(
      orphan(res("access-token", "tok-123", { tokenId: "tok-123", organization: "acme" })),
    );
    expect(cmd).toMatchObject({ tool: "curl", destructive: true });
    expect(cmd?.command).toMatchInlineSnapshot(
      `"curl -sS -X DELETE https://api.pulumi.com/api/orgs/acme/tokens/tok-123 -H "Authorization: token $PULUMI_ACCESS_TOKEN""`,
    );
    expect(cmd?.placeholders?.map((p) => p.name)).toEqual(["PULUMI_ACCESS_TOKEN"]);
  });

  it("quotes hostile stack names and encodes ids in URLs", () => {
    expect(lines(orphan(res("stack", null, { fullyQualifiedName: "acme/p/x y" })))).toEqual([
      "! pulumi stack rm --yes --preserve-config --stack 'acme/p/x y'",
    ]);
    expect(
      pulumiCloudRemediationCommands(
        orphan(res("access-token", "a b", { organization: "acme" })),
      )[0]?.command,
    ).toContain("/tokens/a%20b");
  });

  it("returns nothing without ids, or for other kinds and types", () => {
    expect(pulumiCloudRemediationCommands(orphan(res("stack", "infra/dev")))).toEqual([]);
    expect(
      pulumiCloudRemediationCommands(orphan(res("access-token", "tok-1", { organization: "" }))),
    ).toEqual([]);
    expect(pulumiCloudRemediationCommands(orphan(res("team", "ops")))).toEqual([]);
    expect(
      pulumiCloudRemediationCommands({
        kind: "sleep-schedule",
        resource: res("stack", "a/b", { fullyQualifiedName: "o/a/b" }),
      }),
    ).toEqual([]);
  });
});
