import { hostPlugin } from "@infrawrench/plugin-base/effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appName, CI_TAGS_VAR, dynoBody, HEROKU_CI_EXECUTOR } from "../ci-executor.js";
import { slugTar } from "../ci-slug.js";
import { plugin as contractPlugin } from "../plugin.js";

const plugin = hostPlugin(contractPlugin);

interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[] = [];
type Route = ((c: Call) => unknown) | object;
let routes: Record<string, Route> = {};

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers });
}

const BLOB =
  "https://s3-external-1.amazonaws.com/herokuslugs/heroku.com/v1/slug-1?AWSAccessKeyId=x";

// No request leaves the test: every URL is answered from `routes`, and an
// unknown one is a 404 like Heroku's.
beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const u = new URL(url);
      const raw = init.body;
      const call = {
        method: init.method ?? "GET",
        url,
        path: u.hostname === "api.heroku.com" ? u.pathname : `${u.hostname}${u.pathname}`,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: raw instanceof Uint8Array ? raw : raw ? JSON.parse(String(raw)) : undefined,
      };
      calls.push(call);
      const h = routes[`${call.method} ${call.path}`];
      if (!h) return reply({ id: "not_found", message: "Couldn't find that app." }, 404);
      const out = typeof h === "function" ? (h as (c: Call) => unknown)(call) : h;
      return out instanceof Response ? out : reply(out);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const tags = {
  "infrawrench-ci": "org-1",
  "infrawrench-ci-run": "run-1",
  "infrawrench-ci-job": "5f0c1c2e-1111-4a4a-9b9b-0123456789ab",
};
const spec = {
  kind: "container" as const,
  bootstrap: "#!/bin/sh\necho hi\n",
  tags,
  name: "infrawrench-ci-build",
  maxSeconds: 1800,
};
const APP = "iwci-5f0c1c2e11114a4a9b9b01234";

function client(team = "") {
  return plugin.createClient({ apiKey: "HRKU-test", ...(team ? { team } : {}) });
}

function happyRoutes() {
  routes[`POST /apps`] = (c: Call) =>
    reply({ id: "app-1", name: (c.body as { name: string }).name, region: { name: "us" } }, 201);
  routes[`PATCH /apps/${APP}/config-vars`] = (c: Call) => c.body as object;
  routes[`POST /apps/${APP}/slugs`] = reply(
    { id: "slug-1", blob: { method: "put", url: BLOB } },
    201,
  );
  routes[`PUT s3-external-1.amazonaws.com/herokuslugs/heroku.com/v1/slug-1`] = new Response("", {
    status: 200,
  });
  routes[`POST /apps/${APP}/releases`] = reply({ id: "rel-1", status: "succeeded" }, 201);
  routes[`POST /apps/${APP}/dynos`] = reply(
    { id: "dyno-1", name: "run.1", state: "starting", type: "run" },
    201,
  );
}

describe("declaration", () => {
  it("offers a one-off dyno as a container kind with Heroku's own names", () => {
    expect(contractPlugin.manifest.ciExecutor).toBe(HEROKU_CI_EXECUTOR);
    const [kind] = HEROKU_CI_EXECUTOR.kinds;
    expect(kind.kind).toBe("container");
    expect(kind.defaults).toEqual({ machine: "standard-1X", image: "heroku-24", region: "us" });
  });
});

describe("appName", () => {
  it("is a valid Heroku app name of at most 30 characters, the same for the same job", () => {
    expect(appName(spec)).toBe(APP);
    expect(appName(spec)).toMatch(/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/);
  });
});

describe("dynoBody", () => {
  it("runs the slug's script detached, with the job's time as the dyno's time to live", () => {
    expect(dynoBody(spec)).toEqual({
      command: "sh /app/iwci-job.sh",
      type: "run",
      attach: false,
      size: "standard-1X",
      time_to_live: 1800,
    });
  });

  it("caps the time to live at Heroku's 24 hours", () => {
    expect(dynoBody({ ...spec, maxSeconds: 200_000, machine: "basic" })).toMatchObject({
      size: "basic",
      time_to_live: 86_400,
    });
  });
});

describe("slugTar", () => {
  it("puts the script under ./app/ in a ustar archive", () => {
    const tar = slugTar("iwci-job.sh", "echo hi\n");
    const text = new TextDecoder().decode(tar);
    expect(text.slice(0, 6)).toBe("./app/");
    expect(text.slice(512, 512 + 17)).toBe("./app/iwci-job.sh");
    expect(text.slice(257, 262)).toBe("ustar");
    expect(text.slice(1024, 1032)).toBe("echo hi\n");
    expect(tar.length % 512).toBe(0);
  });
});

describe("ciStart", () => {
  it("makes an app, tags it, releases a slug holding only the script and runs one dyno", async () => {
    happyRoutes();
    const handle = await client().ciStart!(spec);
    expect(handle).toEqual({
      id: APP,
      region: "us",
      label: `heroku dyno run.1 on ${APP}`,
      data: { app: APP, dyno: "dyno-1" },
    });
    const sent = calls.map((c) => `${c.method} ${c.path}`);
    expect(sent).toEqual([
      `GET /apps/${APP}`,
      "POST /apps",
      `PATCH /apps/${APP}/config-vars`,
      `POST /apps/${APP}/slugs`,
      "PUT s3-external-1.amazonaws.com/herokuslugs/heroku.com/v1/slug-1",
      `POST /apps/${APP}/releases`,
      `POST /apps/${APP}/dynos`,
    ]);
    expect(calls[1]!.body).toEqual({ name: APP, region: "us", stack: "heroku-24" });
    // The only config var is the tags, as sent: nothing secret.
    expect(calls[2]!.body).toEqual({ [CI_TAGS_VAR]: JSON.stringify(tags) });
    // The upload goes with no content type and no Heroku key.
    const put = calls[4]!;
    expect(put.headers["Authorization"]).toBeUndefined();
    expect(put.headers["Content-Type"]).toBeUndefined();
    expect(put.body).toBeInstanceOf(Uint8Array);
    expect(calls[6]!.body).toMatchObject({ command: "sh /app/iwci-job.sh", time_to_live: 1800 });
  });

  it("makes a team's app through /teams/apps when the account is limited to a team", async () => {
    happyRoutes();
    routes["POST /teams/apps"] = routes["POST /apps"]!;
    delete routes["POST /apps"];
    await client("team-1").ciStart!(spec);
    const create = calls.find((c) => c.path === "/teams/apps")!;
    expect(create.body).toEqual({ name: APP, team: "team-1", region: "us", stack: "heroku-24" });
  });

  it("returns the dyno a lost answer already started instead of running the job twice", async () => {
    routes[`GET /apps/${APP}`] = { id: "app-1", name: APP, region: { name: "eu" } };
    routes[`GET /apps/${APP}/config-vars`] = { [CI_TAGS_VAR]: JSON.stringify(tags) };
    routes[`GET /apps/${APP}/dynos`] = [{ id: "dyno-1", name: "run.1", state: "up", type: "run" }];
    const handle = await client().ciStart!(spec);
    expect(handle.data).toEqual({ app: APP, dyno: "dyno-1" });
    expect(handle.region).toBe("eu");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses an app of that name that is not this job's", async () => {
    routes[`GET /apps/${APP}`] = { id: "app-1", name: APP };
    routes[`GET /apps/${APP}/config-vars`] = { OTHER: "x" };
    await expect(client().ciStart!(spec)).rejects.toThrow(/not this CI job's/);
  });

  it("refuses an upload URL that is not Heroku's object store", async () => {
    happyRoutes();
    routes[`POST /apps/${APP}/slugs`] = reply(
      { id: "slug-1", blob: { method: "put", url: "https://169.254.169.254/latest" } },
      201,
    );
    await expect(client().ciStart!(spec)).rejects.toThrow(/unexpected slug upload URL/);
  });

  it("refuses GPUs and other kinds", async () => {
    await expect(client().ciStart!({ ...spec, gpu: "a100" })).rejects.toThrow(/no GPUs/);
    await expect(client().ciStart!({ ...spec, kind: "vm" })).rejects.toThrow(/kind `container`/);
  });
});

describe("ciStatus", () => {
  const handle = { id: APP, label: "x", data: { app: APP, dyno: "dyno-1" } };

  it("maps the dyno's state", async () => {
    routes[`GET /apps/${APP}/dynos/dyno-1`] = { state: "starting" };
    expect(await client().ciStatus!(handle)).toEqual({ state: "starting" });
    routes[`GET /apps/${APP}/dynos/dyno-1`] = { state: "up" };
    expect(await client().ciStatus!(handle)).toEqual({ state: "running" });
    routes[`GET /apps/${APP}/dynos/dyno-1`] = { state: "crashed" };
    expect(await client().ciStatus!(handle)).toMatchObject({ state: "stopped" });
  });

  it("reads an exited dyno as stopped while the app lasts, and gone after", async () => {
    routes[`GET /apps/${APP}`] = { id: "app-1", name: APP };
    expect(await client().ciStatus!(handle)).toMatchObject({ state: "stopped" });
    delete routes[`GET /apps/${APP}`];
    expect(await client().ciStatus!(handle)).toEqual({ state: "gone" });
  });
});

describe("ciTeardown", () => {
  it("deletes the app, and succeeds when it is already gone", async () => {
    routes[`DELETE /apps/${APP}`] = { id: "app-1" };
    await client().ciTeardown!({ id: APP, label: "x", data: { app: APP } });
    delete routes[`DELETE /apps/${APP}`];
    await client().ciTeardown!({ id: APP, label: "x", data: { app: APP } });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  });
});

describe("ciListTagged", () => {
  it("finds iwci- apps carrying the tag, with their tags as sent", async () => {
    routes["GET /apps"] = [
      { id: "a", name: "shop-api", created_at: "2026-11-01T00:00:00Z" },
      { id: "b", name: APP, region: { name: "eu" }, created_at: "2026-11-13T00:00:00Z" },
      { id: "c", name: "iwci-someone-elses", created_at: "2026-11-13T00:00:00Z" },
    ];
    routes[`GET /apps/${APP}/config-vars`] = { [CI_TAGS_VAR]: JSON.stringify(tags) };
    routes[`GET /apps/${APP}/dynos`] = [];
    routes["GET /apps/iwci-someone-elses/config-vars"] = { PORT: "1" };
    const found = await client().ciListTagged!("infrawrench-ci", []);
    expect(found).toEqual([
      {
        handle: { id: APP, region: "eu", label: `heroku dyno run on ${APP}`, data: { app: APP } },
        tags,
        createdAt: "2026-11-13T00:00:00Z",
        live: false,
      },
    ]);
    // The app the tag names is never read beyond its config vars.
    expect(calls.some((c) => c.path === "/apps/shop-api/config-vars")).toBe(false);
  });
});

describe("ciPreflight", () => {
  it("passes a verified account that can list its apps", async () => {
    routes["GET /account"] = { verified: true };
    routes["GET /apps"] = [];
    expect(await client().ciPreflight!("container")).toEqual({
      ok: true,
      missing: [],
      problems: [],
      region: "us",
    });
  });

  it("names an unverified account", async () => {
    routes["GET /account"] = { verified: false };
    routes["GET /apps"] = [];
    const result = await client().ciPreflight!("container");
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/not verified/);
  });
});
