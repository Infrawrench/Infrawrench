import http from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  installAwsLambdaGlobal,
  RuntimeApi,
  runInvocation,
  type ApiResponse,
  type LambdaContext,
  type LambdaResponseStream,
} from "../runtime/lambda-runtime";

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  trailers: NodeJS.Dict<string>;
}

/** A stand-in for the Runtime API that records what the runtime posts. */
let server: http.Server;
let received: Received[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
        trailers: req.trailers,
      });
      res.writeHead(202, { "Content-Type": "application/json" }).end('{"status":"OK"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  received = [];
});

function api(): RuntimeApi {
  const { port } = server.address() as AddressInfo;
  return new RuntimeApi(`127.0.0.1:${port}`);
}

function next(event: unknown, requestId = "req-1"): ApiResponse {
  return {
    status: 200,
    headers: {
      "lambda-runtime-aws-request-id": requestId,
      "lambda-runtime-deadline-ms": String(Date.now() + 30_000),
      "lambda-runtime-invoked-function-arn":
        "arn:aws:lambda:us-east-2:123456789012:function:fn:live",
      "lambda-runtime-invocation-id": "inv-1",
    },
    body: Buffer.from(JSON.stringify(event)),
  };
}

const PRELUDE_DELIMITER = Buffer.alloc(8);

describe("buffered handlers", () => {
  it("posts the return value as JSON with the request and invocation ids", async () => {
    let seen: { event: unknown; context: LambdaContext } | undefined;
    await runInvocation(
      api(),
      async (event: unknown, context: LambdaContext) => {
        seen = { event, context };
        return { ticks: 3 };
      },
      next({ source: "scheduler" }),
    );
    expect(seen?.event).toEqual({ source: "scheduler" });
    expect(seen?.context.awsRequestId).toBe("req-1");
    expect(seen?.context.getRemainingTimeInMillis()).toBeGreaterThan(25_000);
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("/2018-06-01/runtime/invocation/req-1/response");
    expect(received[0]!.headers["lambda-runtime-invocation-id"]).toBe("inv-1");
    expect(JSON.parse(received[0]!.body.toString())).toEqual({ ticks: 3 });
  });

  it("reports a thrown error to the invocation's error endpoint", async () => {
    await runInvocation(
      api(),
      async () => {
        throw new TypeError("bad input");
      },
      next({}),
    );
    expect(received[0]!.url).toBe("/2018-06-01/runtime/invocation/req-1/error");
    expect(received[0]!.headers["lambda-runtime-function-error-type"]).toBe("Function.TypeError");
    expect(JSON.parse(received[0]!.body.toString())).toMatchObject({
      errorType: "TypeError",
      errorMessage: "bad input",
    });
  });
});

describe("streaming handlers", () => {
  const awslambda = () =>
    (
      globalThis as unknown as {
        awslambda: {
          streamifyResponse: <T>(fn: T) => T;
          HttpResponseStream: {
            from(stream: LambdaResponseStream, metadata: object): LambdaResponseStream;
          };
        };
      }
    ).awslambda;

  beforeAll(() => installAwsLambdaGlobal());

  it("streams a function URL response: JSON prelude, eight NUL bytes, then the body", async () => {
    const handler = awslambda().streamifyResponse(
      async (_event: unknown, responseStream: LambdaResponseStream) => {
        const out = awslambda().HttpResponseStream.from(responseStream, {
          statusCode: 201,
          headers: { "content-type": "text/plain" },
        });
        await pipeline(Readable.from([Buffer.from("hello "), Buffer.from("world")]), out);
      },
    );
    await runInvocation(api(), handler, next({ rawPath: "/" }));

    const post = received[0]!;
    expect(post.url).toBe("/2018-06-01/runtime/invocation/req-1/response");
    expect(post.headers["lambda-runtime-function-response-mode"]).toBe("streaming");
    expect(post.headers["transfer-encoding"]).toBe("chunked");
    expect(post.headers["content-type"]).toBe(
      "application/vnd.awslambda.http-integration-response",
    );
    const delimiter = post.body.indexOf(PRELUDE_DELIMITER);
    expect(JSON.parse(post.body.subarray(0, delimiter).toString())).toEqual({
      statusCode: 201,
      headers: { "content-type": "text/plain" },
    });
    expect(post.body.subarray(delimiter + 8).toString()).toBe("hello world");
  });

  it("sends the prelude for a response with no body", async () => {
    const handler = awslambda().streamifyResponse(
      async (_event: unknown, responseStream: LambdaResponseStream) => {
        const out = awslambda().HttpResponseStream.from(responseStream, {
          statusCode: 204,
          headers: {},
        });
        out.write("");
        out.end();
      },
    );
    await runInvocation(api(), handler, next({}));
    const body = received[0]!.body;
    expect(body.subarray(body.length - 8)).toEqual(PRELUDE_DELIMITER);
    expect(JSON.parse(body.subarray(0, body.length - 8).toString())).toEqual({
      statusCode: 204,
      headers: {},
    });
  });

  it("reports an error after the stream started in the trailers", async () => {
    const handler = awslambda().streamifyResponse(
      async (_event: unknown, responseStream: LambdaResponseStream) => {
        responseStream.write("partial");
        throw new RangeError("source went away");
      },
    );
    await runInvocation(api(), handler, next({}));
    const post = received[0]!;
    expect(post.body.toString()).toBe("partial");
    expect(post.trailers["lambda-runtime-function-error-type"]).toBe("Function.RangeError");
    expect(
      JSON.parse(
        Buffer.from(post.trailers["lambda-runtime-function-error-body"]!, "base64").toString(),
      ),
    ).toMatchObject({ errorMessage: "source went away" });
  });
});
