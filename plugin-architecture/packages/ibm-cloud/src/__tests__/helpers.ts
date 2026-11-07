import { hostClient } from "@infrawrench/plugin-base/effect";
import { IbmCloudClient } from "../client.js";

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const tokenFor = (accountId: string) =>
  `${b64url({ alg: "RS256" })}.${b64url({
    account: { bss: accountId },
    iam_id: "IBMid-1",
    sub: "ci@example.com",
  })}.sig`;

export const TEST_TOKEN = tokenFor("acct123");

/** Fake host HTTP: IAM always issues TEST_TOKEN; everything else goes to `route`. */
export function makeClient(
  route: (req: Recorded) => Reply | undefined,
  creds: Record<string, string> = {},
  accountId = "acct123",
) {
  const calls: Recorded[] = [];
  let tokenCalls = 0;
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const rec: Recorded = {
        url,
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
      };
      if (url.host === "iam.cloud.ibm.com") {
        tokenCalls++;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            access_token: tokenFor(accountId),
            refresh_token: "r",
            expires_in: 3600,
          }),
        };
      }
      calls.push(rec);
      const reply = route(rec) ?? {
        status: 404,
        body: { errors: [{ code: "not_found", message: `no route ${url.href}` }] },
      };
      return {
        status: reply.status ?? 200,
        headers: reply.headers ?? {},
        body: reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)),
      };
    },
  };
  const client = hostClient(
    new IbmCloudClient(
      { apiKey: "key", region: "us-south", regions: "us-south, eu-de", ...creds },
      { http } as never,
    ),
  );
  return { client, calls, tokenCalls: () => tokenCalls };
}
