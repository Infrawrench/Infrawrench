/** A fixture-only OpenStack transport for the list tests. */
import { afterEach, vi } from "vitest";
import type { HttpHostServices } from "@infrawrench/plugin-base";

export const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");

export const CATALOG = [
  {
    type: "compute",
    endpoints: [
      { interface: "public", region_id: "RegionOne", url: "https://nova.example.com/v2.1" },
      { interface: "public", region_id: "RegionTwo", url: "https://nova2.example.com/v2.1" },
    ],
  },
  {
    type: "network",
    endpoints: [
      { interface: "public", region_id: "RegionOne", url: "https://neutron.example.com/" },
      { interface: "internal", region_id: "RegionOne", url: "http://neutron.internal:9696" },
    ],
  },
  {
    type: "volumev3",
    endpoints: [
      { interface: "public", region_id: "RegionOne", url: "https://cinder.example.com/v3/proj1" },
    ],
  },
  {
    type: "object-store",
    endpoints: [
      {
        interface: "public",
        region_id: "RegionOne",
        url: "https://swift.example.com/v1/AUTH_proj1",
      },
    ],
  },
  {
    type: "identity",
    endpoints: [
      { interface: "public", region_id: "RegionOne", url: "https://keystone.example.com:5000/v3" },
    ],
  },
];

export interface Req {
  method: string;
  url: URL;
}
export type Answer = { status: number; body?: unknown; headers?: Record<string, string> };

/** A transport that only answers Keystone and `answer`, and fails the test on anything else. */
export function transport(answer: (req: Req) => Answer | undefined) {
  const seen: Req[] = [];
  const http: HttpHostServices = {
    async request(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v3/auth/tokens") {
        return {
          status: 201,
          headers: { "x-subject-token": "tok" },
          body: JSON.stringify({
            token: {
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              project: { id: "proj1", name: "demo" },
              user: { id: "u1" },
              catalog: CATALOG,
            },
          }),
        };
      }
      seen.push({ method: req.method, url });
      const a = answer({ method: req.method, url });
      if (!a) throw new Error(`unexpected request ${req.method} ${req.url}`);
      return {
        status: a.status,
        headers: a.headers ?? {},
        body: a.body === undefined ? "" : JSON.stringify(a.body),
      };
    },
  };
  return { http, seen };
}

export const APP = {
  authUrl: "https://keystone.example.com:5000",
  applicationCredentialId: "abc",
  applicationCredentialSecret: "s3cret",
  region: "RegionOne",
};

export function recordUnread() {
  const parts: Array<{ parentResourceIds?: readonly string[]; idPrefixes?: readonly string[] }> =
    [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: (typeof parts)[number]) => parts.push(part));
  return parts;
}

/** Call once per test file that uses `recordUnread` or fake timers. */
export function resetAfterEach(): void {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    vi.useRealTimers();
  });
}

export const ok = (body: unknown): Answer => ({ status: 200, body });
