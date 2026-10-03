import { describe, it, expect, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import * as listers from "../resource-listers.js";
import type { ListerContext } from "../resource-listers.js";
import type { AzureHttpContext } from "../shared.js";
import type { AzureCreateContext } from "../create-handlers-shared.js";
import { AZURE_ACTIONS, azureActionButtons, invokeAzureAction } from "../actions.js";
import {
  createContainerApp,
  getContainerAppCreateConfig,
  updateContainerApp,
} from "../container-app-create-handlers.js";
import { resolveAzureOutput } from "../output-resolver.js";
import { fetchAzureCommitments, mapAzureSavingsPlan } from "../commitments.js";
import { azureTerraformExport } from "../terraform.js";
import { plugin } from "../plugin.js";

const ACCT = "acct";
const SUB = "/subscriptions/sub1/resourceGroups/rg1/providers";

function listerCtx(getImpl: (url: string) => unknown): ListerContext {
  return {
    get: vi.fn(async (url: string) => getImpl(url)) as ListerContext["get"],
    post: vi.fn(async () => ({})) as ListerContext["post"],
    put: vi.fn(async () => ({})) as ListerContext["put"],
    del: vi.fn(async () => undefined),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2024-01-01T00:00:00Z",
    subscriptionId: "sub1",
  };
}

function httpCtx(overrides: Partial<AzureHttpContext> = {}): AzureHttpContext {
  return {
    get: vi.fn(async () => ({})) as AzureHttpContext["get"],
    post: vi.fn(async () => ({})) as AzureHttpContext["post"],
    put: vi.fn(async () => ({})) as AzureHttpContext["put"],
    patch: vi.fn(async () => ({})) as AzureHttpContext["patch"],
    del: vi.fn(async () => undefined),
    http: undefined,
    subscriptionId: "sub1",
    tenantId: "t1",
    ...overrides,
  };
}

function instance(
  resourceTypeId: string,
  fields: Record<string, string | number | boolean>,
  resolvedOutputs: Record<string, string> = {},
): ResourceInstance {
  return {
    id: `acct:${resourceTypeId}:rg1/x1`,
    pluginId: "azure",
    resourceTypeId,
    accountId: ACCT,
    displayName: "x1",
    fields: { name: "x1", resourceGroup: "rg1", ...fields },
    resolvedOutputs,
    secretStates: [],
    externalId: "rg1/x1",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

describe("listContainerApps", () => {
  it("maps template, scale, ingress and the environment, following nextLink", async () => {
    const ctx = listerCtx((url) => {
      if (url.includes("skiptoken")) return { value: [] };
      return {
        value: [
          {
            id: `${SUB}/Microsoft.App/containerApps/api`,
            name: "api",
            location: "East US",
            identity: {
              userAssignedIdentities: {
                [`${SUB}/Microsoft.ManagedIdentity/userAssignedIdentities/id1`]: {},
              },
            },
            properties: {
              provisioningState: "Succeeded",
              runningStatus: "Running",
              environmentId: `${SUB}/Microsoft.App/managedEnvironments/env1`,
              latestRevisionName: "api--r2",
              latestRevisionFqdn: "api--r2.env.eastus.azurecontainerapps.io",
              outboundIpAddresses: ["20.1.1.1", "20.1.1.2"],
              workloadProfileName: "Consumption",
              configuration: {
                activeRevisionsMode: "Single",
                ingress: {
                  external: true,
                  targetPort: 8080,
                  fqdn: "api.env.azurecontainerapps.io",
                },
                registries: [{ server: "myacr.azurecr.io" }],
              },
              template: {
                containers: [
                  {
                    name: "api",
                    image: "myacr.azurecr.io/api:1.4",
                    resources: { cpu: 0.5, memory: "1Gi" },
                  },
                ],
                scale: { minReplicas: 1, maxReplicas: 5 },
              },
            },
          },
        ],
        nextLink: "https://management.azure.com/next?$skiptoken=1",
      };
    });
    const [app] = await listers.listContainerApps(ctx, ACCT);
    expect(ctx.get).toHaveBeenCalledTimes(2);
    expect(app).toMatchObject({
      resourceTypeId: "azure-container-app",
      externalId: "rg1/api",
      fields: {
        environment: "env1",
        runningStatus: "Running",
        image: "myacr.azurecr.io/api:1.4",
        cpu: 0.5,
        memory: "1Gi",
        minReplicas: 1,
        maxReplicas: 5,
        ingress: "External",
        targetPort: 8080,
        containerRegistry: "myacr.azurecr.io",
        managedIdentities: "id1",
      },
      resolvedOutputs: {
        fqdn: "api.env.azurecontainerapps.io",
        url: "https://api.env.azurecontainerapps.io",
        outboundIpAddresses: "20.1.1.1, 20.1.1.2",
      },
    });
  });

  it("falls back to the deprecated managedEnvironmentId and reports no ingress", async () => {
    const ctx = listerCtx(() => ({
      value: [
        {
          id: `${SUB}/Microsoft.App/containerApps/worker`,
          name: "worker",
          properties: {
            managedEnvironmentId: `${SUB}/Microsoft.App/managedEnvironments/legacy`,
            template: { containers: [{ image: "busybox" }] },
          },
        },
      ],
    }));
    const [app] = await listers.listContainerApps(ctx, ACCT);
    expect(app!.fields).toMatchObject({
      environment: "legacy",
      ingress: "Disabled",
      minReplicas: 0,
      maxReplicas: 10,
      containerRegistry: "",
    });
    expect(app!.resolvedOutputs["url"]).toBe("");
  });
});

describe("listContainerAppEnvironments / listContainerAppJobs", () => {
  it("maps workload profiles, VNet and logging on environments", async () => {
    const ctx = listerCtx(() => ({
      value: [
        {
          id: `${SUB}/Microsoft.App/managedEnvironments/env1`,
          name: "env1",
          location: "North Central US",
          properties: {
            provisioningState: "Succeeded",
            defaultDomain: "env1.k4apps.io",
            staticIp: "20.42.33.145",
            zoneRedundant: true,
            vnetConfiguration: {
              internal: true,
              infrastructureSubnetId:
                "/subscriptions/sub1/resourceGroups/net/providers/Microsoft.Network/virtualNetworks/v1/subnets/s1",
            },
            appLogsConfiguration: { destination: "log-analytics" },
            workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
          },
        },
      ],
    }));
    const [env] = await listers.listContainerAppEnvironments(ctx, ACCT);
    expect(env!.fields).toMatchObject({
      zoneRedundant: true,
      internalOnly: true,
      subnetRef: "net/v1/s1",
      logsDestination: "log-analytics",
      workloadProfiles: "Consumption: Consumption",
    });
    expect(env!.resolvedOutputs["defaultDomain"]).toBe("env1.k4apps.io");
  });

  it("maps a scheduled job's trigger and template", async () => {
    const ctx = listerCtx(() => ({
      value: [
        {
          id: `${SUB}/Microsoft.App/jobs/nightly`,
          name: "nightly",
          properties: {
            provisioningState: "Succeeded",
            environmentId: `${SUB}/Microsoft.App/managedEnvironments/env1`,
            configuration: {
              triggerType: "Schedule",
              replicaTimeout: 1800,
              replicaRetryLimit: 2,
              scheduleTriggerConfig: { cronExpression: "0 3 * * *", parallelism: 2 },
            },
            template: {
              containers: [{ image: "repo/job:v1", resources: { cpu: 1, memory: "2Gi" } }],
            },
          },
        },
      ],
    }));
    const [job] = await listers.listContainerAppJobs(ctx, ACCT);
    expect(job!.fields).toMatchObject({
      environment: "env1",
      triggerType: "Schedule",
      cronExpression: "0 3 * * *",
      parallelism: 2,
      replicaTimeout: 1800,
      image: "repo/job:v1",
    });
  });
});

describe("listManagedRedis", () => {
  it("folds the default database into the cluster", async () => {
    const clusterId = `${SUB}/Microsoft.Cache/redisEnterprise/cache1`;
    const ctx = listerCtx((url) => {
      if (url.includes("/databases?")) {
        return {
          value: [
            {
              properties: {
                port: 10000,
                clientProtocol: "Encrypted",
                clusteringPolicy: "OSSCluster",
                evictionPolicy: "VolatileLRU",
                accessKeysAuthentication: "Enabled",
                modules: [{ name: "RedisJSON" }, { name: "RediSearch" }],
                persistence: { aofEnabled: false, rdbEnabled: true },
              },
            },
          ],
        };
      }
      return {
        value: [
          {
            id: clusterId,
            name: "cache1",
            location: "West US",
            sku: { name: "Balanced_B5" },
            properties: {
              hostName: "cache1.westus.redis.azure.net",
              provisioningState: "Succeeded",
              resourceState: "Running",
              highAvailability: "Enabled",
              publicNetworkAccess: "Disabled",
            },
          },
        ],
      };
    });
    const [redis] = await listers.listManagedRedis(ctx, ACCT);
    expect(redis).toMatchObject({
      resourceTypeId: "azure-managed-redis",
      fields: {
        sku: "Balanced_B5",
        clientProtocol: "Encrypted",
        modules: "RedisJSON, RediSearch",
        persistence: "RDB",
        accessKeysAuthentication: "Enabled",
      },
      resolvedOutputs: { hostName: "cache1.westus.redis.azure.net", port: "10000" },
    });
    expect(ctx.get).toHaveBeenCalledWith(
      `https://management.azure.com${clusterId}/databases?api-version=2025-07-01`,
    );
  });

  it("still lists the cluster when the database call fails", async () => {
    const ctx = listerCtx((url) => {
      if (url.includes("/databases?")) throw new Error("403");
      return { value: [{ id: `${SUB}/Microsoft.Cache/redisEnterprise/c2`, name: "c2" }] };
    });
    const [redis] = await listers.listManagedRedis(ctx, ACCT);
    expect(redis!.fields["persistence"]).toBe("");
    expect(redis!.resolvedOutputs["port"]).toBe("10000");
  });
});

describe("listAIServicesAccounts", () => {
  it("lists accounts with their model deployments", async () => {
    const accountId = `${SUB}/Microsoft.CognitiveServices/accounts/ai1`;
    const ctx = listerCtx((url) => {
      if (url.includes("/deployments?")) {
        return {
          value: [
            {
              name: "chat",
              sku: { name: "GlobalStandard", capacity: 50 },
              properties: { model: { name: "gpt-4o", version: "2024-11-20" } },
            },
            { name: "embed", properties: { model: { name: "text-embedding-3-large" } } },
          ],
        };
      }
      return {
        value: [
          {
            id: accountId,
            name: "ai1",
            kind: "AIServices",
            location: "eastus",
            sku: { name: "S0" },
            properties: {
              endpoint: "https://ai1.cognitiveservices.azure.com/",
              provisioningState: "Succeeded",
              customSubDomainName: "ai1",
              disableLocalAuth: true,
            },
          },
        ],
      };
    });
    const [account] = await listers.listAIServicesAccounts(ctx, ACCT);
    expect(account).toMatchObject({
      resourceTypeId: "azure-ai-services",
      fields: {
        kind: "AIServices",
        localAuthEnabled: false,
        deploymentCount: 2,
        deployments:
          "chat (gpt-4o 2024-11-20, GlobalStandard x 50), embed (text-embedding-3-large)",
      },
      resolvedOutputs: { endpoint: "https://ai1.cognitiveservices.azure.com/" },
    });
  });

  it("treats a failing deployments call as no deployments", async () => {
    const ctx = listerCtx((url) => {
      if (url.includes("/deployments?")) throw new Error("400");
      return { value: [{ id: `${SUB}/Microsoft.CognitiveServices/accounts/sp`, kind: "Speech" }] };
    });
    const [account] = await listers.listAIServicesAccounts(ctx, ACCT);
    expect(account!.fields["deploymentCount"]).toBe(0);
    expect(account!.fields["localAuthEnabled"]).toBe(true);
  });
});

describe("actions", () => {
  it("every lifecycle declaration names actions the table accepts", () => {
    for (const rt of plugin.resourceTypes) {
      if (!rt.lifecycle) continue;
      expect(AZURE_ACTIONS[rt.id]?.[rt.lifecycle.startActionId], rt.id).toBeDefined();
      expect(AZURE_ACTIONS[rt.id]?.[rt.lifecycle.stopActionId], rt.id).toBeDefined();
    }
  });

  it("shows Stop and Restart on a running app, Start on a stopped one", () => {
    const running = azureActionButtons(instance("azure-app-service", { state: "Running" }));
    expect(running.map((b) => b.label)).toEqual(["Stop", "Restart"]);
    const stopped = azureActionButtons(instance("azure-app-service", { state: "Stopped" }));
    expect(stopped.map((b) => b.label)).toEqual(["Start"]);
  });

  it("keeps the VM's deallocate-as-Stop button", () => {
    const [stop] = azureActionButtons(instance("azure-vm", { powerState: "VM running" }));
    expect(stop).toMatchObject({
      label: "Stop",
      variant: "danger",
      action: { type: "plugin-action", actionId: "deallocate" },
    });
  });

  it("offers Run now on a container apps job", () => {
    const buttons = azureActionButtons(instance("azure-container-app-job", {}));
    expect(buttons.map((b) => b.label)).toEqual(["Run now"]);
  });

  it("POSTs to the provider action path with the type's api-version", async () => {
    const ctx = httpCtx();
    await invokeAzureAction(ctx, instance("azure-aks-cluster", {}), "stop");
    expect(ctx.post).toHaveBeenCalledWith(
      `https://management.azure.com${SUB}/Microsoft.ContainerService/managedClusters/x1/stop?api-version=2024-01-01`,
      {},
    );
  });

  it("sends MySQL's required restart body", async () => {
    const ctx = httpCtx();
    await invokeAzureAction(ctx, instance("azure-mysql-flexible", {}), "restart");
    expect(ctx.post).toHaveBeenCalledWith(
      expect.stringContaining(
        "Microsoft.DBforMySQL/flexibleServers/x1/restart?api-version=2023-06-30",
      ),
      { restartWithFailover: "Disabled" },
    );
  });

  it("maps the job's run action to Jobs/start", async () => {
    const ctx = httpCtx();
    await invokeAzureAction(ctx, instance("azure-container-app-job", {}), "run");
    expect(ctx.post).toHaveBeenCalledWith(
      `https://management.azure.com${SUB}/Microsoft.App/jobs/x1/start?api-version=2025-07-01`,
      {},
    );
  });

  it("rejects unknown actions", async () => {
    await expect(invokeAzureAction(httpCtx(), instance("azure-disk", {}), "start")).rejects.toThrow(
      /not supported/,
    );
  });
});

describe("container app create / update", () => {
  function createCtx(get: (url: string) => unknown) {
    const ctx = {
      get: vi.fn(async (url: string) => get(url)),
      post: vi.fn(async () => ({ username: "acr", passwords: [{ value: "pw" }] })),
      put: vi.fn(async () => ({
        id: `${SUB}/Microsoft.App/containerApps/ca1`,
        properties: { configuration: { ingress: { fqdn: "ca1.env.io" } } },
      })),
      patch: vi.fn(async () => ({})),
      del: vi.fn(async () => undefined),
      makeId: (a: string, t: string, e: string) => `${a}:${t}:${e}`,
      graphClient: {} as never,
      subscriptionId: "sub1",
      tenantId: "t1",
      clientId: "c1",
      clientSecret: "s1",
    };
    return ctx as typeof ctx & AzureCreateContext;
  }

  it("offers environments and registries as pickers", async () => {
    const ctx = createCtx((url) => {
      if (url.includes("managedEnvironments")) {
        return { value: [{ id: "/env/1", name: "env1", location: "eastus" }] };
      }
      if (url.includes("registries")) {
        return {
          value: [{ id: "/acr/1", name: "acr", properties: { loginServer: "acr.azurecr.io" } }],
        };
      }
      return { value: [{ name: "rg1" }] };
    });
    const config = await getContainerAppCreateConfig(ctx);
    const env = config.fields.find((f) => f.key === "environmentId");
    expect(env?.options).toEqual([{ id: "/env/1", label: "env1", description: "eastus" }]);
    const registry = config.fields.find((f) => f.key === "registryId");
    expect(registry?.options?.[0]).toMatchObject({ id: "/acr/1", label: "acr.azurecr.io" });
  });

  it("creates in the environment's region with registry credentials as a secret", async () => {
    const ctx = createCtx((url) => {
      if (url.includes("managedEnvironments")) return { location: "westeurope" };
      return { properties: { loginServer: "myacr.azurecr.io" } };
    });
    const out = await createContainerApp(ctx, ACCT, {
      name: "ca1",
      resourceGroup: "rg1",
      environmentId: `${SUB}/Microsoft.App/managedEnvironments/env1`,
      image: "myacr.azurecr.io/api:1",
      registryId: `${SUB}/Microsoft.ContainerRegistry/registries/myacr`,
      size: "1|2Gi",
      ingress: "internal",
      targetPort: "3000",
      minReplicas: "1",
      maxReplicas: "3",
    });
    interface PutBody {
      location: string;
      properties: {
        configuration: Record<string, unknown>;
        template: {
          containers: Array<{ resources: unknown }>;
          scale: unknown;
        };
      };
    }
    const [, body] = ctx.put.mock.calls[0] as unknown as [string, PutBody];
    expect(body.location).toBe("westeurope");
    expect(body.properties.configuration.ingress).toEqual({
      external: false,
      targetPort: 3000,
      transport: "auto",
    });
    expect(body.properties.configuration.registries).toEqual([
      { server: "myacr.azurecr.io", username: "acr", passwordSecretRef: "acr-myacr" },
    ]);
    expect(body.properties.configuration.secrets).toEqual([{ name: "acr-myacr", value: "pw" }]);
    expect(body.properties.template.containers[0]!.resources).toEqual({ cpu: 1, memory: "2Gi" });
    expect(body.properties.template.scale).toEqual({ minReplicas: 1, maxReplicas: 3 });
    expect(out.resolvedOutputs["url"]).toBe("https://ca1.env.io");
  });

  it("refuses a registry whose admin user is disabled", async () => {
    const ctx = createCtx((url) =>
      url.includes("managedEnvironments") ? { location: "eastus" } : { properties: {} },
    );
    ctx.post.mockResolvedValueOnce({} as never);
    await expect(
      createContainerApp(ctx, ACCT, {
        name: "ca1",
        resourceGroup: "rg1",
        environmentId: "/env",
        image: "x",
        registryId: "/acr",
      }),
    ).rejects.toThrow(/admin user is disabled/);
  });

  it("patches the template, keeping containers and scale rules it did not touch", async () => {
    const current = {
      properties: {
        template: {
          containers: [
            { name: "api", image: "api:1", resources: { cpu: 0.5, memory: "1Gi" } },
            { name: "sidecar", image: "envoy:1" },
          ],
          scale: { minReplicas: 0, maxReplicas: 10, rules: [{ name: "http" }] },
        },
      },
    };
    const ctx = httpCtx({ get: vi.fn(async () => current) as AzureHttpContext["get"] });
    await updateContainerApp(ctx, instance("azure-container-app", {}), {
      image: "api:2",
      cpu: "1",
      memory: "2Gi",
      minReplicas: "1",
      maxReplicas: "",
    });
    const [url, body] = (ctx.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain("Microsoft.App/containerApps/x1?api-version=2025-07-01");
    expect(body).toEqual({
      properties: {
        template: {
          containers: [
            { name: "api", image: "api:2", resources: { cpu: 1, memory: "2Gi" } },
            { name: "sidecar", image: "envoy:1" },
          ],
          scale: { minReplicas: 1, maxReplicas: 10, rules: [{ name: "http" }] },
        },
      },
    });
    // The GET response itself is left untouched.
    expect(current.properties.template.containers[0]!.image).toBe("api:1");
  });

  it("rejects min replicas above max", async () => {
    const ctx = httpCtx({
      get: vi.fn(async () => ({
        properties: { template: { containers: [{ image: "a" }], scale: { maxReplicas: 2 } } },
      })) as AzureHttpContext["get"],
    });
    await expect(
      updateContainerApp(ctx, instance("azure-container-app", {}), { minReplicas: "5" }),
    ).rejects.toThrow(/cannot exceed/);
  });
});

describe("output resolution for new types", () => {
  function deps(resource: ResourceInstance, post: AzureHttpContext["post"]) {
    return {
      ctx: httpCtx({ post }),
      getResource: async () => resource,
      exportAppRegistrationSecret: async () => "",
    };
  }

  it("builds a rediss:// URI for Managed Redis from the default database's key", async () => {
    const post = vi.fn(async () => ({ primaryKey: "k/+=" })) as AzureHttpContext["post"];
    const resource = instance(
      "azure-managed-redis",
      { clientProtocol: "Encrypted", accessKeysAuthentication: "Enabled" },
      { hostName: "c.westus.redis.azure.net", port: "10000" },
    );
    const uri = await resolveAzureOutput(
      deps(resource, post),
      "azure-managed-redis",
      resource.id,
      "connectionString",
      ACCT,
    );
    expect(uri).toBe("rediss://:k%2F%2B%3D@c.westus.redis.azure.net:10000");
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining(
        "redisEnterprise/x1/databases/default/listKeys?api-version=2025-07-01",
      ),
      {},
    );
  });

  it("explains disabled access keys instead of calling listKeys", async () => {
    const post = vi.fn() as AzureHttpContext["post"];
    const resource = instance("azure-managed-redis", { accessKeysAuthentication: "Disabled" });
    await expect(
      resolveAzureOutput(
        deps(resource, post),
        "azure-managed-redis",
        resource.id,
        "primaryKey",
        ACCT,
      ),
    ).rejects.toThrow(/Access keys are disabled/);
    expect(post).not.toHaveBeenCalled();
  });

  it("resolves an AI services key via listKeys", async () => {
    const post = vi.fn(async () => ({ key1: "abc", key2: "def" })) as AzureHttpContext["post"];
    const resource = instance("azure-ai-services", { localAuthEnabled: true });
    const key = await resolveAzureOutput(
      deps(resource, post),
      "azure-ai-services",
      resource.id,
      "apiKey",
      ACCT,
    );
    expect(key).toBe("abc");
  });
});

describe("savings plans", () => {
  const plan = {
    id: "/providers/microsoft.billingbenefits/savingsPlanOrders/o1/savingsPlans/p1",
    sku: { name: "Compute_Savings_Plan" },
    properties: {
      displayName: "Compute_SavingsPlan_10-19-2022",
      provisioningState: "Succeeded",
      effectiveDateTime: "2022-10-19T18:05:37Z",
      expiryDateTime: "2023-10-19T18:05:36Z",
      term: "P1Y",
      billingPlan: "P1M",
      appliedScopeType: "Single",
      commitment: { amount: 0.5, currencyCode: "USD", grain: "Hourly" },
      utilization: {
        aggregates: [{ grain: 7, grainUnit: "days", value: 78, valueUnit: "percentage" }],
      },
    },
  };

  it("maps the hourly commitment, term and utilization", () => {
    expect(mapAzureSavingsPlan(plan)).toEqual({
      id: "/providers/microsoft.billingbenefits/savingsplanorders/o1/savingsplans/p1",
      kind: "savings_plan",
      description: "Compute_SavingsPlan_10-19-2022 · Compute Savings Plan",
      scope: "Single",
      startDate: "2022-10-19T18:05:37Z",
      endDate: "2023-10-19T18:05:36Z",
      termDays: 365,
      paymentOption: "monthly",
      currency: "USD",
      hourlyCommitmentAmount: 0.5,
      state: "active",
      providerUtilization: [{ grainDays: 7, percentage: 78 }],
    });
  });

  it("collects savings plans after reservations, and survives a refused list", async () => {
    const ok = await fetchAzureCommitments({
      getJson: async <T>(url: string): Promise<T> =>
        (url.includes("BillingBenefits")
          ? { value: [plan] }
          : { value: [{ id: "/r/1", properties: { provisioningState: "Succeeded" } }] }) as T,
    });
    expect(ok.map((r) => r.kind)).toEqual(["reservation", "savings_plan"]);

    const refused = await fetchAzureCommitments({
      getJson: async <T>(url: string): Promise<T> => {
        if (url.includes("BillingBenefits")) throw new Error("Azure API 403");
        return { value: [{ id: "/r/1", properties: { provisioningState: "Succeeded" } }] } as T;
      },
    });
    expect(refused.map((r) => r.id)).toEqual(["/r/1"]);
  });
});

describe("terraform for new types", () => {
  it("exports a cognitive account with the full ARM id as import id", () => {
    const resource = instance(
      "azure-ai-services",
      {
        location: "eastus",
        kind: "OpenAI",
        sku: "S0",
        customSubDomainName: "x1",
        localAuthEnabled: false,
      },
      {
        resourceId: `/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.CognitiveServices/accounts/x1`,
      },
    );
    expect(azureTerraformExport.mapResource(resource)).toMatchObject({
      resource: {
        type: "azurerm_cognitive_account",
        importId:
          "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.CognitiveServices/accounts/x1",
        attributes: {
          kind: { value: "OpenAI" },
          custom_subdomain_name: { value: "x1" },
          local_auth_enabled: { value: false },
        },
      },
    });
  });

  it("exports Managed Redis and a Container Apps environment", () => {
    expect(
      azureTerraformExport.mapResource(
        instance("azure-managed-redis", { location: "westus", sku: "Balanced_B5" }),
      ),
    ).toMatchObject({ resource: { type: "azurerm_managed_redis", importId: "rg1/x1" } });
    expect(
      azureTerraformExport.mapResource(
        instance("azure-container-app-environment", { location: "eastus", zoneRedundant: true }),
      ),
    ).toMatchObject({
      resource: {
        type: "azurerm_container_app_environment",
        attributes: { zone_redundancy_enabled: { value: true } },
      },
    });
  });
});

describe("AzureClient actions and edits", () => {
  const creds = { tenantId: "t1", clientId: "c1", clientSecret: "s1", subscriptionId: "sub1" };
  const appList = {
    value: [
      {
        id: `${SUB}/Microsoft.App/containerApps/ca1`,
        name: "ca1",
        properties: { runningStatus: "Running", template: { containers: [{ image: "a:1" }] } },
      },
    ],
  };

  function response(status: number, body: unknown): Response {
    const text = body === undefined ? "" : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null } as unknown as Headers,
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  }

  it("treats an empty 202 from a stop action as success", async () => {
    const { AzureClient } = await import("../client.js");
    const auth = await import("../auth.js");
    vi.spyOn(auth, "fetchAccessToken").mockResolvedValue("tok");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if ((init as RequestInit | undefined)?.method === "POST") return response(202, undefined);
      return response(200, appList);
    });
    const client = new AzureClient(creds);
    await expect(
      client.invokeAction(
        "azure-container-app",
        "acct:azure-container-app:rg1/ca1",
        "stop",
        "acct",
      ),
    ).resolves.toBeUndefined();
    const post = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
    expect(String(post![0])).toContain("/containerApps/ca1/stop?api-version=2025-07-01");
    vi.restoreAllMocks();
  });

  it("rejects actions a type does not have before touching the network", async () => {
    const { AzureClient } = await import("../client.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new AzureClient(creds);
    await expect(client.invokeAction("azure-disk", "id", "start", "acct")).rejects.toThrow(
      /not supported/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
