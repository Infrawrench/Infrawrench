/**
 * A plugin's HTTP request from the renderer (`K8sApiRequest`, the desktop's
 * `HttpHostServices.request`), routed through Node so a per-request cluster
 * CA can be trusted: Chromium's fetch will not.
 *
 * SSRF defense: see `k8s-endpoints.ts` for the allowlist trust model. The
 * name is resolved once, every address is vetted, and the connection is
 * pinned to the vetted address so a second lookup cannot answer differently.
 */
import https from "node:https";
import http from "node:http";
import type { K8sApiRequest, K8sApiResponse } from "../shared/rpc/groups/k8s-local";
import { errorMessage } from "../shared/rpc/errors";
import { isCredentialEndpoint } from "./cors-policy";
import { resolveK8sApiEndpoint, type ResolvedAddress } from "./k8s-endpoints";

const REQUEST_TIMEOUT_MS = 30_000;

function parseRequestUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("k8s_api_request: invalid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`k8s_api_request: scheme "${parsed.protocol}" not permitted`);
  }
  return parsed;
}

function send(req: K8sApiRequest, parsed: URL, pinned: ResolvedAddress): Promise<K8sApiResponse> {
  const isHttps = parsed.protocol === "https:";
  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: req.headers,
      lookup: (_hostname, opts, callback) => {
        if (opts.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    };
    if (isHttps && req.caCert) options.ca = req.caCert;

    const nodeReq = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
        const bytes = Buffer.concat(chunks);
        // Node parses a chunked response's trailer section by "end".
        const trailers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.trailers)) if (v != null) trailers[k] = v;
        const status = res.statusCode ?? 0;
        resolve(
          req.responseEncoding === "binary"
            ? {
                status,
                headers,
                body: "",
                rawBody: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length),
                trailers,
              }
            : { status, headers, body: bytes.toString("utf8"), trailers },
        );
      });
    });

    nodeReq.on("error", (err) => reject(err));
    nodeReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
      nodeReq.destroy(new Error("K8s API request timed out (30s)"));
    });

    const body = req.bodyBytes ?? req.body;
    if (body) nodeReq.write(body);
    nodeReq.end();
  });
}

export async function k8sApiRequest(req: K8sApiRequest): Promise<K8sApiResponse> {
  const parsed = parseRequestUrl(req.url);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  let pinned: ResolvedAddress;
  try {
    pinned = await resolveK8sApiEndpoint(parsed.hostname, port, {
      trusted: isCredentialEndpoint(parsed.hostname, port),
    });
  } catch (err) {
    throw new Error(
      `k8s_api_request: ${errorMessage(err)}. Add the cluster via your kubeconfig to allowlist it.`,
    );
  }
  return send(req, parsed, pinned);
}
