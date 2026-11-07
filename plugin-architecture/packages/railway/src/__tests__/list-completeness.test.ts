import { describe, expect, it } from "vitest";
import {
  ACC,
  NOT_A_LIST,
  SAYS_MORE,
  TRUNCATED,
  conn,
  client,
  done,
  env,
  instance,
  isolate,
  more,
  project,
  routes,
  volume,
} from "./helpers.js";

isolate();

describe("projects", () => {
  it("throws past the page cap instead of returning the projects read so far", async () => {
    let n = 0;
    const { c, calls } = client(
      routes(
        () => project({}),
        (call) =>
          call.query.includes("query Projects(")
            ? { data: { projects: conn([{ id: `p${n++}` }], more(`c${n}`)) } }
            : undefined,
      ),
    );
    await expect(c.listResources("project", ACC)).rejects.toThrow(TRUNCATED);
    expect(calls.filter((x) => x.query.includes("query Projects(")).length).toBe(100);
  });

  it("refuses a page whose list is missing, on the first page and a later one", async () => {
    for (const later of [false, true]) {
      const { c } = client(
        routes(
          () => project({}),
          (call) => {
            if (!call.query.includes("query Projects(")) return undefined;
            if (later && !call.variables["after"])
              return { data: { projects: conn([{ id: "p1" }], more("c1")) } };
            return { data: { projects: { pageInfo: done, nodes: [{ id: "p2" }] } } };
          },
        ),
      );
      await expect(c.listResources("project", ACC)).rejects.toThrow(NOT_A_LIST);
    }
  });

  it("refuses a page that says there is more with no cursor", async () => {
    const { c } = client(
      routes(
        () => project({}),
        (call) =>
          call.query.includes("query Projects(")
            ? { data: { projects: conn([{ id: "p1" }], { hasNextPage: true, endCursor: null }) } }
            : undefined,
      ),
    );
    await expect(c.listResources("project", ACC)).rejects.toThrow(SAYS_MORE);
  });

  it("sends through the host transport without a CA it was not given", async () => {
    const { c, request } = client(routes(() => project({})));
    await c.listResources("project", ACC);
    expect(request).toHaveBeenCalled();
    expect(request.mock.calls.every(([req]) => !("caCert" in req))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("project tree", () => {
  it("follows the services, environments, service and volume instances past one page", async () => {
    const { c, calls } = client(
      routes(
        () =>
          project({
            services: conn([{ id: "s1", name: "api" }], more("svc1")),
            environments: conn(
              [
                {
                  ...env("e1", ["s1"], more("si1")),
                  volumeInstances: conn([volume("e1", "v1")], more("vi1")),
                },
              ],
              more("env1"),
            ),
          }),
        (call) => {
          if (call.query.includes("query ProjectServices(")) {
            expect(call.variables).toMatchObject({ id: "p1", after: "svc1" });
            return { data: { project: { services: conn([{ id: "s2", name: "worker" }]) } } };
          }
          if (call.query.includes("query ProjectEnvironments(")) {
            expect(call.variables).toMatchObject({ id: "p1", after: "env1" });
            return { data: { project: { environments: conn([env("e2", ["s1"])]) } } };
          }
          if (call.query.includes("query EnvironmentServiceInstances(")) {
            expect(call.variables).toMatchObject({ id: "e1", after: "si1" });
            return {
              data: { environment: { serviceInstances: conn([instance("e1", "s2")]) } },
            };
          }
          if (call.query.includes("query EnvironmentVolumeInstances(")) {
            expect(call.variables).toMatchObject({ id: "e1", after: "vi1" });
            return {
              data: {
                environment: {
                  volumeInstances: conn([{ ...volume("e1", "v2"), serviceId: "s2" }]),
                },
              },
            };
          }
          return undefined;
        },
      ),
    );
    const envs = await c.listResources("environment", ACC);
    expect(envs.map((e) => e.externalId)).toEqual(["e1", "e2"]);
    const services = await c.listResources("service", ACC);
    expect(services.map((s) => s.externalId)).toEqual(["e1/s1", "e1/s2", "e2/s1"]);
    const volumes = await c.listResources("volume", ACC);
    expect(volumes.map((v) => v.externalId)).toEqual(["e1/v1", "e1/v2"]);
    // The service named on the services list's second page.
    expect(volumes[1]!.fields["serviceName"]).toBe("worker");
    expect(calls.filter((x) => x.query.includes("query ProjectTree(")).length).toBe(1);
  });

  it("throws when a nested list never ends", async () => {
    let n = 0;
    const { c } = client(
      routes(
        () => project({ environments: conn([env("e1", ["s0"], more("c0"))]) }),
        (call) =>
          call.query.includes("query EnvironmentServiceInstances(")
            ? {
                data: {
                  environment: {
                    serviceInstances: conn([instance("e1", `s${++n}`)], more(`c${n}`)),
                  },
                },
              }
            : undefined,
      ),
    );
    await expect(c.listResources("service", ACC)).rejects.toThrow(TRUNCATED);
  });

  it("refuses a nested list that is missing instead of reading it as none", async () => {
    const { c } = client(routes(() => project({ environments: { pageInfo: done } })));
    await expect(c.listResources("environment", ACC)).rejects.toThrow(NOT_A_LIST);
  });

  it("keeps the project when an environment goes between pages", async () => {
    const { c } = client(
      routes(
        () =>
          project({
            environments: conn([env("e1", ["s1"]), env("e2", ["s1"], more("c1"))]),
          }),
        (call) =>
          call.query.includes("query EnvironmentServiceInstances(")
            ? { data: null, errors: [{ message: "Environment not found" }] }
            : undefined,
      ),
    );
    const services = await c.listResources("service", ACC);
    expect(services.map((s) => s.externalId)).toEqual(["e1/s1"]);
    expect((await c.listResources("project", ACC)).map((p) => p.externalId)).toEqual(["p1"]);
  });

  it("fails the walk on a refused follow-up page instead of dropping the project", async () => {
    const { c } = client(
      routes(
        () => project({ services: conn([{ id: "s1", name: "api" }], more("c1")) }),
        (call) =>
          call.query.includes("query ProjectServices(")
            ? { data: null, errors: [{ message: "Not Authorized" }] }
            : undefined,
      ),
    );
    await expect(c.listResources("project", ACC)).rejects.toMatchObject({ status: 403 });
  });
});
