import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FireworksClient } from "../client.js";

const ACCOUNT = "acct-1";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let calls: FetchCall[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    url: string,
    init?: RequestInit,
  ) => {
    calls.push({ url: String(url), ...(init !== undefined && { init }) });
    return handler(String(url), init);
  }) as typeof fetch);
}

function client() {
  return new FireworksClient({ apiKey: "fw_test", accountId: "my-team" });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credentials", () => {
  it("refuses to construct without an account id", () => {
    // Fireworks has no whoami endpoint, so this cannot be discovered.
    expect(() => new FireworksClient({ apiKey: "fw_test" })).toThrow(/accountId/);
  });
});

describe("control plane", () => {
  it("puts the account id in every path and pins pageSize to the documented max", async () => {
    installFetch(() =>
      jsonResponse({ deployments: [{ name: "accounts/my-team/deployments/d1" }] }),
    );
    await client().listResources("deployment", ACCOUNT);
    expect(calls[0]?.url).toBe(
      "https://api.fireworks.ai/v1/accounts/my-team/deployments?pageSize=200",
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer fw_test");
  });

  it("follows nextPageToken until it is empty", async () => {
    installFetch((url) => {
      if (url.includes("pageToken=tok2")) {
        return jsonResponse({ models: [{ name: "accounts/my-team/models/m2" }] });
      }
      return jsonResponse({
        models: [{ name: "accounts/my-team/models/m1" }],
        nextPageToken: "tok2",
      });
    });
    const items = await client().listResources("model", ACCOUNT);
    expect(items.map((i) => i.externalId)).toEqual(["m1", "m2"]);
  });

  it("exposes the full resource name as the inference model string", async () => {
    installFetch(() =>
      jsonResponse({
        name: "accounts/my-team/models/llama-3",
        displayName: "Llama 3",
        contextLength: 8192,
        baseModelDetails: { parameterCount: "8030261248" },
      }),
    );
    const resource = await client().getResource("model", `${ACCOUNT}:model:llama-3`, ACCOUNT);
    expect(resource.resolvedOutputs["modelName"]).toBe("accounts/my-team/models/llama-3");
    // int64 fields arrive as JSON strings.
    expect(resource.fields["parameterCount"]).toBe("8,030,261,248");
  });

  it("lists every user's API keys via the `-` wildcard", async () => {
    installFetch(() => jsonResponse({ apiKeys: [{ keyId: "k1", displayName: "ci" }] }));
    const items = await client().listResources("api-key", ACCOUNT);
    expect(calls[0]?.url).toBe(
      "https://api.fireworks.ai/v1/accounts/my-team/users/-/apiKeys?pageSize=200",
    );
    // The identity is `keyId`: `gatewayApiKey` has no `name`.
    expect(items[0]?.externalId).toBe("k1");
  });
});

describe("deployments", () => {
  it("scales through the colon-suffix RPC, not an ordinary PATCH", async () => {
    installFetch((url, init) => {
      if (url.endsWith("/deployments/d1:scale")) return jsonResponse({});
      return jsonResponse({ name: "accounts/my-team/deployments/d1", replicaCount: 4 });
    });

    await client().updateResource("deployment", `${ACCOUNT}:deployment:d1`, ACCOUNT, {
      replicaCount: "4",
    });

    const scale = calls.find((c) => c.url.endsWith(":scale"));
    expect(scale?.init?.method).toBe("PATCH");
    expect(JSON.parse(scale!.init!.body as string)).toEqual({ replicaCount: 4 });
    // The replica window is a *different* call: it must not ride along on :scale.
    expect(
      calls.filter((c) => c.init?.method === "PATCH" && !c.url.endsWith(":scale")),
    ).toHaveLength(0);
  });

  it("sends the replica window through the ordinary PATCH", async () => {
    installFetch(() => jsonResponse({ name: "accounts/my-team/deployments/d1" }));
    await client().updateResource("deployment", `${ACCOUNT}:deployment:d1`, ACCOUNT, {
      minReplicaCount: "1",
      maxReplicaCount: "6",
    });
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch?.url).toBe("https://api.fireworks.ai/v1/accounts/my-team/deployments/d1");
    expect(JSON.parse(patch!.init!.body as string)).toEqual({
      minReplicaCount: 1,
      maxReplicaCount: 6,
    });
  });
});

describe("api keys", () => {
  it("wraps the create body and surfaces the once-only plaintext", async () => {
    installFetch(() =>
      jsonResponse({ keyId: "k9", displayName: "ci", key: "fw_secretvalue", prefix: "fw_se" }),
    );
    const result = await client().createResource("api-key", ACCOUNT, {
      userId: "alice",
      displayName: "ci",
    });
    expect(calls[0]?.url).toBe("https://api.fireworks.ai/v1/accounts/my-team/users/alice/apiKeys");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      apiKey: { displayName: "ci" },
    });
    expect("warnings" in result && result.warnings[0]?.message).toContain("fw_secretvalue");
  });

  it("deletes via the POST custom verb, not HTTP DELETE", async () => {
    installFetch((url) => {
      if (url.includes("apiKeys?pageSize")) {
        return jsonResponse({ apiKeys: [{ keyId: "k9", displayName: "ci" }] });
      }
      return jsonResponse({});
    });
    await client().deleteResource("api-key", `${ACCOUNT}:api-key:k9`, ACCOUNT);
    const del = calls[calls.length - 1];
    expect(del?.url).toBe("https://api.fireworks.ai/v1/accounts/my-team/users/-/apiKeys:delete");
    expect(del?.init?.method).toBe("POST");
    expect(JSON.parse(del!.init!.body as string)).toEqual({ keyId: "k9" });
  });
});

describe("costs", () => {
  it("groups by DAY + MODEL and converts google.type.Money to dollars", async () => {
    installFetch(() =>
      jsonResponse({
        rows: [
          {
            dimensions: {
              startTime: "2026-07-01T00:00:00Z",
              model: "accounts/my-team/models/llama-3",
            },
            // $12.50 → units 12, nanos 500,000,000.
            subtotal: { currencyCode: "USD", units: "12", nanos: 500000000 },
          },
          {
            dimensions: { startTime: "2026-07-02T00:00:00Z" },
            subtotal: { currencyCode: "USD", units: "0", nanos: 250000000 },
          },
        ],
      }),
    );

    const rows = await client().fetchCostData(ACCOUNT, {
      fromDate: "2026-07-01",
      toDate: "2026-07-05",
    });

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(calls[0]?.url).toBe("https://api.fireworks.ai/v1/accounts/my-team/usageCosts:query");
    expect(body.scope).toBe("ACCOUNT");
    // At most two dimensions, and HOUR/DAY are mutually exclusive.
    expect(body.groupBy).toEqual(["DAY", "MODEL"]);
    expect(body.startTime).toBe("2026-07-01T00:00:00Z");
    expect(body.endTime).toBe("2026-07-06T00:00:00Z");

    expect(rows).toEqual([
      { date: "2026-07-01", service: "llama-3", currency: "USD", amount: 12.5 },
      { date: "2026-07-02", currency: "USD", amount: 0.25 },
    ]);
  });

  it("falls back from ACCOUNT to SELF scope when the key is not an admin", async () => {
    let seenAccountScope = false;
    installFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { scope?: string };
      if (body.scope === "ACCOUNT") {
        seenAccountScope = true;
        return jsonResponse({ message: "permission denied" }, 403);
      }
      return jsonResponse({
        rows: [
          {
            dimensions: { startTime: "2026-07-01T00:00:00Z" },
            subtotal: { currencyCode: "USD", units: "1", nanos: 0 },
          },
        ],
      });
    });

    const rows = await client().fetchCostData(ACCOUNT, {
      fromDate: "2026-07-01",
      toDate: "2026-07-01",
    });
    expect(seenAccountScope).toBe(true);
    expect(rows).toEqual([{ date: "2026-07-01", currency: "USD", amount: 1 }]);
  });

  it("chunks a long range into windows the usage API accepts", async () => {
    installFetch(() => jsonResponse({ rows: [] }));
    await client().fetchCostData(ACCOUNT, { fromDate: "2026-01-01", toDate: "2026-03-31" });
    const windows = calls.map((c) => {
      const body = JSON.parse(String(c.init?.body ?? "{}")) as {
        startTime: string;
        endTime: string;
      };
      return [body.startTime.slice(0, 10), body.endTime.slice(0, 10)];
    });
    expect(windows).toEqual([
      ["2026-01-01", "2026-02-01"],
      ["2026-02-01", "2026-03-04"],
      ["2026-03-04", "2026-04-01"],
    ]);
  });
});

describe("metrics", () => {
  it("reads accelerator seconds off the dedicated split of billingUsage", async () => {
    installFetch(() =>
      jsonResponse({
        dedicatedCosts: [
          { deploymentId: "d1", startTime: "2026-07-01T00:00:00Z", acceleratorSeconds: "3600" },
          { deploymentId: "d1", startTime: "2026-07-02T00:00:00Z", acceleratorSeconds: "7200" },
          { deploymentId: "other", startTime: "2026-07-01T00:00:00Z", acceleratorSeconds: "99" },
        ],
      }),
    );
    const series = await client().fetchMetricSeries(
      "deployment",
      `${ACCOUNT}:deployment:d1`,
      ACCOUNT,
      { startMs: Date.parse("2026-07-01T00:00:00Z"), endMs: Date.parse("2026-07-03T00:00:00Z") },
    );
    expect(calls[0]?.url).toContain("usageType=DEDICATED_DEPLOYMENT");
    expect(calls[0]?.url).toContain("groupBy=deployment_name");
    expect(series[0]?.label).toBe("Accelerator Seconds");
    // int64 strings, and rows for other deployments filtered out.
    expect(series[0]?.points.map((p) => p.value)).toEqual([3600, 7200]);
  });
});

describe("jobs", () => {
  it("reads the batch job end stamp from lifecycle, which has no completionTime", async () => {
    installFetch(() =>
      jsonResponse({
        name: "accounts/my-team/batchInferenceJobs/b1",
        state: "JOB_STATE_COMPLETED",
        lifecycle: { runStartTime: "2026-07-01T01:00:00Z", endTime: "2026-07-01T02:00:00Z" },
        jobProgress: { percent: 100, totalInputRequests: 500, failedRequests: 2 },
      }),
    );
    const resource = await client().getResource(
      "batch-inference-job",
      `${ACCOUNT}:batch-inference-job:b1`,
      ACCOUNT,
    );
    expect(resource.fields["endTime"]).toBe("2026-07-01T02:00:00Z");
    expect(resource.fields["failedRequests"]).toBe(2);
    const c = client();
    expect(c.renderSidebarItem(resource).status).toEqual({
      kind: "status-dot",
      status: "healthy",
      label: "Completed",
    });
  });

  it("uses completedTime, not completionTime, on fine-tuning jobs", async () => {
    installFetch(() =>
      jsonResponse({
        name: "accounts/my-team/supervisedFineTuningJobs/s1",
        state: "JOB_STATE_RUNNING",
        completedTime: "2026-07-02T00:00:00Z",
        estimatedCost: { currencyCode: "USD", units: "3", nanos: 250000000 },
      }),
    );
    const resource = await client().getResource(
      "supervised-fine-tuning-job",
      `${ACCOUNT}:supervised-fine-tuning-job:s1`,
      ACCOUNT,
    );
    expect(resource.fields["completedTime"]).toBe("2026-07-02T00:00:00Z");
    expect(resource.fields["estimatedCost"]).toBe(3.25);
  });
});

describe("routers", () => {
  it("creates a router with the picked deployments and the strategy oneof", async () => {
    installFetch((url, init) => {
      if (init?.method === "POST") {
        return jsonResponse({
          name: "accounts/my-team/routers/r1",
          displayName: "Router",
          state: "CREATING",
          deployments: ["accounts/my-team/deployments/d1", "accounts/my-team/deployments/d2"],
          evenLoad: {},
          public: false,
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await client().createResource("router", ACCOUNT, {
      routerId: "r1",
      displayName: "Router",
      deployments: JSON.stringify([
        "accounts/my-team/deployments/d1",
        "accounts/my-team/deployments/d2",
      ]),
      model: "",
      strategy: "evenLoad",
      public: "false",
    });

    expect(calls[0]?.url).toBe("https://api.fireworks.ai/v1/accounts/my-team/routers?routerId=r1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      displayName: "Router",
      deployments: ["accounts/my-team/deployments/d1", "accounts/my-team/deployments/d2"],
      evenLoad: {},
      public: false,
    });
    const resource = "resource" in result ? result.resource : result;
    expect(resource.fields["strategy"]).toBe("evenLoad");
    expect(resource.resolvedOutputs["routerName"]).toBe("accounts/my-team/routers/r1");
  });

  it("offers the account's deployments in the multi-select", async () => {
    installFetch(() =>
      jsonResponse({
        deployments: [
          {
            name: "accounts/my-team/deployments/d1",
            displayName: "Prod",
            baseModel: "accounts/fireworks/models/llama",
          },
        ],
      }),
    );
    const config = await client().getCreateConfig("router");
    const picker = config.fields.find((field) => field.key === "deployments");
    expect(picker?.kind).toBe("policy-picker");
    expect(picker?.policies?.[0]?.id).toBe("accounts/my-team/deployments/d1");
    const model = config.fields.find((field) => field.key === "model");
    expect(model?.options?.map((option) => option.id)).toEqual([
      "",
      "accounts/fireworks/models/llama",
    ]);
  });

  it("refuses to edit a system-generated router", async () => {
    installFetch(() =>
      jsonResponse({ name: "accounts/my-team/routers/auto", autoGenerated: true }),
    );
    await expect(
      client().updateResource("router", `${ACCOUNT}:router:auto`, ACCOUNT, { displayName: "x" }),
    ).rejects.toThrow(/generated by Fireworks/);
    expect(calls.every((call) => call.init?.method !== "PATCH")).toBe(true);
  });
});

describe("training jobs", () => {
  it("lifts DPO base and output models out of trainingConfig", async () => {
    installFetch(() =>
      jsonResponse({
        dpoJobs: [
          {
            name: "accounts/my-team/dpoJobs/j1",
            state: "JOB_STATE_RUNNING",
            dataset: "accounts/my-team/datasets/prefs",
            trainingConfig: {
              baseModel: "accounts/fireworks/models/llama",
              outputModel: "accounts/my-team/models/tuned",
              epochs: 2,
            },
            lossConfig: { method: "DPO", klBeta: 0.1 },
          },
        ],
      }),
    );
    const [job] = await client().listResources("dpo-job", ACCOUNT);
    expect(calls[0]?.url).toBe("https://api.fireworks.ai/v1/accounts/my-team/dpoJobs?pageSize=200");
    expect(job?.fields).toMatchObject({
      baseModel: "accounts/fireworks/models/llama",
      outputModel: "accounts/my-team/models/tuned",
      lossMethod: "DPO",
      klBeta: 0.1,
      epochs: 2,
    });
    expect(job?.displayName).toBe("accounts/my-team/models/tuned");
  });

  it("cancels and resumes RFT jobs through the colon verbs, and resumes DPO jobs", async () => {
    installFetch(() => jsonResponse({}));
    await client().invokeAction(
      "reinforcement-fine-tuning-job",
      `${ACCOUNT}:reinforcement-fine-tuning-job:r1`,
      "cancel",
      ACCOUNT,
    );
    await client().invokeAction("dpo-job", `${ACCOUNT}:dpo-job:d1`, "resume", ACCOUNT);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.fireworks.ai/v1/accounts/my-team/reinforcementFineTuningJobs/r1:cancel",
      "https://api.fireworks.ai/v1/accounts/my-team/dpoJobs/d1:resume",
    ]);
    await expect(
      client().invokeAction("dpo-job", `${ACCOUNT}:dpo-job:d1`, "cancel", ACCOUNT),
    ).rejects.toThrow(/unknown action/);
  });
});

describe("evaluators, users, secrets and quotas", () => {
  it("maps evaluator state and source", async () => {
    installFetch(() =>
      jsonResponse({
        evaluators: [
          {
            name: "accounts/my-team/evaluators/e1",
            displayName: "Math grader",
            state: "BUILD_FAILED",
            source: { type: "TYPE_GITHUB", githubRepositoryName: "org/repo" },
          },
        ],
      }),
    );
    const [evaluator] = await client().listResources("evaluator", ACCOUNT);
    expect(evaluator?.fields).toMatchObject({ sourceType: "Github", githubRepository: "org/repo" });
    expect(client().renderSidebarItem(evaluator!).status?.status).toBe("error");
  });

  it("invites a member with a role", async () => {
    installFetch(() =>
      jsonResponse({ name: "accounts/my-team/users/u1", email: "a@example.com", role: "user" }),
    );
    await client().createResource("user", ACCOUNT, {
      kind: "member",
      email: "a@example.com",
      role: "user",
    });
    expect(calls[0]?.url).toBe("https://api.fireworks.ai/v1/accounts/my-team/users");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      role: "user",
      email: "a@example.com",
    });
  });

  it("derives the secret id from the key name", async () => {
    installFetch(() => jsonResponse({ name: "accounts/my-team/secrets/wandb-api-key" }));
    const result = await client().createResource("secret", ACCOUNT, {
      keyName: "WANDB_API_KEY",
      value: "s3cret",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "accounts/my-team/secrets/wandb-api-key",
      keyName: "WANDB_API_KEY",
      value: "s3cret",
    });
    const resource = "resource" in result ? result.resource : result;
    expect(JSON.stringify(resource)).not.toContain("s3cret");
  });

  it("patches the quota limit as an int64 string", async () => {
    installFetch((_url, init) =>
      init?.method === "PATCH"
        ? jsonResponse({})
        : jsonResponse({ name: "accounts/my-team/quotas/h100-us-iowa-1", value: "4" }),
    );
    await client().updateResource("quota", `${ACCOUNT}:quota:h100-us-iowa-1`, ACCOUNT, {
      value: "4",
    });
    const patch = calls.find((call) => call.init?.method === "PATCH");
    expect(patch?.url).toBe("https://api.fireworks.ai/v1/accounts/my-team/quotas/h100-us-iowa-1");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ value: "4" });
  });
});
