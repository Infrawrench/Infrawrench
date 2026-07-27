/**
 * Main-process HTTP for the workflow sandbox's global `fetch`.
 *
 * The cloud sends a workflow's requests through a proxy that sits outside its
 * Kubernetes cluster, because a request made from inside that cluster could
 * reach other tenants' pods and the node's metadata credentials. Desktop has no
 * such problem and no such proxy: the workflow is code the user wrote, running
 * on the user's own machine, with the user's own network. Reaching a box on
 * their LAN is a feature here, not an escape — so the request is made directly
 * and no address is blocked.
 *
 * It runs in main rather than the renderer for the same reason SSH does: the
 * renderer is Chromium, where a cross-origin request would be subject to CORS
 * and preflight rules that have nothing to do with what the workflow author
 * asked for. Node's fetch has neither.
 *
 * Unlike every other host capability, this one is served *here* rather than
 * bridged back to the renderer (see workflow-host.ts) — the request needs
 * nothing the renderer owns (no plugin client, no DB, no prompt UI), so a round
 * trip would only add latency.
 */
import type {
  WorkflowFetchRequest,
  WorkflowFetchResponse,
} from "@infrawrench/workflow-runtime" with { "resolution-mode": "import" };

/** Read at most `maxBytes`, failing rather than handing back half a document. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(
        `Response body exceeded ${maxBytes} bytes. Raise maxBytes or request less data.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Perform one already-validated workflow request. */
export async function workflowFetch(request: WorkflowFetchRequest): Promise<WorkflowFetchResponse> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.bodyBase64 !== undefined
        ? { body: Buffer.from(request.bodyBase64, "base64") }
        : {}),
      redirect: request.redirect,
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`fetch() failed: ${reason}`, { cause: err });
  }

  const bytes = await readCapped(response, request.maxBytes);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url || request.url,
    headers,
    bodyBase64: bytes.toString("base64"),
    redirected: response.redirected,
  };
}
