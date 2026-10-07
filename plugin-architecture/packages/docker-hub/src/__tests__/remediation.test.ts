import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemediationResource } from "@infrawrench/plugin-base";
import { dockerHubRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";
import { RepositoryResourceType, TagResourceType } from "../resource-types.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "acme/api", externalId, fields };
}

const orphan = (resource: RemediationResource) =>
  dockerHubRemediationCommands({ kind: "orphan", reason: "x", resource });

describe("dockerHubRemediationCommands", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(dockerHubRemediationCommands);
  });

  it("covers every resource type that declares an orphan rule", () => {
    const withRule = plugin.resourceTypes.filter((t) => t.orphanRule).map((t) => t.id);
    expect(withRule.sort()).toEqual([RepositoryResourceType.id, TagResourceType.id].sort());
    expect(orphan(res("dockerhub-repository", "acme/api")).length).toBeGreaterThan(0);
    expect(orphan(res("dockerhub-tag", "acme/api:old")).length).toBeGreaterThan(0);
  });

  it("saves a never-pulled repository's settings and tags, then deletes it", () => {
    const cmds = orphan(
      res("dockerhub-repository", "acme/api", { namespace: "acme", name: "api" }),
    );
    expect(cmds.map((c) => c.destructive)).toEqual([false, false, false, true]);

    expect(cmds[0]!.command).toBe(
      `DOCKERHUB_JWT=$(jq -n --arg identifier "$DOCKERHUB_USERNAME" --arg secret "$DOCKERHUB_TOKEN"` +
        ` '{identifier: $identifier, secret: $secret}'` +
        ` | curl -sSf -X POST https://hub.docker.com/v2/auth/token -H 'Content-Type: application/json' --data-binary @-` +
        ` | jq -r .access_token)`,
    );
    expect(cmds[0]!.placeholders?.map((p) => p.name)).toEqual([
      "DOCKERHUB_USERNAME",
      "DOCKERHUB_TOKEN",
    ]);

    expect(cmds[1]!.command).toBe(
      `curl -sS --fail-with-body https://hub.docker.com/v2/namespaces/acme/repositories/api` +
        ` -H "Authorization: Bearer $DOCKERHUB_JWT" > acme_api-repository-20261007.json`,
    );
    expect(cmds[2]!.command).toBe(
      `curl -sS --fail-with-body 'https://hub.docker.com/v2/namespaces/acme/repositories/api/tags?page_size=100'` +
        ` -H "Authorization: Bearer $DOCKERHUB_JWT" > acme_api-tags-20261007.json`,
    );
    expect(cmds[3]!.command).toBe(
      `curl -sS --fail-with-body -X DELETE https://hub.docker.com/v2/repositories/acme/api/` +
        ` -H "Authorization: Bearer $DOCKERHUB_JWT"`,
    );
    expect(cmds[3]!.description).toMatch(/not in Docker's published Hub API reference/);
    expect(cmds[3]!.placeholders?.map((p) => p.name)).toEqual(["DOCKERHUB_JWT"]);
  });

  it("pulls an inactive tag to keep a copy, then deletes it", () => {
    const cmds = orphan(res("dockerhub-tag", "acme/api:1.0.0-rc1"));
    expect(cmds.map((c) => [c.tool, c.destructive])).toEqual([
      ["curl", false],
      ["docker", false],
      ["curl", true],
    ]);
    expect(cmds[1]!.command).toBe("docker pull docker.io/acme/api:1.0.0-rc1");
    expect(cmds[2]!.command).toBe(
      `curl -sS --fail-with-body -X DELETE https://hub.docker.com/v2/repositories/acme/api/tags/1.0.0-rc1/` +
        ` -H "Authorization: Bearer $DOCKERHUB_JWT"`,
    );
    expect(cmds[2]!.description).toMatch(/not in Docker's published Hub API reference/);
  });

  it("prefers the tag's fields over its externalId", () => {
    const cmds = orphan(res("dockerhub-tag", "stale/id:x", { repository: "acme/web", tag: "old" }));
    expect(cmds[1]!.command).toBe("docker pull docker.io/acme/web:old");
    expect(cmds[2]!.command).toContain("/v2/repositories/acme/web/tags/old/");
  });

  it("encodes and quotes hostile values so they never reach the shell as syntax", () => {
    const cmds = orphan(res("dockerhub-tag", "acme/api:x;rm -rf ~"));
    expect(cmds[1]!.command).toBe(`docker pull 'docker.io/acme/api:x;rm -rf ~'`);
    expect(cmds[2]!.command).toContain(
      "https://hub.docker.com/v2/repositories/acme/api/tags/x%3Brm%20-rf%20~/",
    );
    const repo = orphan(res("dockerhub-repository", "acme/it's"));
    expect(repo[3]!.command).toContain(`'https://hub.docker.com/v2/repositories/acme/it'"'"'s/'`);
    expect(repo[1]!.command).toMatch(/> acme_it_s-repository-20261007\.json$/);
  });

  it("returns nothing for a missing or malformed id", () => {
    expect(orphan(res("dockerhub-repository", null))).toEqual([]);
    expect(orphan(res("dockerhub-repository", "  "))).toEqual([]);
    expect(orphan(res("dockerhub-repository", "noslash"))).toEqual([]);
    expect(orphan(res("dockerhub-tag", null))).toEqual([]);
    expect(orphan(res("dockerhub-tag", "acme/api"))).toEqual([]);
    expect(orphan(res("dockerhub-tag", "acme/api:"))).toEqual([]);
  });

  it("answers no other finding kind or resource type", () => {
    expect(orphan(res("dockerhub-team", "acme/devs"))).toEqual([]);
    expect(
      dockerHubRemediationCommands({
        kind: "sleep-schedule",
        resource: res("dockerhub-repository", "acme/api"),
      }),
    ).toEqual([]);
  });
});
