/**
 * The Lambda runtime for the web gateway and the poller: the loop that takes
 * invocations from the Runtime API and hands them to a handler, in place of
 * the AWS Node.js base image's runtime interface client.
 *
 * It exists for SnapStart. The web function is restored from a snapshot taken
 * after its init (`infra/terraform/lambda.tf`), which turns a cold start that
 * loads the whole API with every plugin (tens of seconds; well past the 10s
 * init limit, so Lambda used to rerun it inside the first request) into a
 * resume. SnapStart on a container image is only safe when the process's
 * randomness survives being copied into many environments, which needs the
 * snapshot-safe OpenSSL of the `provided.al2023` image, where there is no
 * Node runtime client to inherit, and the before-snapshot and after-restore
 * steps that `lambda-snapshot.ts` describes. So this is that client: the
 * Runtime API contract (docs.aws.amazon.com/lambda/latest/dg/runtimes-api.html)
 * for the two handler shapes the image runs.
 *
 * - **Buffered** (the poller): `handler(event, context)` returns a value that
 *   is posted as JSON.
 * - **Streamed** (the web gateway's function URL, `RESPONSE_STREAM`):
 *   `awslambda.streamifyResponse(fn)` as on the managed runtime, with
 *   `awslambda.HttpResponseStream.from` writing the HTTP status and headers as
 *   the JSON prelude Lambda expects before the body.
 *
 * Like `server.ts`, uncaught errors are logged and survived; a stray socket
 * error should not take down the request that happens to be running.
 */
import http from "node:http";
import path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { format } from "node:util";
import { existsSync } from "node:fs";
import {
  afterSnapshotRestore,
  assertSnapshotSafe,
  prepareSnapshotRandomness,
} from "./lambda-snapshot";

const API_VERSION = "2018-06-01";
const HTTP_INTEGRATION_CONTENT_TYPE = "application/vnd.awslambda.http-integration-response";
/** Eight NUL bytes end the HTTP prelude of a streamed function URL response. */
const PRELUDE_DELIMITER = new Uint8Array(8);
const ERROR_TYPE_TRAILER = "Lambda-Runtime-Function-Error-Type";
const ERROR_BODY_TRAILER = "Lambda-Runtime-Function-Error-Body";
const STREAMING = Symbol.for("aws.lambda.runtime.handler.streaming");

export interface LambdaContext {
  awsRequestId: string;
  invokedFunctionArn: string;
  functionName: string;
  functionVersion: string;
  memoryLimitInMB: string;
  logGroupName: string;
  logStreamName: string;
  callbackWaitsForEmptyEventLoop: boolean;
  getRemainingTimeInMillis(): number;
}

/** What `awslambda.streamifyResponse` handlers write to. */
export interface LambdaResponseStream extends Writable {
  setContentType(contentType: string): void;
}

type BufferedHandler = (event: unknown, context: LambdaContext) => unknown;
type StreamingHandler = ((
  event: unknown,
  responseStream: LambdaResponseStream,
  context: LambdaContext,
) => Promise<void>) & { [STREAMING]?: true };

export interface ApiResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface ErrorReport {
  errorType: string;
  errorMessage: string;
  stackTrace: string[];
}

function errorReport(error: unknown): ErrorReport {
  if (error instanceof Error) {
    return {
      errorType: error.name || "Error",
      errorMessage: error.message,
      stackTrace: (error.stack ?? "")
        .split("\n")
        .slice(1)
        .map((line) => line.trim()),
    };
  }
  return { errorType: "Error", errorMessage: String(error), stackTrace: [] };
}

/** A client for the Runtime API on `AWS_LAMBDA_RUNTIME_API`. */
export class RuntimeApi {
  private readonly hostname: string;
  private readonly port: number;
  private agent: http.Agent;

  constructor(address: string) {
    const [hostname, port] = address.split(":");
    this.hostname = hostname!;
    this.port = Number(port ?? 80);
    this.agent = RuntimeApi.newAgent();
  }

  private static newAgent(): http.Agent {
    return new http.Agent({ keepAlive: true, maxSockets: 1 });
  }

  /** Drop pooled connections; after a restore they belong to another machine. */
  resetConnections(): void {
    this.agent.destroy();
    this.agent = RuntimeApi.newAgent();
  }

  request(
    method: string,
    route: string,
    options: { headers?: http.OutgoingHttpHeaders; body?: string } = {},
  ): Promise<ApiResponse> {
    return new Promise((resolve, reject) => {
      // No timeout: `next` and `restore/next` block for as long as the
      // environment waits, frozen, for work.
      const req = http.request(
        {
          hostname: this.hostname,
          port: this.port,
          method,
          path: `/${API_VERSION}/runtime/${route}`,
          headers: options.headers,
          agent: this.agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  }

  postError(
    route: string,
    error: unknown,
    errorType?: string,
    invocationId?: string,
  ): Promise<ApiResponse> {
    const report = errorReport(error);
    return this.request("POST", route, {
      headers: {
        "Content-Type": "application/json",
        "Lambda-Runtime-Function-Error-Type": errorType ?? `Function.${report.errorType}`,
        ...(invocationId ? { "Lambda-Runtime-Invocation-Id": invocationId } : {}),
      },
      body: JSON.stringify(report),
    });
  }

  /**
   * Open a streamed invocation response. Headers go out with the first write,
   * so the content type can still change until then.
   */
  openStream(
    requestId: string,
    invocationId: string | undefined,
  ): {
    request: http.ClientRequest;
    done: Promise<ApiResponse>;
  } {
    let request!: http.ClientRequest;
    const done = new Promise<ApiResponse>((resolve, reject) => {
      request = http.request(
        {
          hostname: this.hostname,
          port: this.port,
          method: "POST",
          path: `/${API_VERSION}/runtime/invocation/${requestId}/response`,
          headers: {
            "Lambda-Runtime-Function-Response-Mode": "streaming",
            "Transfer-Encoding": "chunked",
            Trailer: `${ERROR_TYPE_TRAILER}, ${ERROR_BODY_TRAILER}`,
            "Content-Type": "application/octet-stream",
            ...(invocationId ? { "Lambda-Runtime-Invocation-Id": invocationId } : {}),
          },
          agent: this.agent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", reject);
        },
      );
      request.on("error", reject);
    });
    return { request, done };
  }
}

/** The writable a streaming handler gets: the invocation response, chunked. */
class ResponseStream extends Writable implements LambdaResponseStream {
  /** Written ahead of the first body byte: the function URL's HTTP prelude. */
  prelude: Uint8Array[] | null = null;
  private started = false;

  constructor(private readonly request: http.ClientRequest) {
    super();
  }

  setContentType(contentType: string): void {
    if (this.started) throw new Error("Cannot set the content type after the response has started");
    this.request.setHeader("Content-Type", contentType);
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    for (const part of this.prelude ?? []) this.request.write(part);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.start();
    if (chunk.length === 0) {
      callback();
      return;
    }
    this.request.write(chunk, (error) => callback(error ?? null));
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.start();
    this.request.end(() => callback());
  }

  /** End the response with an error in the trailers Lambda forwards to the caller. */
  fail(error: unknown): Promise<void> {
    this.start();
    const report = errorReport(error);
    this.request.addTrailers({
      [ERROR_TYPE_TRAILER]: `Function.${report.errorType}`,
      [ERROR_BODY_TRAILER]: Buffer.from(JSON.stringify(report)).toString("base64"),
    });
    return new Promise((resolve) => this.request.end(() => resolve()));
  }
}

/** The managed runtime's `awslambda` global, for the handlers written against it. */
export function installAwsLambdaGlobal(): void {
  (globalThis as Record<string, unknown>)["awslambda"] = {
    streamifyResponse(handler: StreamingHandler): StreamingHandler {
      handler[STREAMING] = true;
      return handler;
    },
    HttpResponseStream: {
      from(stream: LambdaResponseStream, metadata: object): LambdaResponseStream {
        stream.setContentType(HTTP_INTEGRATION_CONTENT_TYPE);
        (stream as ResponseStream).prelude = [
          Buffer.from(JSON.stringify(metadata)),
          PRELUDE_DELIMITER,
        ];
        return stream;
      },
    },
  };
}

/**
 * Lambda's text log lines: one CloudWatch event per write to stdout, so a
 * multi-line message (a stack trace) keeps its line breaks as carriage
 * returns, as the managed runtime does, rather than splitting into events.
 */
let currentRequestId: string | undefined;
function installConsole(): void {
  const levels = {
    log: "INFO",
    info: "INFO",
    warn: "WARN",
    error: "ERROR",
    debug: "DEBUG",
    trace: "TRACE",
  } as const;
  for (const [method, level] of Object.entries(levels)) {
    const stream = level === "WARN" || level === "ERROR" ? process.stderr : process.stdout;
    (console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (
      ...args: unknown[]
    ) => {
      const line = `${new Date().toISOString()}\t${currentRequestId ?? "undefined"}\t${level}\t${format(...args)}`;
      stream.write(`${line.replace(/\n/g, "\r")}\n`);
    };
  }
}

/** `_HANDLER` is `<path from the task root, no extension>.<export>`. */
async function loadHandler(): Promise<BufferedHandler | StreamingHandler> {
  const spec = process.env["_HANDLER"] ?? "";
  const dot = spec.lastIndexOf(".");
  if (dot <= 0) throw new Error(`Malformed handler "${spec}"`);
  const root = process.env["LAMBDA_TASK_ROOT"] ?? process.cwd();
  const base = path.resolve(root, spec.slice(0, dot));
  const file = [".mjs", ".js", ".cjs"]
    .map((ext) => base + ext)
    .find((candidate) => existsSync(candidate));
  if (!file) throw new Error(`No module for handler "${spec}" at ${base}.{mjs,js,cjs}`);
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const handler = mod[spec.slice(dot + 1)];
  if (typeof handler !== "function")
    throw new Error(`Handler "${spec}" is not an exported function`);
  return handler as BufferedHandler | StreamingHandler;
}

function contextFor(headers: http.IncomingHttpHeaders): LambdaContext {
  const deadline = Number(headers["lambda-runtime-deadline-ms"]);
  return {
    awsRequestId: String(headers["lambda-runtime-aws-request-id"]),
    invokedFunctionArn: String(headers["lambda-runtime-invoked-function-arn"] ?? ""),
    functionName: process.env["AWS_LAMBDA_FUNCTION_NAME"] ?? "",
    functionVersion: process.env["AWS_LAMBDA_FUNCTION_VERSION"] ?? "",
    memoryLimitInMB: process.env["AWS_LAMBDA_FUNCTION_MEMORY_SIZE"] ?? "",
    logGroupName: process.env["AWS_LAMBDA_LOG_GROUP_NAME"] ?? "",
    logStreamName: process.env["AWS_LAMBDA_LOG_STREAM_NAME"] ?? "",
    callbackWaitsForEmptyEventLoop: false,
    getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()),
  };
}

/** Run one invocation `next` (the `invocation/next` answer) and post its result. */
export async function runInvocation(
  api: RuntimeApi,
  handler: BufferedHandler | StreamingHandler,
  next: ApiResponse,
): Promise<void> {
  const context = contextFor(next.headers);
  const requestId = context.awsRequestId;
  const invocationIdHeader = next.headers["lambda-runtime-invocation-id"];
  const invocationId = typeof invocationIdHeader === "string" ? invocationIdHeader : undefined;
  const trace = next.headers["lambda-runtime-trace-id"];
  if (typeof trace === "string") process.env["_X_AMZN_TRACE_ID"] = trace;
  else delete process.env["_X_AMZN_TRACE_ID"];
  currentRequestId = requestId;

  let event: unknown;
  try {
    event = next.body.length ? JSON.parse(next.body.toString("utf8")) : {};
  } catch (error) {
    await api.postError(
      `invocation/${requestId}/error`,
      error,
      "Runtime.InvalidEvent",
      invocationId,
    );
    return;
  }

  if ((handler as StreamingHandler)[STREAMING]) {
    const { request, done } = api.openStream(requestId, invocationId);
    const stream = new ResponseStream(request);
    try {
      await (handler as StreamingHandler)(event, stream, context);
      if (!stream.writableEnded) await new Promise<void>((resolve) => stream.end(resolve));
    } catch (error) {
      console.error("[lambda-runtime] streaming handler failed:", error);
      await stream.fail(error);
    }
    const response = await done;
    if (response.status >= 300) {
      console.error(
        `[lambda-runtime] streamed response refused (${response.status}): ${response.body.toString()}`,
      );
    }
    return;
  }

  try {
    const result = await (handler as BufferedHandler)(event, context);
    await api.request("POST", `invocation/${requestId}/response`, {
      headers: invocationId ? { "Lambda-Runtime-Invocation-Id": invocationId } : {},
      body: JSON.stringify(result ?? null),
    });
  } catch (error) {
    console.error("[lambda-runtime] handler failed:", error);
    await api.postError(`invocation/${requestId}/error`, error, undefined, invocationId);
  }
}

const KEY_VARIABLES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;

/** Which AWS credentials the function's own SDK calls would use, for the log. */
function credentialSource(): string {
  const endpoint = Boolean(process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"]);
  const keys = Boolean(process.env["AWS_ACCESS_KEY_ID"]);
  return endpoint && keys ? "endpoint and keys" : endpoint ? "endpoint" : keys ? "keys" : "none";
}

/**
 * The environment is the one init saw, possibly days ago. SnapStart serves
 * the role's credentials from the container endpoint for that reason; access
 * keys copied in from init would have expired and, coming first in the SDK's
 * chain, would shadow it. So drop them when the endpoint is there.
 */
function dropSnapshottedCredentials(): void {
  if (!process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"]) {
    if (process.env["AWS_ACCESS_KEY_ID"]) {
      console.warn(
        "[lambda-runtime] restored with only init-time access keys; the role's SDK calls may fail once they expire",
      );
    }
    return;
  }
  for (const name of KEY_VARIABLES) delete process.env[name];
}

/**
 * SnapStart's two steps: refuse a snapshot that would share randomness, then
 * block on `restore/next` until Lambda resumes this environment from it.
 * Returns whether a restore happened.
 */
async function snapshotAndRestore(api: RuntimeApi): Promise<boolean> {
  try {
    const report = assertSnapshotSafe();
    if (report) console.warn(`[lambda-runtime] ${report}`);
    const open = process
      .getActiveResourcesInfo()
      .filter((kind) => kind === "TCPSocketWrap" || kind === "TLSWrap");
    if (open.length > 0) {
      // Not fatal: a pooled client reconnects. But a socket open now is dead
      // after the restore, and the first request on it pays for finding out.
      console.warn(`[lambda-runtime] snapshotting with ${open.length} open sockets`);
    }
  } catch (error) {
    console.error("[lambda-runtime] refusing the snapshot:", error);
    await api.postError("init/error", error, "Runtime.BeforeSnapshotError");
    process.exit(1);
  }

  const restored = await api.request("GET", "restore/next");
  // 404: SnapStart is off for this version ($LATEST, or a local emulator).
  if (restored.status === 404) return false;
  if (restored.status !== 200) {
    console.error(
      `[lambda-runtime] restore/next answered ${restored.status}: ${restored.body.toString()}`,
    );
    process.exit(1);
  }
  try {
    api.resetConnections();
    afterSnapshotRestore();
    dropSnapshottedCredentials();
  } catch (error) {
    await api.postError("restore/error", error, "Runtime.AfterRestoreError");
    process.exit(1);
  }
  return true;
}

/** Run the runtime: init, the SnapStart steps when they apply, then the invoke loop. */
export async function startLambdaRuntime(): Promise<never> {
  const address = process.env["AWS_LAMBDA_RUNTIME_API"];
  if (!address) throw new Error("AWS_LAMBDA_RUNTIME_API is not set; this runs only inside Lambda");
  const api = new RuntimeApi(address);
  const snapStart = process.env["AWS_LAMBDA_INITIALIZATION_TYPE"] === "snap-start";

  installConsole();
  process.on("unhandledRejection", (reason) => {
    console.error("[lambda-runtime] unhandled rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[lambda-runtime] uncaught exception:", error);
  });
  if (snapStart) prepareSnapshotRandomness();
  installAwsLambdaGlobal();

  let handler: BufferedHandler | StreamingHandler;
  try {
    handler = await loadHandler();
  } catch (error) {
    console.error("[lambda-runtime] init failed:", error);
    await api.postError("init/error", error, "Runtime.ImportModuleError");
    process.exit(1);
  }

  if (snapStart && (await snapshotAndRestore(api))) {
    console.log(`[lambda-runtime] restored from snapshot (AWS credentials: ${credentialSource()})`);
  }

  for (;;) {
    currentRequestId = undefined;
    const next = await api.request("GET", "invocation/next");
    if (next.status !== 200) {
      console.error(
        `[lambda-runtime] invocation/next answered ${next.status}: ${next.body.toString()}`,
      );
      process.exit(1);
    }
    await runInvocation(api, handler, next);
  }
}
