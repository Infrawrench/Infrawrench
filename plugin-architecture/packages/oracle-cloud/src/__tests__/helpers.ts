import { OracleCloudClient } from "../client.js";

/**
 * A throwaway RSA key generated per test run, so no private key (not even a
 * published test vector) is committed. Exported as the key pair and as the
 * PKCS#8 PEM a user would paste.
 */
export const TEST_KEY_PAIR = (await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;

export const TEST_PKCS8 = new Uint8Array(
  await crypto.subtle.exportKey("pkcs8", TEST_KEY_PAIR.privateKey),
);

export function pemOf(label: string, der: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----`;
}

export const TEST_KEY = pemOf("PRIVATE KEY", TEST_PKCS8);

export const TENANCY = "ocid1.tenancy.oc1..aaaatenancy";

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  raw?: string;
}

export interface Recorded {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Fake host HTTP service: every request is signed, routed and recorded offline. */
export function makeHttp(route: (url: URL, method: string, body: unknown) => Reply | undefined) {
  const calls: Recorded[] = [];
  const http = {
    async request(req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string | Uint8Array;
    }) {
      const url = new URL(req.url);
      const body =
        typeof req.body === "string" && req.body.length > 0 ? JSON.parse(req.body) : undefined;
      calls.push({ url, method: req.method, headers: req.headers, body });
      const reply = route(url, req.method, body) ?? {
        status: 404,
        body: { code: "NotAuthorizedOrNotFound", message: "nope" },
      };
      const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
      return { status: reply.status ?? 200, headers: reply.headers ?? {}, body: text };
    },
  };
  return { http, calls };
}

export function makeClient(route: Parameters<typeof makeHttp>[0], region = "us-ashburn-1") {
  const { http, calls } = makeHttp(route);
  const client = new OracleCloudClient(
    {
      tenancyOcid: TENANCY,
      userOcid: "ocid1.user.oc1..aaaauser",
      fingerprint: "aa:bb",
      privateKey: TEST_KEY,
      region,
    },
    { http },
  );
  return { client, calls };
}

/** Common identity answers: one region, one child compartment, no Search. */
export function identityRoute(url: URL): Reply | undefined {
  if (url.hostname.startsWith("identity.")) {
    if (url.pathname.endsWith("/regionSubscriptions")) {
      return { body: [{ regionName: "us-ashburn-1", status: "READY", isHomeRegion: true }] };
    }
    if (url.pathname === `/20160918/tenancies/${TENANCY}`) {
      return { body: { id: TENANCY, name: "acme", description: "Acme tenancy" } };
    }
    if (url.pathname === "/20160918/compartments") {
      return {
        body: [
          {
            id: "ocid1.compartment.oc1..prod",
            compartmentId: TENANCY,
            name: "prod",
            lifecycleState: "ACTIVE",
          },
        ],
      };
    }
    if (url.pathname === "/20160918/regions")
      return { body: [{ key: "IAD", name: "us-ashburn-1" }] };
    if (url.pathname === "/20160918/availabilityDomains") {
      return { body: [{ name: "Uocm:US-ASHBURN-AD-1" }, { name: "Uocm:US-ASHBURN-AD-2" }] };
    }
  }
  if (url.hostname.startsWith("query."))
    return { status: 403, body: { code: "NotAuthorized", message: "" } };
  return undefined;
}
