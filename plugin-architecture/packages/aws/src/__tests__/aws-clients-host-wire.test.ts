/**
 * The SDK's requests through a real `fetch`, as the hosts send them, to a server on
 * this machine. A fake host cannot show that undici accepts what the SDK sets (`host`,
 * `content-length`), so every other destination stays blocked and the URL is rewritten
 * to loopback only after the request is built. `fetch` writes `host` from the URL, which
 * on the real path is the host the SDK signed.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";

import { getAwsClients } from "../aws-clients.js";

const realFetch = globalThis.fetch;
const realConnect = net.Socket.prototype.connect;

let server: Server;
let base: string;
const seen: Array<{ method: string | undefined; headers: IncomingHttpHeaders; body: Buffer }> = [];
let reply: { status: number; headers: Record<string, string>; body: Buffer | string };

/** What `server-core` does for a request with no bastion and no CA, aimed at loopback. */
const http: HttpHostServices = {
  request: async (req) => {
    const target = new URL(req.url);
    const res = await realFetch(`${base}${target.pathname}${target.search}`, {
      method: req.method,
      headers: req.headers,
      ...(req.body != null ? { body: req.body as string | Uint8Array<ArrayBuffer> } : {}),
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: "",
      rawBody: new Uint8Array(await res.arrayBuffer()),
    };
  },
};

const clients = getAwsClients({
  accessKeyId: "AKIAFAKE",
  secretAccessKey: "secret",
  region: "us-east-1",
  http,
});

beforeAll(async () => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the SDK reached global fetch");
  });
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof first === "object" && first !== null ? Reflect.get(first, "host") : "";
    if (host !== "127.0.0.1") throw new Error(`blocked a socket to ${String(host)}`);
    return Reflect.apply(realConnect, this, args);
  });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  seen.length = 0;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the SDK through a real fetch", () => {
  it("sends the content length it signed", async () => {
    reply = {
      status: 200,
      headers: { "content-type": "application/x-amz-json-1.1" },
      body: JSON.stringify({ logGroups: [{ logGroupName: "/a" }] }),
    };
    const out = await clients.cloudWatchLogs.send(new DescribeLogGroupsCommand({ limit: 5 }));
    expect(out.logGroups?.[0]?.logGroupName).toBe("/a");

    const [req] = seen;
    expect(req?.body.toString()).toBe('{"limit":5}');
    expect(req?.headers["content-length"]).toBe("11");
    expect(req?.headers.authorization).toMatch(/SignedHeaders=[^,]*content-length[^,]*host/);
  });

  it("round-trips bytes that are not text", async () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0xfe, 0x80]);
    reply = {
      status: 200,
      headers: { "content-length": String(bytes.length), etag: '"e"' },
      body: bytes,
    };
    const out = await clients.s3.send(new GetObjectCommand({ Bucket: "bucket", Key: "k" }));
    expect(Buffer.from((await out.Body?.transformToByteArray()) ?? [])).toEqual(bytes);
  });

  it("uploads a stream with the framed length, not the SDK's chunked header", async () => {
    reply = { status: 200, headers: { etag: '"e"' }, body: "" };
    await clients.s3.send(
      new PutObjectCommand({
        Bucket: "bucket",
        Key: "k",
        Body: Readable.from([Buffer.from("pay"), Buffer.from("load")]),
        ContentLength: 7,
      }),
    );
    const [req] = seen;
    expect(req?.method).toBe("PUT");
    expect(req?.headers["x-amz-decoded-content-length"]).toBe("7");
    expect(req?.headers["content-length"]).toBe(String(req?.body.length));
    expect(req?.body.toString()).toContain("3\r\npay\r\n4\r\nload\r\n");
  });
});
