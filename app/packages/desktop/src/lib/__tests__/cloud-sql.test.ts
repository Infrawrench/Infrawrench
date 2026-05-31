import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  cloudKvBrowserDelete,
  cloudKvBrowserGet,
  cloudKvBrowserList,
  cloudKvBrowserPut,
  cloudKvCommand,
  cloudListArtifacts,
  cloudSqlEstimate,
  cloudSqlExecute,
  cloudSqlQuery,
} from "../cloud-sql";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("cloud-sql wrappers", () => {
  it("cloudSqlQuery wraps body", async () => {
    const body = { accountId: "a", sql: "SELECT 1" };
    await cloudSqlQuery("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_sql_query", { orgId: "org1", body });
  });

  it("cloudListArtifacts", async () => {
    const body = { accountId: "a", resourceId: "r", resourceTypeId: "t" };
    await cloudListArtifacts("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_list_artifacts", { orgId: "org1", body });
  });

  it("cloudSqlExecute", async () => {
    const body = { accountId: "a", sql: "DELETE FROM t", params: [1] };
    await cloudSqlExecute("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_sql_execute", { orgId: "org1", body });
  });

  it("cloudSqlEstimate", async () => {
    const body = { accountId: "a", resourceId: "r", sql: "SELECT 1" };
    await cloudSqlEstimate("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_sql_estimate", { orgId: "org1", body });
  });

  it("cloudKvCommand", async () => {
    const body = { accountId: "a", command: "GET", args: ["k"] };
    await cloudKvCommand("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_kv_command", { orgId: "org1", body });
  });

  it("cloudKvBrowserList", async () => {
    const body = { accountId: "a", resourceTypeId: "t", resourceId: "r" };
    await cloudKvBrowserList("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_kv_browser_list", { orgId: "org1", body });
  });

  it("cloudKvBrowserGet", async () => {
    const body = { accountId: "a", resourceTypeId: "t", resourceId: "r", key: "k" };
    await cloudKvBrowserGet("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_kv_browser_get", { orgId: "org1", body });
  });

  it("cloudKvBrowserPut", async () => {
    const body = { accountId: "a", resourceTypeId: "t", resourceId: "r", key: "k", value: "v" };
    await cloudKvBrowserPut("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_kv_browser_put", { orgId: "org1", body });
  });

  it("cloudKvBrowserDelete", async () => {
    const body = { accountId: "a", resourceTypeId: "t", resourceId: "r", key: "k" };
    await cloudKvBrowserDelete("org1", body);
    expect(invoke).toHaveBeenCalledWith("cloud_kv_browser_delete", { orgId: "org1", body });
  });
});
