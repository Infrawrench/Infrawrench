import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../cloud-ws", () => ({ getCloudWsUrl: async () => "ws://localhost:3000" }));

import {
  createCloudWorkflowClient,
  listCloudWorkflows,
  pinCloudWorkflow,
  unpinCloudWorkflow,
} from "../cloud-workflows";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-workflows wrappers", () => {
  it("listCloudWorkflows -> cloud_list_workflows", async () => {
    invoke.mockResolvedValue([{ id: "w1" }]);
    const res = await listCloudWorkflows("org1");
    expect(invoke).toHaveBeenCalledWith("cloud_list_workflows", { orgId: "org1" });
    expect(res).toEqual([{ id: "w1" }]);
  });

  it("pin/unpin -> cloud_pin_workflow / cloud_unpin_workflow", async () => {
    await pinCloudWorkflow("org1", "dash1", "w1");
    expect(invoke).toHaveBeenCalledWith("cloud_pin_workflow", {
      orgId: "org1",
      dashboardId: "dash1",
      workflowId: "w1",
    });
    await unpinCloudWorkflow("org1", "dash1", "w1");
    expect(invoke).toHaveBeenCalledWith("cloud_unpin_workflow", {
      orgId: "org1",
      dashboardId: "dash1",
      workflowId: "w1",
    });
  });
});

describe("createCloudWorkflowClient", () => {
  it("routes CRUD through the org-scoped IPC", async () => {
    const client = createCloudWorkflowClient("org1");

    invoke.mockResolvedValue([{ id: "w1" }]);
    await client.list();
    expect(invoke).toHaveBeenCalledWith("cloud_list_workflows", { orgId: "org1" });

    invoke.mockResolvedValue({ id: "w1" });
    await client.create({ name: "New" });
    expect(invoke).toHaveBeenCalledWith("cloud_create_workflow", {
      orgId: "org1",
      body: { name: "New" },
    });

    await client.update("w1", { source: "infra.log(1)" });
    expect(invoke).toHaveBeenCalledWith("cloud_update_workflow", {
      orgId: "org1",
      id: "w1",
      body: { source: "infra.log(1)" },
    });

    await client.remove("w1");
    expect(invoke).toHaveBeenCalledWith("cloud_delete_workflow", { orgId: "org1", id: "w1" });

    invoke.mockResolvedValue("declare const infra: any;");
    await client.getTypings("w1");
    expect(invoke).toHaveBeenCalledWith("cloud_workflow_typings", {
      orgId: "org1",
      id: "w1",
      enrich: false,
    });
  });

  it("maps secret assignments and reusable secret operations", async () => {
    const client = createCloudWorkflowClient("org1");

    await client.update("w1", { assignedSecretIds: ["s1", "s2"] });
    expect(invoke).toHaveBeenCalledWith("cloud_update_workflow", {
      orgId: "org1",
      id: "w1",
      body: { secretIds: ["s1", "s2"] },
    });

    invoke.mockResolvedValue([{ id: "s1", name: "TOKEN", hasValue: true }]);
    await client.listSecrets();
    expect(invoke).toHaveBeenCalledWith("cloud_list_workflow_secrets", { orgId: "org1" });

    invoke.mockResolvedValue({
      secretIds: ["s1"],
      secrets: [{ id: "s1", name: "TOKEN", hasValue: true }],
    });
    await expect(client.getAssignedSecrets("w1")).resolves.toEqual({
      assignedSecretIds: ["s1"],
      secrets: [{ id: "s1", name: "TOKEN", hasValue: true }],
    });
    expect(invoke).toHaveBeenCalledWith("cloud_get_workflow_secrets", {
      orgId: "org1",
      id: "w1",
    });

    await client.upsertSecret({ name: "TOKEN", value: "write-only" });
    expect(invoke).toHaveBeenCalledWith("cloud_upsert_workflow_secret", {
      orgId: "org1",
      name: "TOKEN",
      value: "write-only",
    });

    await client.deleteSecret("s1");
    expect(invoke).toHaveBeenCalledWith("cloud_delete_workflow_secret", {
      orgId: "org1",
      id: "s1",
    });
  });

  it("runs non-debug over HTTP rather than the websocket", async () => {
    const client = createCloudWorkflowClient("org1");
    invoke.mockResolvedValue({ runId: "r1", result: { status: "ok", logs: [] } });
    const res = await client.run("w1");
    expect(invoke).toHaveBeenCalledWith("cloud_run_workflow", { orgId: "org1", id: "w1" });
    expect(res.runId).toBe("r1");
  });
});
