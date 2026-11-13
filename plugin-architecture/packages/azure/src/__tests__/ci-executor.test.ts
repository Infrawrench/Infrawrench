import { describe, expect, it } from "vitest";

import { aciResources, aciStart, aciStatus, containerGroupBody } from "../ci-aci.js";
import { acrStart, acrStatus, agentCpu, registryName, runRequest, taskYaml } from "../ci-acr.js";
import { azureCiListTagged, azureCiPreflight, azureCiTeardown } from "../ci-executor.js";
import { actionMatches, base64, type ArmCall, type AzureCiCalls } from "../ci-shared.js";
import { imageReference, shutdownTime, vmStart, vmStatus, vmTemplate } from "../ci-vm.js";

type Route = (
  body: unknown,
  path: string,
) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>;

/** A fake ARM: routes `METHOD path-fragment` to answers, recording what was sent. No network. */
function fakeArm(routes: Array<[string, Route]>) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const arm: ArmCall = async (method, path, body) => {
    sent.push({ method, path, body });
    const match = routes.find(([pattern]) => {
      const space = pattern.indexOf(" ");
      return pattern.slice(0, space) === method && path.includes(pattern.slice(space + 1));
    });
    if (!match) throw new Error(`unexpected ${method} ${path}`);
    const answer = await match[1](body, path);
    return { status: answer.status, body: answer.body ?? null };
  };
  const calls: AzureCiCalls = {
    arm,
    subscriptionId: "sub-1",
    principalId: async () => "oid-1",
    sleep: async () => {},
    now: () => Date.parse("2026-11-13T10:00:00Z"),
  };
  return { calls, sent };
}

const tags = {
  "infrawrench-ci": "org",
  "infrawrench-ci-job": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
};
const key = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const spec = { bootstrap: "#!/bin/sh\necho hi\n", tags, name: "ci build", maxSeconds: 3600 };
const decode = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

describe("permissions", () => {
  it("matches RBAC wildcards", () => {
    expect(actionMatches("*", "Microsoft.Compute/virtualMachines/write")).toBe(true);
    expect(actionMatches("Microsoft.Compute/*", "microsoft.compute/virtualMachines/write")).toBe(
      true,
    );
    expect(actionMatches("*/read", "Microsoft.Compute/virtualMachines/write")).toBe(false);
  });

  it("reads the principal's roles at the subscription, minus their not-actions", async () => {
    const { calls, sent } = fakeArm([
      [
        "GET /providers/Microsoft.Authorization/roleAssignments",
        () => ({
          status: 200,
          body: {
            value: [
              {
                properties: {
                  scope: "/subscriptions/sub-1",
                  roleDefinitionId: "/role/contributor",
                },
              },
              // Only on one group: not enough for groups of its own.
              {
                properties: {
                  scope: "/subscriptions/sub-1/resourceGroups/x",
                  roleDefinitionId: "/role/owner",
                },
              },
            ],
          },
        }),
      ],
      [
        "GET /role/contributor",
        () => ({
          status: 200,
          body: {
            properties: {
              permissions: [{ actions: ["*"], notActions: ["Microsoft.DevTestLab/*"] }],
            },
          },
        }),
      ],
      [
        "GET /providers/Microsoft.Compute?",
        () => ({ status: 200, body: { registrationState: "Registered" } }),
      ],
      [
        "GET /providers/Microsoft.Network?",
        () => ({ status: 200, body: { registrationState: "NotRegistered" } }),
      ],
    ]);
    const result = await azureCiPreflight(calls, "vm", "westeurope");
    expect(result.missing.map((m) => m.permission)).toEqual([
      "Microsoft.DevTestLab/schedules/write",
    ]);
    expect(result.problems[0]).toContain("Microsoft.Network");
    expect(result.ok).toBe(false);
    expect(decodeURIComponent(sent[0]?.path ?? "")).toContain("principalId eq 'oid-1'");
    expect(sent.some((s) => s.path.includes("/role/owner"))).toBe(false);
  });
});

describe("virtual machines", () => {
  it("deploys Ubuntu with the bootstrap, no identity, a public IP and an auto-shutdown at the deadline", () => {
    const template = vmTemplate(
      { ...spec, kind: "vm" },
      "westeurope",
      Date.parse("2026-11-13T10:00:00Z"),
    ) as {
      resources: Array<Record<string, any>>;
    };
    const vm = template.resources.find((r) => r["type"] === "Microsoft.Compute/virtualMachines");
    expect(vm?.["identity"]).toBeUndefined();
    expect(vm?.["properties"].storageProfile.imageReference).toEqual({
      publisher: "Canonical",
      offer: "ubuntu-24_04-lts",
      sku: "server",
      version: "latest",
    });
    expect(vm?.["properties"].storageProfile.osDisk.deleteOption).toBe("Delete");
    expect(decode(vm?.["properties"].osProfile.customData)).toBe(spec.bootstrap);
    expect(vm?.["tags"]).toEqual(tags);
    const ip = template.resources.find((r) => r["type"] === "Microsoft.Network/publicIPAddresses");
    expect(ip?.["sku"]).toEqual({ name: "Standard" });
    const schedule = template.resources.find((r) => r["type"] === "Microsoft.DevTestLab/schedules");
    expect(schedule?.["name"]).toBe("shutdown-computevm-iwci-vm");
    expect(schedule?.["properties"]).toMatchObject({
      taskType: "ComputeVmShutdownTask",
      dailyRecurrence: { time: "1100" },
      timeZoneId: "UTC",
    });
  });

  it("leaves out a daily shutdown that would fire before a long job's deadline", () => {
    expect(shutdownTime(0, 23 * 3600)).toBeNull();
    expect(shutdownTime(Date.parse("2026-11-13T23:30:00Z"), 3600)).toBe("0030");
    expect(imageReference("Standard_D4ps_v5").sku).toBe("server-arm64");
    expect(imageReference("Standard_D4s_v5", "a:b:c")).toEqual({
      publisher: "a",
      offer: "b",
      sku: "c",
      version: "latest",
    });
    expect(() => imageReference("x", "nope")).toThrow("publisher:offer:sku");
  });

  it("makes a tagged group per job, deploys into it, and follows the machine", async () => {
    let groupExists = false;
    const { calls, sent } = fakeArm([
      [
        "GET /resourcegroups/iwci-vm-" + key + "/providers/Microsoft.Resources/deployments",
        () => ({
          status: 200,
          body: { properties: { provisioningState: "Succeeded" } },
        }),
      ],
      [
        "GET /instanceView",
        () => ({
          status: 200,
          body: {
            statuses: [{ code: "ProvisioningState/succeeded" }, { code: "PowerState/running" }],
          },
        }),
      ],
      ["PUT /providers/Microsoft.Resources/deployments/infrawrench-ci", () => ({ status: 201 })],
      ["GET /resourcegroups/iwci-vm-", () => ({ status: groupExists ? 200 : 404 })],
      [
        "PUT /resourcegroups/iwci-vm-",
        () => {
          groupExists = true;
          return { status: 201 };
        },
      ],
    ]);
    const handle = await vmStart(calls, "westeurope", { ...spec, kind: "vm" });
    expect(handle).toEqual({
      id: `iwci-vm-${key}`,
      region: "westeurope",
      label: `azure vm iwci-vm-${key} (westeurope)`,
      data: { kind: "vm" },
    });
    const group = sent.find((s) => s.method === "PUT" && !s.path.includes("deployments"));
    expect(group?.body).toEqual({
      location: "westeurope",
      tags: { ...tags, "infrawrench-ci-created": "2026-11-13T10:00:00.000Z" },
    });
    expect(await vmStatus(calls, handle)).toEqual({ state: "running", detail: "running" });
  });
});

describe("container instances", () => {
  it("runs the bootstrap under a watchdog that always exits 0, with no identity", () => {
    const body = containerGroupBody({ ...spec, kind: "container" }, "westeurope") as Record<
      string,
      any
    >;
    expect(body["identity"]).toBeUndefined();
    expect(body["properties"].restartPolicy).toBe("Never");
    const container = body["properties"].containers[0].properties;
    expect(container.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(container.command[2]).toContain("sleep 3600;");
    expect(container.command[2].endsWith("exit 0")).toBe(true);
    expect(container.command.at(-1)).toBe(spec.bootstrap);
    expect(container.resources.requests).toEqual({ cpu: 2, memoryInGB: 4 });
    expect(aciResources("1vcpu-1.5gb")).toEqual({ cpu: 1, memoryInGB: 1.5 });
    expect(() => aciResources("64vcpu-8gb")).toThrow("31 vCPUs");
  });

  it("starts once and reads how the container is doing", async () => {
    let state = "Running";
    const { calls, sent } = fakeArm([
      [
        "GET /containerGroups/iwci-job",
        () =>
          sent.filter((s) => s.method === "PUT" && s.path.includes("containerGroups")).length === 0
            ? { status: 404 }
            : {
                status: 200,
                body: {
                  properties: {
                    provisioningState: "Succeeded",
                    containers: [
                      {
                        properties: {
                          instanceView: { currentState: { state, detailStatus: "Completed" } },
                        },
                      },
                    ],
                  },
                },
              },
      ],
      ["PUT /containerGroups/iwci-job", () => ({ status: 201 })],
      ["GET /resourcegroups/iwci-container-", () => ({ status: 200 })],
    ]);
    const handle = await aciStart(calls, "westeurope", { ...spec, kind: "container" });
    expect(handle.id).toBe(`iwci-container-${key}`);
    expect(await aciStatus(calls, handle)).toEqual({ state: "running" });
    state = "Terminated";
    expect(await aciStatus(calls, handle)).toEqual({ state: "stopped", detail: "Completed" });
    await aciStart(calls, "westeurope", { ...spec, kind: "container" });
    expect(
      sent.filter((s) => s.method === "PUT" && s.path.includes("containerGroups")),
    ).toHaveLength(1);
  });
});

describe("ACR Tasks", () => {
  it("runs the bootstrap from a mounted file, with bash and curl added where missing", () => {
    const yaml = taskYaml({ ...spec, kind: "build" });
    expect(yaml).toContain("  - cmd: docker.io/library/docker:cli /iwci/bootstrap.sh");
    expect(yaml).toContain("    entryPoint: sh");
    expect(yaml).toContain("stepTimeout: 3600");
    expect(yaml).not.toMatch(/\$|\{\{/);
    const file = /bootstrap\.sh: (\S+)/.exec(yaml)?.[1] ?? "";
    const script = decode(file);
    expect(script).toContain("apk add --no-cache bash curl");
    expect(script.trimEnd().endsWith("echo hi")).toBe(true);
    const request = runRequest({ ...spec, kind: "build" });
    expect(request).toMatchObject({
      type: "EncodedTaskRunRequest",
      platform: { os: "Linux", architecture: "amd64" },
      agentConfiguration: { cpu: 2 },
      timeout: 3600,
    });
    expect(decode(String(request["encodedTaskContent"]))).toBe(yaml);
    expect(agentCpu("4vcpu")).toBe(4);
    expect(() => agentCpu("Standard_D2s_v5")).toThrow("<n>vcpu");
    expect(base64("é")).toBe("w6k=");
  });

  it("makes the job's registry, waits for it, and schedules one run", async () => {
    let polls = 0;
    const { calls, sent } = fakeArm([
      [
        "GET /resourcegroups/iwci-build-" +
          key +
          "/providers/Microsoft.ContainerRegistry/registries/" +
          registryName(key) +
          "/runs/r1",
        () => ({
          status: 200,
          body: { properties: { status: "Running" } },
        }),
      ],
      ["GET /runs?", () => ({ status: 200, body: { value: [] } })],
      [
        "POST /scheduleRun",
        () => ({ status: 200, body: { properties: { runId: "r1", status: "Queued" } } }),
      ],
      [
        "GET /registries/",
        () => {
          polls++;
          if (polls === 1) return { status: 404 };
          return {
            status: 200,
            body: { properties: { provisioningState: polls < 3 ? "Creating" : "Succeeded" } },
          };
        },
      ],
      [
        "PUT /registries/",
        () => ({ status: 200, body: { properties: { provisioningState: "Creating" } } }),
      ],
      ["GET /resourcegroups/iwci-build-", () => ({ status: 200 })],
    ]);
    const handle = await acrStart(calls, "westeurope", { ...spec, kind: "build" });
    expect(handle).toEqual({
      id: `iwci-build-${key}`,
      region: "westeurope",
      label: "azure acr run r1 (westeurope)",
      data: { kind: "build", registry: `iwci${key}`, runId: "r1" },
    });
    const registry = sent.find((s) => s.method === "PUT" && s.path.includes("/registries/"));
    expect(registry?.body).toMatchObject({
      sku: { name: "Basic" },
      properties: { adminUserEnabled: false },
    });
    expect(await acrStatus(calls, handle)).toEqual({ state: "running", detail: "Running" });
  });

  it("refuses a job longer than a run may last", async () => {
    const { calls } = fakeArm([]);
    await expect(
      acrStart(calls, "westeurope", { ...spec, kind: "build", maxSeconds: 9 * 3600 }),
    ).rejects.toThrow("8 hours");
  });
});

describe("teardown and leftovers", () => {
  it("deletes the job's group, and takes a missing one as done", async () => {
    const { calls, sent } = fakeArm([
      ["POST /cancel", () => ({ status: 200 })],
      ["DELETE /resourcegroups/iwci-build-", () => ({ status: 202 })],
      ["DELETE /resourcegroups/iwci-vm-", () => ({ status: 404 })],
    ]);
    await azureCiTeardown(calls, {
      id: `iwci-build-${key}`,
      label: "x",
      data: { kind: "build", registry: `iwci${key}`, runId: "r1" },
    });
    expect(sent.map((s) => s.method)).toEqual(["POST", "DELETE"]);
    await expect(
      azureCiTeardown(calls, { id: `iwci-vm-${key}`, label: "x" }),
    ).resolves.toBeUndefined();
    await expect(azureCiTeardown(calls, { id: "production", label: "x" })).rejects.toThrow(
      "not a resource group",
    );
  });

  it("lists tagged CI groups with their tags as sent, skipping others and those being deleted", async () => {
    const { calls, sent } = fakeArm([
      [
        "GET /subscriptions/sub-1/resourcegroups?",
        () => ({
          status: 200,
          body: {
            value: [
              {
                name: `iwci-container-${key}`,
                location: "westeurope",
                tags: { ...tags, "infrawrench-ci-created": "2026-11-13T09:00:00Z" },
              },
              {
                name: `iwci-vm-${key}`,
                location: "westeurope",
                tags,
                properties: { provisioningState: "Deleting" },
              },
              { name: "unrelated", location: "westeurope", tags },
            ],
          },
        }),
      ],
      [
        "GET /containerGroups/iwci-job",
        () => ({
          status: 200,
          body: {
            properties: {
              containers: [
                { properties: { instanceView: { currentState: { state: "Running" } } } },
              ],
            },
          },
        }),
      ],
    ]);
    const tagged = await azureCiListTagged(calls, "infrawrench-ci", ["WestEurope"]);
    expect(tagged).toEqual([
      {
        handle: expect.objectContaining({
          id: `iwci-container-${key}`,
          data: { kind: "container" },
        }),
        tags,
        createdAt: "2026-11-13T09:00:00Z",
        live: true,
      },
    ]);
    expect(decodeURIComponent(sent[0]?.path ?? "")).toContain("tagName eq 'infrawrench-ci'");
  });
});
