/**
 * The real AWS SDK clients over the host's HTTP service, with sockets blocked and
 * `fetch` stubbed to throw: every protocol the SDK speaks has to read what the host
 * answers, and nothing may leave any other way (#764).
 */
import net from "node:net";
import { Readable } from "node:stream";
import { DescribeFlowLogsCommand } from "@aws-sdk/client-ec2";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ListUsersCommand } from "@aws-sdk/client-iam";
import { ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { ListHostedZonesCommand } from "@aws-sdk/client-route-53";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";

import { getAwsClients, type AwsClients } from "../aws-clients.js";
import { fetchAwsNetworkFlows } from "../network-flows.js";

const CREDS = { accessKeyId: "AKIAFAKE", secretAccessKey: "secret", region: "us-east-1" };

type HostRequest = Parameters<HttpHostServices["request"]>[0];
type HostAnswer = { status: number; headers?: Record<string, string>; body?: string };

/** A host that answers as `server-core` does: binary when asked, text otherwise. */
function fakeHost(answer: (req: HostRequest) => HostAnswer) {
  const request = vi.fn(async (req: HostRequest) => {
    const a = answer(req);
    const text = a.body ?? "";
    return req.responseEncoding === "binary"
      ? {
          status: a.status,
          headers: a.headers ?? {},
          body: "",
          rawBody: new TextEncoder().encode(text),
        }
      : { status: a.status, headers: a.headers ?? {}, body: text };
  });
  const http: HttpHostServices = { request };
  return { http, request, clients: getAwsClients({ ...CREDS, http }) };
}

function only(request: { mock: { calls: [HostRequest][] } }): HostRequest {
  expect(request.mock.calls).toHaveLength(1);
  return request.mock.calls[0]![0];
}

function expectSigned(req: HostRequest) {
  expect(req.headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKE/);
  expect(req.headers["x-amz-date"]).toBeTruthy();
  expect(req.caCert).toBeUndefined();
}

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the SDK reached global fetch");
  });
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("the SDK opened a socket");
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every SDK client sends through the host", () => {
  it("each of the bundle's clients carries the host's handler", () => {
    const { clients } = fakeHost(() => ({ status: 200 }));
    const handlers = new Set(
      (Object.keys(clients) as Array<keyof AwsClients>).map(
        (key) => clients[key].config.requestHandler,
      ),
    );
    expect(Object.keys(clients)).toHaveLength(44);
    expect(handlers.size).toBe(1);
    expect([...handlers][0]).toHaveProperty("metadata.handlerProtocol", "http/1.1");
  });

  it("leaves the SDK's own handler alone when the host supplies no service", () => {
    const direct = getAwsClients(CREDS);
    expect(direct.ec2.config.requestHandler.constructor.name).toBe("NodeHttpHandler");
  });

  it("does not hand one account's clients to another holding the same key", () => {
    const a = fakeHost(() => ({ status: 200 }));
    const b = fakeHost(() => ({ status: 200 }));
    expect(a.clients).not.toBe(b.clients);
    expect(a.clients).not.toBe(getAwsClients(CREDS));
    expect(getAwsClients({ ...CREDS, http: a.http })).toBe(a.clients);
  });
});

describe("the EC2 protocol", () => {
  it("reads a list", async () => {
    const { clients, request } = fakeHost(() => ({
      status: 200,
      body: `<DescribeFlowLogsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><flowLogSet><item><flowLogId>fl-1</flowLogId></item></flowLogSet><nextToken>t</nextToken></DescribeFlowLogsResponse>`,
    }));
    const out = await clients.ec2.send(new DescribeFlowLogsCommand({ MaxResults: 100 }));
    expect(out.FlowLogs?.[0]?.FlowLogId).toBe("fl-1");
    expect(out.NextToken).toBe("t");
    const req = only(request);
    expect(req.url).toBe("https://ec2.us-east-1.amazonaws.com/");
    expect(req.method).toBe("POST");
    expect(req.body).toContain("Action=DescribeFlowLogs");
    expectSigned(req);
  });

  it("reads an error", async () => {
    const { clients } = fakeHost(() => ({
      status: 403,
      body: `<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>No.</Message></Error></Errors><RequestID>r</RequestID></Response>`,
    }));
    await expect(clients.ec2.send(new DescribeFlowLogsCommand({}))).rejects.toMatchObject({
      name: "UnauthorizedOperation",
      $metadata: { httpStatusCode: 403 },
    });
  });
});

describe("AWS JSON", () => {
  it("1.1 reads a list", async () => {
    const { clients, request } = fakeHost(() => ({
      status: 200,
      headers: { "content-type": "application/x-amz-json-1.1" },
      body: JSON.stringify({ logGroups: [{ logGroupName: "/a" }], nextToken: "t" }),
    }));
    const out = await clients.cloudWatchLogs.send(new DescribeLogGroupsCommand({ limit: 50 }));
    expect(out.logGroups?.[0]?.logGroupName).toBe("/a");
    const req = only(request);
    expect(req.url).toBe("https://logs.us-east-1.amazonaws.com/");
    expect(req.headers["x-amz-target"]).toBe("Logs_20140328.DescribeLogGroups");
    expectSigned(req);
  });

  it("1.1 reads an error", async () => {
    const { clients } = fakeHost(() => ({
      status: 400,
      headers: { "content-type": "application/x-amz-json-1.1" },
      body: JSON.stringify({ __type: "ResourceNotFoundException", message: "gone" }),
    }));
    await expect(
      clients.cloudWatchLogs.send(new DescribeLogGroupsCommand({})),
    ).rejects.toMatchObject({
      name: "ResourceNotFoundException",
      message: "gone",
      $metadata: { httpStatusCode: 400 },
    });
  });

  it("1.0 reads a list", async () => {
    const { clients, request } = fakeHost(() => ({
      status: 200,
      headers: { "content-type": "application/x-amz-json-1.0" },
      body: JSON.stringify({ TableNames: ["t"] }),
    }));
    const out = await clients.dynamoDb.send(new ListTablesCommand({}));
    expect(out.TableNames).toEqual(["t"]);
    expect(only(request).headers["content-type"]).toBe("application/x-amz-json-1.0");
  });
});

describe("the query protocol", () => {
  it("reads a list and an error", async () => {
    const list = fakeHost(() => ({
      status: 200,
      body: `<ListUsersResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><ListUsersResult><Users><member><UserName>u</UserName><UserId>AIDAFAKE</UserId><Arn>arn:aws:iam::1:user/u</Arn><Path>/</Path><CreateDate>2020-01-01T00:00:00Z</CreateDate></member></Users><IsTruncated>false</IsTruncated></ListUsersResult></ListUsersResponse>`,
    }));
    const out = await list.clients.iam.send(new ListUsersCommand({}));
    expect(out.Users?.[0]?.UserName).toBe("u");
    expectSigned(only(list.request));

    const denied = fakeHost(() => ({
      status: 403,
      body: `<ErrorResponse><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>No.</Message></Error></ErrorResponse>`,
    }));
    await expect(denied.clients.iam.send(new ListUsersCommand({}))).rejects.toMatchObject({
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
  });
});

describe("REST JSON", () => {
  it("sends the query it signed, escaped as the SDK's own handler does", async () => {
    const { clients, request } = fakeHost(() => ({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ Functions: [{ FunctionName: "f" }], NextMarker: "n" }),
    }));
    const out = await clients.lambda.send(
      new ListFunctionsCommand({ MaxItems: 50, Marker: "a b/c(d)!" }),
    );
    expect(out.Functions?.[0]?.FunctionName).toBe("f");
    const req = only(request);
    expect(req.method).toBe("GET");
    expect(req.body).toBeUndefined();
    expect(req.url).toBe(
      "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions?Marker=a%20b%2Fc%28d%29%21&MaxItems=50",
    );
    expectSigned(req);
  });

  it("reads an error named only by its header", async () => {
    const { clients } = fakeHost(() => ({
      status: 403,
      headers: { "x-amzn-errortype": "AccessDeniedException", "content-type": "application/json" },
      body: JSON.stringify({ Message: "No." }),
    }));
    await expect(clients.lambda.send(new ListFunctionsCommand({}))).rejects.toMatchObject({
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 403 },
    });
  });
});

describe("REST XML", () => {
  it("reads a list", async () => {
    const { clients, request } = fakeHost(() => ({
      status: 200,
      body: `<ListHostedZonesResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><HostedZones><HostedZone><Id>/hostedzone/Z1</Id><Name>a.example.</Name><CallerReference>c</CallerReference></HostedZone></HostedZones><IsTruncated>false</IsTruncated><MaxItems>100</MaxItems></ListHostedZonesResponse>`,
    }));
    const out = await clients.route53.send(new ListHostedZonesCommand({}));
    expect(out.HostedZones?.[0]?.Id).toBe("/hostedzone/Z1");
    expect(only(request).url).toBe("https://route53.amazonaws.com/2013-04-01/hostedzone");
  });

  it("S3 reads a list and its error", async () => {
    const list = fakeHost(() => ({
      status: 200,
      body: `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><IsTruncated>false</IsTruncated><Contents><Key>k</Key><Size>3</Size></Contents></ListBucketResult>`,
    }));
    const out = await list.clients.s3.send(new ListObjectsV2Command({ Bucket: "bucket" }));
    expect(out.Contents?.[0]?.Key).toBe("k");
    expect(only(list.request).url).toMatch(/^https:\/\/bucket\.s3\.us-east-1\.amazonaws\.com\/\?/);

    const denied = fakeHost(() => ({
      status: 403,
      body: `<Error><Code>AccessDenied</Code><Message>No.</Message></Error>`,
    }));
    await expect(
      denied.clients.s3.send(new ListObjectsV2Command({ Bucket: "bucket" })),
    ).rejects.toMatchObject({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  });

  it("S3 hands back a Body the SDK's stream helpers can read, in bytes", async () => {
    const { clients, request } = fakeHost(() => ({
      status: 200,
      headers: { "content-length": "11", etag: '"e"' },
      body: "hello world",
    }));
    const out = await clients.s3.send(new GetObjectCommand({ Bucket: "b", Key: "k" }));
    expect(out.ETag).toBe('"e"');
    expect(await out.Body?.transformToString()).toBe("hello world");
    expect(only(request).responseEncoding).toBe("binary");
  });

  it.each([
    ["a string", () => "payload"],
    ["bytes", () => new TextEncoder().encode("payload")],
  ])("S3 sends %s as the body", async (_name, make) => {
    const { clients, request } = fakeHost(() => ({ status: 200, headers: { etag: '"e"' } }));
    await clients.s3.send(new PutObjectCommand({ Bucket: "b", Key: "k", Body: make() }));
    const req = only(request);
    expect(req.method).toBe("PUT");
    const sent = typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body);
    expect(sent).toBe("payload");
    expectSigned(req);
  });

  it("S3 reads a stream the SDK sends whole, and drops what the host's connection owns", async () => {
    const { clients, request } = fakeHost(() => ({ status: 200, headers: { etag: '"e"' } }));
    await clients.s3.send(
      new PutObjectCommand({
        Bucket: "b",
        Key: "k",
        Body: Readable.from([Buffer.from("pay"), Buffer.from("load")]),
        ContentLength: 7,
      }),
    );
    const req = only(request);
    // The SDK frames a stream as aws-chunked, which S3 reads by these headers.
    expect(new TextDecoder().decode(req.body as Uint8Array)).toContain("3\r\npay\r\n4\r\nload\r\n");
    expect(req.headers["content-encoding"]).toBe("aws-chunked");
    expect(req.headers["x-amz-decoded-content-length"]).toBe("7");
    // The framed length is `fetch`'s to set: a stale one here would fail the request.
    expect(req.headers["content-length"]).toBeUndefined();
    expect(req.headers["transfer-encoding"]).toBeUndefined();
    expect(req.headers["expect"]).toBeUndefined();
  });

  it("S3 reads an answer with no body at all", async () => {
    const deleted = fakeHost(() => ({ status: 204, headers: { "x-amz-delete-marker": "true" } }));
    const out = await deleted.clients.s3.send(new DeleteObjectCommand({ Bucket: "b", Key: "k" }));
    expect(out.DeleteMarker).toBe(true);

    const head = fakeHost(() => ({ status: 200, headers: { "content-length": "9", etag: '"e"' } }));
    const headed = await head.clients.s3.send(new HeadObjectCommand({ Bucket: "b", Key: "k" }));
    expect(headed.ContentLength).toBe(9);
    expect(only(head.request).method).toBe("HEAD");

    const missing = fakeHost(() => ({ status: 404 }));
    await expect(
      missing.clients.s3.send(new HeadObjectCommand({ Bucket: "b", Key: "k" })),
    ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
  });
});

describe("the bastion being down", () => {
  it("fails the call with the host's error, once, with no way around it", async () => {
    const offline = Object.assign(new Error("Bastion b is offline."), {
      name: "BastionDisconnectedError",
    });
    const request = vi.fn(async () => {
      throw offline;
    });
    const http: HttpHostServices = { request };
    const clients = getAwsClients({ ...CREDS, http });
    await expect(clients.cloudWatchLogs.send(new DescribeLogGroupsCommand({}))).rejects.toBe(
      offline,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("a plugin path that uses the SDK", () => {
  it("network flows reach AWS only through the host", async () => {
    const { http, request } = fakeHost((req) => {
      if (req.url.startsWith("https://ec2.")) {
        return {
          status: 200,
          body: `<DescribeFlowLogsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><flowLogSet/></DescribeFlowLogsResponse>`,
        };
      }
      throw new Error(`unexpected: ${req.url}`);
    });
    await expect(fetchAwsNetworkFlows({ ...CREDS, http }, "2026-08-10")).rejects.toThrow(
      /No VPC flow logs/,
    );
    expect(request).toHaveBeenCalled();
  });
});
