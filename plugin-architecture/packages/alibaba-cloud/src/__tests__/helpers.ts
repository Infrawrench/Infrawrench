import { AlibabaCloudClient } from "../client.js";

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  action: string;
  params: Record<string, string>;
  body?: string | Uint8Array;
}

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
}

/** Fake host HTTP service: requests are recorded and routed by host and action. */
export function makeClient(
  route: (req: Recorded) => Reply | undefined,
  creds: Record<string, string> = {},
) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const params: Record<string, string> = {};
      url.searchParams.forEach((v, k) => (params[k] = v));
      if (typeof req.body === "string" && req.headers["content-type"]?.includes("form")) {
        new URLSearchParams(req.body).forEach((v, k) => (params[k] = v));
      }
      const rec: Recorded = {
        url,
        method: req.method,
        headers: req.headers,
        action: req.headers["x-acs-action"] ?? "",
        params,
        ...(req.body !== undefined ? { body: req.body } : {}),
      };
      calls.push(rec);
      const reply = route(rec) ?? {
        status: 404,
        body: { Code: "NotFound", Message: `no route for ${url.host} ${rec.action}` },
      };
      const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
      return { status: reply.status ?? 200, headers: {}, body: text };
    },
  };
  const client = new AlibabaCloudClient(
    {
      accessKeyId: "LTAI5ttest",
      accessKeySecret: "secret",
      region: "ap-southeast-1",
      regions: "ap-southeast-1, eu-central-1",
      ...creds,
    },
    { http } as never,
  );
  return { client, calls };
}
