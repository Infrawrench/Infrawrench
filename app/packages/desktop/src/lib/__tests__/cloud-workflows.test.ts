/**
 * The cloud WorkflowClient: every HTTP call goes over the cloud transport
 * (`CloudHttp`), typed from the contract's workflow and GitHub domains.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../rpc/client", async () => (await import("./fake-rpc")).fakeRpcClientModule);
vi.mock("../rpc/desktop-client", async () => (await import("./fake-rpc")).fakeRpcClientModule);

vi.mock("../cloud-ws", () => ({ getCloudWsUrl: async () => "ws://localhost:3000" }));

const { answerCloudHttp, resetFakeRpc } = await import("./fake-rpc");
const {
  createCloudApprovalsClient,
  createCloudWorkflowClient,
  getCloudGithubInstallUrl,
  getCloudGithubStatus,
  listCloudGithubRepos,
  listCloudWorkflows,
  pinCloudWorkflow,
  unpinCloudWorkflow,
} = await import("../cloud-workflows");

const ORG = "/api/org/org1";

beforeEach(() => {
  resetFakeRpc();
});

/** Every request the transport received, bodies parsed. */
function requests(http: ReturnType<typeof answerCloudHttp>) {
  return http.mock.calls.map(([request]) => ({
    method: request.method,
    url: request.url,
    ...(request.body === undefined ? {} : { body: JSON.parse(request.body) }),
  }));
}

const secret = { id: "s1", name: "TOKEN", hasValue: true };

describe("cloud-workflows wrappers", () => {
  it("listCloudWorkflows lists the org's workflows, with no secret assignment loaded yet", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [{ id: "w1" }] }));
    const res = await listCloudWorkflows("org1");
    expect(requests(http)).toEqual([{ method: "GET", url: `${ORG}/workflows` }]);
    expect(res).toEqual([{ id: "w1", assignedSecretIds: [] }]);
  });

  it("reads the GitHub connection for the git trigger", async () => {
    const repo = {
      installationId: 7,
      id: 1,
      fullName: "acme/infra",
      defaultBranch: "main",
      private: true,
    };
    const http = answerCloudHttp((request) => {
      if (request.url.endsWith("/github/status")) {
        return { status: 200, json: { configured: true, appSlug: "iw", installations: [] } };
      }
      if (request.url.endsWith("/github/repos")) return { status: 200, json: { repos: [repo] } };
      return { status: 200, json: { url: "https://github.com/apps/iw/installations/new" } };
    });
    await expect(getCloudGithubStatus("org1")).resolves.toMatchObject({ configured: true });
    await expect(listCloudGithubRepos("org1")).resolves.toEqual([repo]);
    await expect(getCloudGithubInstallUrl("org1")).resolves.toBe(
      "https://github.com/apps/iw/installations/new",
    );
    await getCloudGithubInstallUrl("org1", "agents");
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/github/status` },
      { method: "GET", url: `${ORG}/github/repos` },
      { method: "GET", url: `${ORG}/github/install-url?return=workflows` },
      { method: "GET", url: `${ORG}/github/install-url?return=agents` },
    ]);
  });

  it("pin/unpin a workflow card on a dashboard", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: { ok: true } }));
    await pinCloudWorkflow("org1", "dash1", "w1");
    await unpinCloudWorkflow("org1", "dash1", "w1");
    expect(requests(http)).toEqual([
      {
        method: "POST",
        url: `${ORG}/dashboards/workflow-pin`,
        body: { dashboardId: "dash1", workflowId: "w1" },
      },
      {
        method: "POST",
        url: `${ORG}/dashboards/workflow-unpin`,
        body: { dashboardId: "dash1", workflowId: "w1" },
      },
    ]);
  });
});

describe("createCloudWorkflowClient", () => {
  it("routes CRUD through the org-scoped calls", async () => {
    const http = answerCloudHttp((request) => {
      if (request.method === "DELETE") return { status: 200, json: { ok: true } };
      if (request.url.includes("/typings")) {
        return { status: 200, json: { dts: "declare const infra: any;" } };
      }
      if (request.url.endsWith("/workflows") && request.method === "GET") {
        return { status: 200, json: [{ id: "w1" }] };
      }
      if (request.url.endsWith("/runs") || request.url.endsWith("/metrics")) {
        return { status: 200, json: [] };
      }
      return { status: request.method === "POST" ? 201 : 200, json: { id: "w1" } };
    });
    const client = createCloudWorkflowClient("org1");

    await expect(client.list()).resolves.toEqual([{ id: "w1", assignedSecretIds: [] }]);
    await expect(client.create({ name: "New" })).resolves.toEqual({
      id: "w1",
      assignedSecretIds: [],
    });
    await client.update("w1", { source: "infra.log(1)" });
    await expect(client.listRuns("w1")).resolves.toEqual([]);
    await expect(client.listMetrics("w1")).resolves.toEqual([]);

    await client.remove("w1");
    await expect(client.getTypings("w1")).resolves.toBe("declare const infra: any;");
    await client.getTypings("w1", { enrich: true });
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/workflows` },
      { method: "POST", url: `${ORG}/workflows`, body: { name: "New" } },
      { method: "PUT", url: `${ORG}/workflows/w1`, body: { source: "infra.log(1)" } },
      { method: "GET", url: `${ORG}/workflows/w1/runs` },
      { method: "GET", url: `${ORG}/workflows/w1/metrics` },
      { method: "DELETE", url: `${ORG}/workflows/w1` },
      { method: "GET", url: `${ORG}/workflows/w1/typings` },
      { method: "GET", url: `${ORG}/workflows/w1/typings?enrich=1` },
    ]);
  });

  it("maps secret assignments and reusable secret operations", async () => {
    const client = createCloudWorkflowClient("org1");

    const update = answerCloudHttp(() => ({ status: 200, json: { id: "w1" } }));
    await client.update("w1", { assignedSecretIds: ["s1", "s2"] });
    expect(requests(update)).toEqual([
      { method: "PUT", url: `${ORG}/workflows/w1`, body: { secretIds: ["s1", "s2"] } },
    ]);

    const http = answerCloudHttp((request) => {
      if (request.url === `${ORG}/workflow-secrets` && request.method === "GET") {
        return { status: 200, json: [secret] };
      }
      if (request.url === `${ORG}/workflows/w1/secrets`) {
        return { status: 200, json: { secretIds: ["s1"], secrets: [secret] } };
      }
      if (request.method === "DELETE") return { status: 200, json: { ok: true } };
      return { status: 200, json: secret };
    });

    await expect(client.listSecrets()).resolves.toEqual([secret]);
    await expect(client.getAssignedSecrets("w1")).resolves.toEqual({
      assignedSecretIds: ["s1"],
      secrets: [secret],
    });
    await expect(client.upsertSecret({ name: "TOKEN", value: "write-only" })).resolves.toEqual(
      secret,
    );
    await client.upsertSecret({ id: "s1", name: "RENAMED", value: "v2" });
    await client.deleteSecret("s1");

    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/workflow-secrets` },
      { method: "GET", url: `${ORG}/workflows/w1/secrets` },
      // Create, then the value under the id the create answered with.
      { method: "POST", url: `${ORG}/workflow-secrets`, body: { name: "TOKEN" } },
      { method: "PUT", url: `${ORG}/workflow-secrets/s1/value`, body: { value: "write-only" } },
      // A rename, then the value.
      { method: "PATCH", url: `${ORG}/workflow-secrets/s1`, body: { name: "RENAMED" } },
      { method: "PUT", url: `${ORG}/workflow-secrets/s1/value`, body: { value: "v2" } },
      { method: "DELETE", url: `${ORG}/workflow-secrets/s1` },
    ]);
  });

  it("stops before writing a value when the save names no id", async () => {
    const http = answerCloudHttp(() => ({ status: 201, json: { ...secret, id: "" } }));
    const client = createCloudWorkflowClient("org1");
    await expect(client.upsertSecret({ name: "TOKEN", value: "v" })).rejects.toThrow(
      "Workflow secret save returned no id",
    );
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("does not write the value when the create is refused", async () => {
    const http = answerCloudHttp(() => ({ status: 409, json: { error: "Name taken" } }));
    const client = createCloudWorkflowClient("org1");
    await expect(client.upsertSecret({ name: "TOKEN", value: "v" })).rejects.toThrow(
      'Cloud request failed: 409 /workflow-secrets {"error":"Name taken"}',
    );
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("runs non-debug over HTTP rather than the websocket", async () => {
    const http = answerCloudHttp(() => ({
      status: 200,
      json: { runId: "r1", result: { status: "success", logs: [] } },
    }));
    const client = createCloudWorkflowClient("org1");
    const res = await client.run("w1");
    expect(requests(http)).toEqual([{ method: "POST", url: `${ORG}/workflows/w1/run` }]);
    expect(res.runId).toBe("r1");
  });

  it("lists and decides a workflow's pending approvals", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    const client = createCloudWorkflowClient("org1");
    await client.listPendingApprovals?.("w1");
    await client.decideApproval?.("a1", "deny");
    await client.decideApproval?.("a1", "approve");
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/workflow-approvals?status=pending&workflowId=w1` },
      { method: "POST", url: `${ORG}/workflow-approvals/a1/deny` },
      { method: "POST", url: `${ORG}/workflow-approvals/a1/approve` },
    ]);
  });
});

describe("createCloudApprovalsClient", () => {
  it("lists the inbox, filtered by status only when given", async () => {
    const http = answerCloudHttp(() => ({ status: 200, json: [] }));
    const client = createCloudApprovalsClient("org1");
    await client.list();
    await client.list("pending");
    expect(requests(http)).toEqual([
      { method: "GET", url: `${ORG}/workflow-approvals` },
      { method: "GET", url: `${ORG}/workflow-approvals?status=pending` },
    ]);
  });
});
