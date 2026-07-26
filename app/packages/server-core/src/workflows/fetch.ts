/**
 * Cloud implementation of the workflow sandbox's global `fetch`.
 *
 * The `web` and `poller` pods run on the GKE cluster, so they are the last
 * place a workflow's outbound request should originate: from inside that
 * network, `fetch("http://10.x.x.x/")` reaches other pods and
 * `http://169.254.169.254/` reaches the node's metadata credentials. Rather
 * than trying to make an in-pod fetch safe, we don't make one at all — the
 * request is handed to a proxy Worker on Cloudflare's edge
 * (`app/packages/egress-proxy`), which has no route into the cluster or the GCP
 * project and refuses private address space besides.
 *
 * Config (env):
 *   WORKFLOW_FETCH_PROXY_URL    — e.g. https://egress.infrawrench.com
 *   WORKFLOW_FETCH_PROXY_TOKEN  — the Worker's PROXY_TOKEN secret
 *
 * With either missing, `fetch` inside a workflow throws and says so. That is
 * deliberate and load-bearing: a deployment that hasn't stood up a proxy gets
 * no HTTP from workflows, rather than quietly falling back to requests that
 * leave from a pod. A self-hoster running outside Kubernetes who wants the
 * direct behaviour can point the two vars at their own proxy.
 */
import type { WorkflowFetchRequest, WorkflowFetchResponse } from "@infrawrench/workflow-runtime";

/**
 * Outbound requests one run may make. A workflow looping over a paginated API
 * is normal; a workflow making thousands of calls is either a bug or someone
 * using the shared proxy as a load generator, and the run's own time budget
 * alone is a loose bound on it.
 */
export const MAX_FETCHES_PER_RUN = 250;

/** How long we wait on the proxy itself, beyond the request's own timeout. */
const PROXY_OVERHEAD_MS = 10_000;

function proxyUrl(): string | null {
  const raw = process.env["WORKFLOW_FETCH_PROXY_URL"];
  return raw ? raw.replace(/\/$/, "") : null;
}

function proxyToken(): string | null {
  return process.env["WORKFLOW_FETCH_PROXY_TOKEN"] ?? null;
}

/** Whether this deployment can make outbound HTTP from a workflow at all. */
export function isWorkflowFetchConfigured(): boolean {
  return Boolean(proxyUrl() && proxyToken());
}

interface ProxyEnvelope {
  response?: WorkflowFetchResponse;
  error?: { code?: string; message?: string };
}

/**
 * Send one already-validated {@link WorkflowFetchRequest} through the proxy.
 *
 * Errors are thrown with the proxy's own message, because the workflow author
 * is the one who has to act on them ("10.0.0.5 is a private address and is not
 * proxied" is a fixable complaint; "fetch failed" is not).
 */
export async function fetchFromWorkflow(
  request: WorkflowFetchRequest,
): Promise<WorkflowFetchResponse> {
  const base = proxyUrl();
  const token = proxyToken();
  if (!base || !token) {
    throw new Error(
      "Outbound fetch() is not available: this deployment has no workflow egress proxy configured " +
        "(WORKFLOW_FETCH_PROXY_URL / WORKFLOW_FETCH_PROXY_TOKEN).",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${base}/fetch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(request.timeoutMs + PROXY_OVERHEAD_MS),
    });
  } catch (err) {
    throw new Error(
      `fetch() could not reach the egress proxy: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let envelope: ProxyEnvelope;
  try {
    envelope = (await res.json()) as ProxyEnvelope;
  } catch {
    throw new Error(`fetch() got a malformed reply from the egress proxy (HTTP ${res.status}).`);
  }

  if (envelope.error || !envelope.response) {
    const message = envelope.error?.message ?? `egress proxy returned HTTP ${res.status}`;
    throw new Error(`fetch() failed: ${message}`);
  }
  return envelope.response;
}

/**
 * A per-run `fetch` for {@link file://./runner.ts}: the same proxy call, with
 * the run's request budget closed over so the cap applies across the whole run
 * rather than per call.
 */
export function buildWorkflowFetch(): (
  request: WorkflowFetchRequest,
) => Promise<WorkflowFetchResponse> {
  let used = 0;
  return (request) => {
    used += 1;
    if (used > MAX_FETCHES_PER_RUN) {
      return Promise.reject(
        new Error(`This run has made its maximum of ${MAX_FETCHES_PER_RUN} fetch() calls.`),
      );
    }
    return fetchFromWorkflow(request);
  };
}
