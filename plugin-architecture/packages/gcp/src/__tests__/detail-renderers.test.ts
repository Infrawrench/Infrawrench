import { describe, it, expect } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { gcpRenderDetail } from "../detail-renderers.js";
import type { GcpDetailContext } from "../detail-context.js";

const ctx: GcpDetailContext = {
  id: (a, t, e) => `${a}:${t}:${e}`,
  project: "proj",
  resourceTypes: [],
};

function res(over: Partial<ResourceInstance> = {}): ResourceInstance {
  return {
    id: "acct:type:ext",
    pluginId: "gcp",
    resourceTypeId: "gce-instance",
    accountId: "acct",
    displayName: "name",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: "ext",
    createdAt: "t",
    updatedAt: "t",
    ...over,
  } as ResourceInstance;
}

const J = (o: unknown) => JSON.stringify(o);

describe("cloud-run-service renderer", () => {
  it("renders empty tabs (no revisions/domains/iam/triggers)", () => {
    const out = gcpRenderDetail(
      ctx,
      res({ resourceTypeId: "cloud-run-service", fields: { region: "us-central1" } }),
    );
    const tabIds = (out.customTabs ?? []).map((t) => t.id);
    expect(tabIds).toEqual([
      "cloud-run-revisions",
      "cloud-run-networking",
      "cloud-run-security",
      "cloud-run-source",
      "cloud-run-triggers",
    ]);
    expect(out.logs?.defaultTailLines).toBe(200);
  });

  it("renders populated revisions, domains, iam, triggers, binAuth", () => {
    const out = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-run-service",
        fields: { region: "us-central1", ingress: "INGRESS_TRAFFIC_ALL", image: "gcr.io/p/i:1" },
        resolvedOutputs: {
          url: "https://svc.run.app",
          cloudRunFullService: J({
            service: {
              template: { vpcAccess: { connector: "c1", egress: "ALL_TRAFFIC" } },
              annotations: { "run.googleapis.com/mesh": "m1", "run.googleapis.com/build-id": "b1" },
              binaryAuthorization: { useDefault: true },
              defaultUriDisabled: true,
            },
            error: "",
          }),
          cloudRunRevisions: J([
            {
              name: "rev1",
              trafficPercent: 100,
              ready: true,
              image: "gcr.io/p/i:1",
              cpuLimit: "1",
              memoryLimit: "512Mi",
              envCount: 2,
              healthCheckCount: 1,
              createTime: "2026-01-01T00:00:00Z",
            },
          ]),
          cloudRunTriggers: J([
            {
              name: "trig1",
              eventType: "google.pubsub",
              transport: "pubsub",
              serviceAccount: "sa@x",
              createTime: "2026-01-01T00:00:00Z",
            },
          ]),
          cloudRunIam: J({
            bindings: [{ role: "roles/run.invoker", members: ["allUsers", "user:a@x"] }],
            etag: "e",
            error: "",
          }),
          cloudRunDomainMappings: J({
            mappings: [
              {
                domain: "a.com",
                ready: true,
                status: "READY",
                url: "https://a.com",
                message: "",
                resourceRecords: [{ name: "", type: "A", rrdata: "1.2.3.4" }],
              },
              {
                domain: "b.com",
                ready: false,
                status: "PENDING",
                message: "waiting",
                resourceRecords: [],
              },
            ],
            error: "",
          }),
        },
      }),
    );
    const networking = (out.customTabs ?? []).find((t) => t.id === "cloud-run-networking");
    expect(JSON.stringify(networking)).toContain("a.com");
    const security = (out.customTabs ?? []).find((t) => t.id === "cloud-run-security");
    expect(JSON.stringify(security)).toContain("Allow public access");
  });

  it("renders permission-error states for iam + domain mappings", () => {
    const out = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-run-service",
        resolvedOutputs: {
          cloudRunIam: J({ bindings: [], etag: "", error: "permission denied (403)" }),
          cloudRunDomainMappings: J({ mappings: [], error: "permission denied (403)" }),
        },
      }),
    );
    const security = (out.customTabs ?? []).find((t) => t.id === "cloud-run-security");
    expect(JSON.stringify(security)).toContain("roles/run.viewer");
  });
});

describe("cloud-function renderer", () => {
  it("renders function info + build + state message", () => {
    const out = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-function",
        fields: {
          region: "us-central1",
          runtime: "nodejs24",
          entryPoint: "helloHttp",
          environment: "GEN_2",
          minInstances: "0",
          maxInstances: "10",
          concurrency: "80",
          availableMemory: "256M",
          timeout: "60",
          stateMessage: "Deploying",
          buildId: "build-1",
        },
        resolvedOutputs: { sourceLocation: "gs://bucket/src.zip" },
      }),
    );
    expect(out.sections?.some((s) => "title" in s && s.title === "Function info")).toBe(true);
    expect(out.sections?.some((s) => "title" in s && s.title === "State message")).toBe(true);
    const source = (out.customTabs ?? []).find((t) => t.id === "cloud-run-source");
    expect(JSON.stringify(source)).toContain("Function build");
  });
});

describe("firestore-database renderer", () => {
  it("renders native db with empty outputs", () => {
    const out = gcpRenderDetail(
      ctx,
      res({ resourceTypeId: "firestore-database", fields: { name: "(default)" } }),
    );
    expect(out.subtitle).toBe("Firestore Native");
    expect(out.noSqlBrowser?.driver).toBe("firestore");
  });

  it("renders enterprise mongodb-compat db", () => {
    const out = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "firestore-database",
        fields: { name: "db", databaseEdition: "ENTERPRISE", type: "FIRESTORE_NATIVE" },
      }),
    );
    expect(out.subtitle).toBe("Firestore Enterprise");
    expect(out.noSqlBrowser?.driver).toBe("mongodb-peer");
  });

  it("renders datastore-mode db", () => {
    const out = gcpRenderDetail(
      ctx,
      res({ resourceTypeId: "firestore-database", fields: { type: "DATASTORE_MODE" } }),
    );
    expect(out.subtitle).toBe("Firestore (Datastore mode)");
  });

  it("renders all populated tabs (indexes, schedules, ttl, ops, rules, backups, usage, iam)", () => {
    const out = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "firestore-database",
        fields: { name: "db" },
        resolvedOutputs: {
          firestoreCollections: J(["users", "orders"]),
          firestoreIndexes: J([
            {
              name: "i1",
              fullName: "projects/p/.../indexes/i1",
              collectionGroup: "users",
              queryScope: "COLLECTION",
              state: "READY",
              fieldsDesc: "email ASC",
            },
            {
              name: "i2",
              fullName: "f2",
              collectionGroup: "orders",
              queryScope: "COLLECTION",
              state: "CREATING",
              fieldsDesc: "ts DESC",
            },
          ]),
          firestoreBackupSchedules: J([
            { name: "s1", fullName: "fs1", retention: "7d", recurrence: "DAILY" },
          ]),
          firestoreTtl: J([
            { fullName: "t1", collectionGroup: "sessions", fieldPath: "expireAt", state: "ACTIVE" },
          ]),
          firestoreOperations: J([
            { id: "op1", fullName: "fo1", kind: "IMPORT", state: "PROCESSING", error: "" },
          ]),
          firestoreRules: J({
            rulesetName: "rs1",
            content: "rules_version='2';",
            updateTime: "2026-01-01T00:00:00Z",
            error: "",
          }),
          firestoreBackups: J([
            {
              name: "b1",
              fullName: "fb1",
              snapshotTime: "2026-01-01T00:00:00Z",
              expireTime: "2026-02-01T00:00:00Z",
              state: "READY",
              sizeBytes: "1024",
            },
          ]),
          firestoreDatabaseExtras: J({
            earliestVersionTime: "2026-01-01T00:00:00Z",
            versionRetentionPeriod: "3600s",
            pointInTimeRecoveryEnablement: "POINT_IN_TIME_RECOVERY_ENABLED",
          }),
          firestoreUsageMetrics: J({
            reads24h: 100,
            writes24h: 50,
            deletes24h: 5,
            storageBytes: 2048,
            available: true,
            error: "",
          }),
          firestoreIam: J({
            bindings: [{ role: "roles/datastore.user", members: ["user:a@x"] }],
            etag: "e",
            error: "",
          }),
        },
      }),
    );
    const tabLabels = (out.customTabs ?? []).map((t) => t.label);
    expect(tabLabels.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).toContain("users");
  });

  it("renders error states for rules/usage/iam/indexes", () => {
    const out = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "firestore-database",
        fields: { name: "db" },
        resolvedOutputs: {
          firestoreRules: J({
            rulesetName: "",
            content: "",
            updateTime: "",
            error: "permission denied (403)",
          }),
          firestoreUsageMetrics: J({
            reads24h: 0,
            writes24h: 0,
            deletes24h: 0,
            storageBytes: 0,
            available: false,
            error: "no metrics",
          }),
          firestoreIam: J({ bindings: [], etag: "", error: "permission denied (403)" }),
          firestoreIndexesError: "index list failed",
        },
      }),
    );
    expect(JSON.stringify(out)).toContain("permission denied");
  });
});

describe("cloud-router renderer", () => {
  it("renders empty + populated + error", () => {
    const empty = gcpRenderDetail(ctx, res({ resourceTypeId: "cloud-router" }));
    expect(empty.subtitle).toBe("Cloud Router");
    expect(JSON.stringify(empty)).toContain("No BGP route policies");

    const populated = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-router",
        resolvedOutputs: {
          cloudRouterFull: J({
            bgp: {
              asn: 64512,
              advertiseMode: "CUSTOM",
              advertisedGroups: ["ALL_SUBNETS"],
              advertisedIpRanges: [{ range: "10.0.0.0/8", description: "internal" }],
            },
            bgpPeers: [{ name: "peer1", importPolicies: ["pol1"], exportPolicies: [] }],
            nats: [{ name: "nat1" }],
            error: "",
          }),
          cloudRouterPolicies: J({
            result: [{ name: "pol1", type: "ROUTE_POLICY_TYPE_IMPORT", terms: [{}, {}] }],
          }),
        },
      }),
    );
    expect(JSON.stringify(populated)).toContain("10.0.0.0/8");
    expect(JSON.stringify(populated)).toContain("nat1");

    const errd = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-router",
        resolvedOutputs: {
          cloudRouterFull: J({ error: "boom" }),
          cloudRouterPolicies: J({ error: "policy boom" }),
        },
      }),
    );
    expect(JSON.stringify(errd)).toContain("Could not load router details");
    expect(JSON.stringify(errd)).toContain("Could not load route policies");
  });
});

describe("cloud-nat renderer", () => {
  it("renders empty + populated + errors", () => {
    const empty = gcpRenderDetail(
      ctx,
      res({ resourceTypeId: "cloud-nat", fields: { name: "nat1" } }),
    );
    expect(empty.subtitle).toBe("Cloud NAT");

    const populated = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-nat",
        fields: { name: "nat1" },
        resolvedOutputs: {
          cloudNatRouter: J({
            nats: [
              {
                name: "nat1",
                natIpAllocateOption: "MANUAL_ONLY",
                enableDynamicPortAllocation: true,
                minPortsPerVm: 128,
                maxPortsPerVm: 512,
                enableEndpointIndependentMapping: true,
                logConfig: { enable: true, filter: "ALL" },
              },
            ],
          }),
          cloudNatStatus: J({
            result: {
              natStatus: [
                {
                  name: "nat1",
                  autoAllocatedNatIps: ["1.1.1.1"],
                  userAllocatedNatIps: ["2.2.2.2"],
                  numVmEndpointsWithNatMappings: 3,
                  minExtraNatIpsNeeded: 2,
                },
              ],
            },
          }),
        },
      }),
    );
    expect(JSON.stringify(populated)).toContain("1.1.1.1");
    expect(JSON.stringify(populated)).toContain("Translations and errors");

    const errd = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-nat",
        fields: { name: "nat1" },
        resolvedOutputs: {
          cloudNatRouter: J({ error: "router boom" }),
          cloudNatStatus: J({ error: "status boom" }),
        },
      }),
    );
    expect(JSON.stringify(errd)).toContain("Could not load router config");
    expect(JSON.stringify(errd)).toContain("Could not load router status");
  });
});

describe("backend-service renderer", () => {
  it("renders managed scheme with cdn metrics + health-check warning when none", () => {
    const out = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "backend-service",
        fields: {
          loadBalancingScheme: "EXTERNAL_MANAGED",
          protocol: "HTTP",
          healthCheckCount: 0,
          enableCDN: true,
        },
      }),
    );
    expect(out.subtitle).toContain("External (managed)");
    expect(out.metricsCapability).toBeDefined();
    expect(JSON.stringify(out)).toContain("No health check attached");
  });

  it("renders internal scheme without metrics and with health checks", () => {
    const out = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "backend-service",
        fields: {
          loadBalancingScheme: "INTERNAL_SELF_MANAGED",
          protocol: "TCP",
          healthCheckCount: 1,
        },
      }),
    );
    expect(out.subtitle).toContain("Internal Self-Managed");
    expect(out.metricsCapability).toBeUndefined();
  });
});

describe("cloud-armor-policy renderer", () => {
  it("renders empty + populated + error", () => {
    const empty = gcpRenderDetail(ctx, res({ resourceTypeId: "cloud-armor-policy" }));
    expect(empty.subtitle).toBe("Cloud Armor security policy");
    expect(JSON.stringify(empty)).toContain("No rules defined yet");

    const populated = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-armor-policy",
        resolvedOutputs: {
          cloudArmorPolicyFull: J({
            rules: [
              {
                priority: 1000,
                description: "block",
                action: "deny(403)",
                preview: true,
                mode: "basic",
                match: "1.2.3.0/24",
                responseCode: "403",
              },
              {
                priority: 2147483647,
                description: "",
                action: "allow",
                preview: false,
                mode: "advanced",
                match: "true",
                responseCode: "",
              },
            ],
            fingerprint: "fp",
            error: "",
          }),
          cloudArmorTargets: J({ targets: [{ name: "bs1", region: "global" }], error: "" }),
        },
      }),
    );
    expect(JSON.stringify(populated)).toContain("1.2.3.0/24");
    expect(JSON.stringify(populated)).toContain("bs1");

    const errd = gcpRenderDetail(
      ctx,
      res({
        resourceTypeId: "cloud-armor-policy",
        resolvedOutputs: {
          cloudArmorPolicyFull: J({ error: "rules boom" }),
          cloudArmorTargets: J({ error: "targets boom" }),
        },
      }),
    );
    expect(JSON.stringify(errd)).toContain("Could not load rules");
    expect(JSON.stringify(errd)).toContain("Could not load targets");
  });
});
