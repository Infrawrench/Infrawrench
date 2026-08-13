import { describe, it, expect, vi, beforeEach } from "vitest";

/** The real request type `fetchSigned` receives — the mock records these. */
type FetchSignedArg = Parameters<(typeof import("../signed-request.js"))["fetchSigned"]>[0];

const fetchSigned = vi.fn<(req: FetchSignedArg) => Promise<unknown>>();
const getAwsClients = vi.fn();

vi.mock("../signed-request.js", () => ({ fetchSigned: (req: FetchSignedArg) => fetchSigned(req) }));
vi.mock("../aws-clients.js", () => ({ getAwsClients: (...a: unknown[]) => getAwsClients(...a) }));

import {
  ec2Call,
  ec2QueryCall,
  jsonCall,
  jsonGetCall,
  queryPostCall,
  restJsonCall,
  xmlGetCall,
  hostForService,
} from "../client-transport.js";
import type { AwsCredentials } from "../auth.js";

const creds: AwsCredentials = {
  accessKeyId: "AKIA",
  secretAccessKey: "secret",
  region: "us-east-1",
};

function xmlResponse(xml: string) {
  return { text: async () => xml };
}
function jsonResponse(obj: unknown) {
  return { json: async () => obj };
}

beforeEach(() => {
  fetchSigned.mockReset();
  getAwsClients.mockReset();
  // Default: SDK client exposes an endpoint resolver
  getAwsClients.mockReturnValue(
    new Proxy(
      {},
      {
        get: () => ({
          config: { endpoint: async () => ({ hostname: "svc.us-east-1.amazonaws.com" }) },
        }),
      },
    ),
  );
});

describe("ec2Call", () => {
  it("issues a signed GET with Action/Version and parses XML", async () => {
    fetchSigned.mockResolvedValue(
      xmlResponse("<Resp><vpcSet><item><vpcId>v-1</vpcId></item></vpcSet></Resp>"),
    );
    const out = await ec2Call<Record<string, unknown>>(creds, "DescribeVpcs", { Foo: "bar" });
    expect((out["vpcSet"] as { item: Array<{ vpcId: string }> }).item[0]!.vpcId).toBe("v-1");
    const arg = fetchSigned.mock.calls[0]![0];
    expect(arg.method).toBe("GET");
    expect(arg.url).toContain("Action=DescribeVpcs");
    expect(arg.url).toContain("Version=2016-11-15");
    expect(arg.url).toContain("Foo=bar");
    expect(arg.service).toBe("ec2");
  });
});

describe("jsonCall", () => {
  it("posts JSON-RPC with X-Amz-Target and 1.1 content type", async () => {
    fetchSigned.mockResolvedValue(jsonResponse({ ok: 1 }));
    const out = await jsonCall<{ ok: number }>(creds, "ecs", "Svc.Action", { a: 1 });
    expect(out.ok).toBe(1);
    const arg = fetchSigned.mock.calls[0]![0];
    expect(arg.method).toBe("POST");
    expect(arg.headers["X-Amz-Target"]).toBe("Svc.Action");
    expect(arg.headers["Content-Type"]).toBe("application/x-amz-json-1.1");
    expect(JSON.parse(arg.body as string)).toEqual({ a: 1 });
  });

  it("uses json-1.0 content type for dynamodb/sqs/states/apprunner", async () => {
    fetchSigned.mockResolvedValue(jsonResponse({}));
    await jsonCall(creds, "dynamodb", "DynamoDB_20120810.ListTables", {});
    expect(fetchSigned.mock.calls[0]![0].headers["Content-Type"]).toBe(
      "application/x-amz-json-1.0",
    );
  });
});

describe("ec2QueryCall / queryPostCall", () => {
  it("ec2QueryCall GET parses XML", async () => {
    fetchSigned.mockResolvedValue(xmlResponse("<R><x>1</x></R>"));
    const out = await ec2QueryCall<Record<string, unknown>>(
      creds,
      "rds",
      "DescribeDBInstances",
      "2014-10-31",
    );
    expect(out["x"]).toBe("1");
    expect(fetchSigned.mock.calls[0]![0].method).toBe("GET");
  });
  it("queryPostCall POST form-encoded parses XML", async () => {
    fetchSigned.mockResolvedValue(xmlResponse("<R><y>2</y></R>"));
    const out = await queryPostCall<Record<string, unknown>>(
      creds,
      "iam",
      "CreateRole",
      "2010-05-08",
      {
        RoleName: "r",
      },
    );
    expect(out["y"]).toBe("2");
    const arg = fetchSigned.mock.calls[0]![0];
    expect(arg.method).toBe("POST");
    expect(arg.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(arg.body).toContain("Action=CreateRole");
    expect(arg.body).toContain("RoleName=r");
  });
});

describe("restJsonCall", () => {
  it("POST includes content-type + body", async () => {
    fetchSigned.mockResolvedValue(jsonResponse({ z: 1 }));
    const out = await restJsonCall<{ z: number }>(creds, "batch", "/v1/createjobqueue", { a: 1 });
    expect(out.z).toBe(1);
    const arg = fetchSigned.mock.calls[0]![0];
    expect(arg.headers["Content-Type"]).toBe("application/json");
    expect(arg.url).toContain("/v1/createjobqueue");
  });
  it("GET omits body", async () => {
    fetchSigned.mockResolvedValue(jsonResponse({}));
    await restJsonCall(creds, "batch", "/v1/list", {}, "GET");
    const arg = fetchSigned.mock.calls[0]![0];
    expect(arg.body).toBeUndefined();
    expect(arg.headers["Content-Type"]).toBeUndefined();
  });
});

describe("xmlGetCall / jsonGetCall", () => {
  it("xmlGetCall parses XML at a path", async () => {
    fetchSigned.mockResolvedValue(xmlResponse("<R><Buckets></Buckets></R>"));
    const out = await xmlGetCall<Record<string, unknown>>(creds, "s3", "/");
    expect(out).toHaveProperty("Buckets");
  });
  it("jsonGetCall returns json", async () => {
    fetchSigned.mockResolvedValue(jsonResponse({ clusters: ["a"] }));
    const out = await jsonGetCall<{ clusters: string[] }>(creds, "eks", "/clusters");
    expect(out.clusters).toEqual(["a"]);
  });
});

describe("endpoint resolution branches", () => {
  it("neptune/docdb force the rds host with their own signing names", async () => {
    fetchSigned.mockResolvedValue(xmlResponse("<R/>"));
    await ec2QueryCall(creds, "neptune", "DescribeDBClusters", "2014-10-31");
    const arg = fetchSigned.mock.calls[0]![0];
    expect(arg.url).toContain("rds.us-east-1.amazonaws.com");
    expect(arg.service).toBe("rds");
  });

  it("global service uses us-east-1 signing region", async () => {
    fetchSigned.mockResolvedValue(xmlResponse("<R/>"));
    await ec2QueryCall({ ...creds, region: "eu-west-1" }, "iam", "ListUsers", "2010-05-08");
    const arg = fetchSigned.mock.calls[0]![0];
    expect(arg.credentials.region).toBe("us-east-1");
  });

  it("falls back to legacy host when endpoint resolver throws", async () => {
    getAwsClients.mockReturnValue(
      new Proxy(
        {},
        {
          get: () => ({
            config: {
              endpoint: () => {
                throw new Error("nope");
              },
            },
          }),
        },
      ),
    );
    fetchSigned.mockResolvedValue(jsonResponse({}));
    await jsonCall(creds, "ecs", "T.A", {});
    expect(fetchSigned.mock.calls[0]![0].url).toContain("ecs.us-east-1.amazonaws.com");
  });

  it("falls back to legacy host when endpoint is not a function", async () => {
    getAwsClients.mockReturnValue(
      new Proxy({}, { get: () => ({ config: { endpoint: undefined } }) }),
    );
    fetchSigned.mockResolvedValue(jsonResponse({}));
    await jsonCall(creds, "ecr", "T.A", {});
    expect(fetchSigned.mock.calls[0]![0].url).toContain("api.ecr.us-east-1.amazonaws.com");
  });

  it("legacy sagemaker host fallback", async () => {
    getAwsClients.mockReturnValue(
      new Proxy({}, { get: () => ({ config: { endpoint: undefined } }) }),
    );
    fetchSigned.mockResolvedValue(jsonResponse({}));
    await jsonCall(creds, "sagemaker", "T.A", {});
    expect(fetchSigned.mock.calls[0]![0].url).toContain("api.sagemaker.us-east-1.amazonaws.com");
  });

  it("throws on unknown service", async () => {
    await expect(ec2QueryCall(creds, "totally-unknown", "X", "1")).rejects.toThrow(
      /unknown service/,
    );
  });
});

describe("hostForService", () => {
  it("returns legacy host patterns", () => {
    expect(hostForService(creds, "iam")).toBe("iam.amazonaws.com");
    expect(hostForService(creds, "route53")).toBe("route53.amazonaws.com");
    expect(hostForService(creds, "lambda")).toBe("lambda.us-east-1.amazonaws.com");
    expect(hostForService(creds, "ecr")).toBe("api.ecr.us-east-1.amazonaws.com");
    expect(hostForService(creds, "unknown-svc")).toBe("unknown-svc.us-east-1.amazonaws.com");
  });
});
