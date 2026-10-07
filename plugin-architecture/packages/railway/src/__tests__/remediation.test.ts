import { describe, expect, it } from "vitest";
import type { RemediationFinding, RemediationResource } from "@infrawrench/plugin-base";
import { railwayRemediationCommands } from "../remediation.js";
import { plugin } from "../plugin.js";

function res(
  resourceTypeId: string,
  externalId: string | null,
  fields: RemediationResource["fields"] = {},
): RemediationResource {
  return { resourceTypeId, displayName: "api", externalId, fields };
}

/** One line per command; "!" marks destructive ones. */
function lines(finding: RemediationFinding): string[] {
  return railwayRemediationCommands(finding).map(
    (c) => `${c.destructive ? "!" : "-"} ${c.command}`,
  );
}

describe("railwayRemediationCommands", () => {
  it("is wired on the plugin", () => {
    expect(plugin.remediationCommands).toBe(railwayRemediationCommands);
  });

  it("stops and redeploys a service", () => {
    const commands = railwayRemediationCommands({
      kind: "sleep-schedule",
      resource: res("service", "env-1/svc-1", {
        serviceId: "svc-1",
        environmentId: "env-1",
        latestDeploymentId: "dep-1",
      }),
    });
    expect(commands.map((c) => c.command)).toMatchInlineSnapshot(`
      [
        "curl -sS -X POST https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer $RAILWAY_API_TOKEN" -H 'Content-Type: application/json' -d '{"query":"mutation($id: String!) { deploymentStop(id: $id) }","variables":{"id":"dep-1"}}'",
        "curl -sS -X POST https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer $RAILWAY_API_TOKEN" -H 'Content-Type: application/json' -d '{"query":"mutation($serviceId: String!, $environmentId: String!) { serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId) }","variables":{"serviceId":"svc-1","environmentId":"env-1"}}'",
      ]
    `);
    expect(commands[0]?.placeholders?.map((p) => p.name)).toEqual(["RAILWAY_API_TOKEN"]);
  });

  it("deletes an unmounted volume", () => {
    expect(
      lines({
        kind: "orphan",
        reason: "x",
        resource: res("volume", "env-1/vol-1", { projectId: "proj-1", environmentId: "env-1" }),
      }),
    ).toMatchInlineSnapshot(`
      [
        "! railway volume --project proj-1 --environment env-1 delete --volume vol-1 --yes",
      ]
    `);
  });

  it("keeps a JSON body with quotes inside one shell argument", () => {
    const [stop] = railwayRemediationCommands({
      kind: "sleep-schedule",
      resource: res("service", "env-1/svc-1", { latestDeploymentId: "d'; rm -rf ~" }),
    });
    expect(stop?.command).toContain(`"variables":{"id":"d'"'"'; rm -rf ~"}}'`);
  });

  it("returns nothing for missing ids, other types and other kinds", () => {
    expect(lines({ kind: "sleep-schedule", resource: res("service", "env-1/svc-1") })).toEqual([]);
    expect(lines({ kind: "orphan", reason: "x", resource: res("volume", "env-1/vol-1") })).toEqual(
      [],
    );
    expect(lines({ kind: "orphan", reason: "x", resource: res("service", "env-1/svc-1") })).toEqual(
      [],
    );
    expect(
      lines({ kind: "sleep-schedule", resource: res("volume", "env-1/vol-1", { projectId: "p" }) }),
    ).toEqual([]);
  });
});
