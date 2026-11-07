import { hostClient } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, vi } from "vitest";
import { RailwayClient } from "../client.js";
import { RESOURCE_TYPES } from "../resource-types.js";

export const ACC = "acct";
export const UNREAD_HOOK = Symbol.for("infrawrench.unreadListPart");
export const TRUNCATED = "has more than Infrawrench reads";
export const NOT_A_LIST = "is not a list";
export const SAYS_MORE = "says there is more";

export interface Call {
  query: string;
  variables: Record<string, unknown>;
  url: string;
  caCert: string | undefined;
}

export type Route = (c: Call) => unknown;

export function client(route: Route) {
  const calls: Call[] = [];
  const request = vi.fn(
    async (req: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      caCert?: string;
    }) => {
      const parsed = JSON.parse(req.body ?? "{}") as {
        query: string;
        variables: Record<string, unknown>;
      };
      const call = { ...parsed, url: req.url, caCert: req.caCert };
      calls.push(call);
      return { status: 200, headers: {}, body: JSON.stringify(route(call)) };
    },
  );
  const c = hostClient(
    new RailwayClient({ apiToken: "tok" }, RESOURCE_TYPES, { http: { request } }),
  );
  return { c, calls, request };
}

/** Pretends to be a host that tracks unread rows, as the server's sync does. */
export function trackUnread() {
  const parts: Array<{ parentResourceIds?: readonly string[]; idPrefixes?: readonly string[] }> =
    [];
  Reflect.set(globalThis, UNREAD_HOOK, (part: (typeof parts)[number]) => void parts.push(part));
  return parts;
}

/** Every test file that imports these runs with no network and no unread hook left over. */
export function isolate(): void {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no network in tests");
      }),
    );
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, UNREAD_HOOK);
    vi.unstubAllGlobals();
  });
}

export const done = { hasNextPage: false, endCursor: null };
export const more = (cursor: string) => ({ hasNextPage: true, endCursor: cursor });
export const conn = <T>(rows: T[], pageInfo: object = done) => ({
  pageInfo,
  edges: rows.map((node) => ({ node })),
});

export const instance = (envId: string, serviceId: string) => ({
  id: `si-${envId}-${serviceId}`,
  serviceId,
  serviceName: serviceId,
  environmentId: envId,
  domains: { serviceDomains: [], customDomains: [] },
  latestDeployment: null,
});
export const volume = (envId: string, volumeId: string) => ({
  id: `vi-${volumeId}`,
  volumeId,
  serviceId: null,
  environmentId: envId,
  mountPath: "/data",
  sizeMB: 1000,
  volume: { id: volumeId, name: volumeId },
});
export const env = (id: string, services: string[], instancesInfo: object = done) => ({
  id,
  name: id,
  serviceInstances: conn(
    services.map((s) => instance(id, s)),
    instancesInfo,
  ),
  volumeInstances: conn([]),
});

/** One workspace, one project, and whatever `tree` answers for the project. */
export function routes(tree: (c: Call) => unknown, extra: Route = () => undefined): Route {
  return (c) => {
    const out = extra(c);
    if (out !== undefined) return out;
    if (c.query.includes("apiToken"))
      return { data: { apiToken: { workspaces: [{ id: "w1", name: "Acme" }] } } };
    if (c.query.includes("query Projects(")) return { data: { projects: conn([{ id: "p1" }]) } };
    if (c.query.includes("query ProjectTree(")) return tree(c);
    throw new Error(`unrouted ${c.query.slice(0, 80)}`);
  };
}

export const project = (fields: Record<string, unknown>) => ({
  data: {
    project: {
      id: "p1",
      name: "shop",
      services: conn([]),
      environments: conn([env("e1", ["s1"])]),
      ...fields,
    },
  },
});
