import { describe, expect, it } from "vitest";
import type { RemediationResource } from "@infrawrench/plugin-base";
import { dockerHubRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(resourceTypeId: string, externalId: string | null): RemediationResource {
  return { resourceTypeId, displayName: "acme/api", externalId, fields: {} };
}

describe("dockerHubRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(dockerHubRemediationCommands);
  });

  it("offers no command for either orphan kind, since Docker documents no delete route", () => {
    expect(
      dockerHubRemediationCommands({
        kind: "orphan",
        reason: "never pulled",
        resource: res("dockerhub-repository", "acme/api"),
      }),
    ).toEqual([]);
    expect(
      dockerHubRemediationCommands({
        kind: "orphan",
        reason: "inactive",
        resource: res("dockerhub-tag", "acme/api:old"),
      }),
    ).toEqual([]);
  });

  it("returns nothing for a missing id", () => {
    expect(
      dockerHubRemediationCommands({
        kind: "orphan",
        reason: "x",
        resource: res("dockerhub-repository", null),
      }),
    ).toEqual([]);
  });
});
