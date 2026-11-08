/**
 * Kubernetes on this machine: `kubectl exec` and k9s in a PTY, `kubectl
 * port-forward`, and the plugins' HTTP requests to a cluster API (routed
 * through Node so a per-request cluster CA can be trusted).
 *
 * A terminal and a port-forward are each one streaming call. The stream's
 * first event says it is up (`Opened` with the id the input calls address,
 * or `Forwarding` with the bound port); a terminal's output follows, and the
 * stream ends when the process exits. Interrupting it, which is what closing
 * the tab does, and the renderer going away (a reload, a closed window) both
 * close the stream's scope, and that is what kills the process and removes
 * the kubeconfig it was given: there is no separate kill call to forget.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

/**
 * Everything below lands on a kubectl/k9s command line. Kubernetes object
 * names never start with "-", so refusing that keeps a renderer-supplied
 * name from being read as a flag (`--kubeconfig=...`); the kubeconfig is
 * vetted by the local-exec consent gate before it is written to disk.
 */
const K8sName = Schema.String.check(
  Schema.isBetweenLength(1, 253),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const Kubeconfig = Schema.String.check(Schema.isBetweenLength(1, 256 * 1024));
const TermSize = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const K8sExecConfig = Schema.Struct({
  kubeconfig: Kubeconfig,
  namespace: K8sName,
  podName: K8sName,
  containerName: Schema.optionalKey(K8sName),
  cols: TermSize,
  rows: TermSize,
});
export type K8sExecConfig = typeof K8sExecConfig.Type;

export const K9sConfig = Schema.Struct({
  kubeconfig: Kubeconfig,
  namespace: Schema.optionalKey(K8sName),
  cols: TermSize,
  rows: TermSize,
});
export type K9sConfig = typeof K9sConfig.Type;

export const K8sPortForwardConfig = Schema.Struct({
  kubeconfig: Kubeconfig,
  namespace: K8sName,
  resourceType: Schema.Literals(["svc", "pod", "deploy"]),
  resourceName: K8sName,
  remotePort: Port,
  /** 0, or absent, lets kubectl pick a free port. */
  localPort: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 }))),
});
export type K8sPortForwardConfig = typeof K8sPortForwardConfig.Type;

export const K8sTerminalEvent = Schema.Union([
  /** The process is running; `sessionId` addresses the write and resize calls. */
  Schema.TaggedStruct("Opened", { sessionId: Schema.String }),
  /** Bytes from the PTY, in the order they arrived. */
  Schema.TaggedStruct("Data", { data: Schema.Uint8Array }),
]);
export type K8sTerminalEvent = typeof K8sTerminalEvent.Type;

/** The forward is listening on `localPort`; the stream ends when kubectl exits. */
export const K8sPortForwardEvent = Schema.TaggedStruct("Forwarding", { localPort: Schema.Int });
export type K8sPortForwardEvent = typeof K8sPortForwardEvent.Type;

/**
 * A plugin's request to a cluster API. A byte body goes in `bodyBytes`
 * (a JSON frame cannot tell a string from base64 bytes); `"binary"` answers
 * with the raw bytes in `rawBody` and an empty `body`.
 */
export const K8sApiRequest = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.optionalKey(Schema.String),
  bodyBytes: Schema.optionalKey(Schema.Uint8Array),
  /** PEM-encoded CA certificate. */
  caCert: Schema.optionalKey(Schema.String),
  responseEncoding: Schema.optionalKey(Schema.Literals(["utf8", "binary"])),
  /** Accepted for `HttpHostServices`; `node:https` reads trailers on every request. */
  readTrailers: Schema.optionalKey(Schema.Boolean),
});
export type K8sApiRequest = typeof K8sApiRequest.Type;

export const K8sApiResponse = Schema.Struct({
  status: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
  rawBody: Schema.optionalKey(Schema.Uint8Array),
  trailers: Schema.Record(Schema.String, Schema.String),
});
export type K8sApiResponse = typeof K8sApiResponse.Type;

/**
 * Why kubectl or k9s could not start or a cluster request failed, as the
 * sentence the terminal or plugin shows: a declined local-exec consent, a
 * missing binary, `kubectl port-forward exited with code 1: ...`, a host
 * outside the SSRF allowlist.
 */
export class K8sLocalError extends Schema.TaggedError<K8sLocalError>()("K8sLocalError", {
  message: Schema.String,
}) {}

const TerminalInput = { sessionId: Schema.String, data: Schema.String };
const TerminalResize = { sessionId: Schema.String, cols: Schema.Finite, rows: Schema.Finite };

export class K8sLocalRpcs extends RpcGroup.make(
  Rpc.make("K8sExecOpen", {
    payload: K8sExecConfig,
    success: K8sTerminalEvent,
    error: K8sLocalError,
    stream: true,
  }),
  /** Keystrokes for an open session. A session this renderer does not own is ignored. */
  Rpc.make("K8sExecWrite", { payload: TerminalInput }),
  Rpc.make("K8sExecResize", { payload: TerminalResize }),
  /** Whether k9s is installed where the app looks for it. */
  Rpc.make("K9sCheck", { success: Schema.Boolean }),
  Rpc.make("K9sOpen", {
    payload: K9sConfig,
    success: K8sTerminalEvent,
    error: K8sLocalError,
    stream: true,
  }),
  Rpc.make("K9sWrite", { payload: TerminalInput }),
  Rpc.make("K9sResize", { payload: TerminalResize }),
  Rpc.make("K8sPortForwardOpen", {
    payload: K8sPortForwardConfig,
    success: K8sPortForwardEvent,
    error: K8sLocalError,
    stream: true,
  }),
  Rpc.make("K8sApiRequest", {
    payload: K8sApiRequest,
    success: K8sApiResponse,
    error: K8sLocalError,
  }),
) {}
