import { beforeEach, describe, expect, it } from "vitest";

import worker, { locate, type Env } from "./index.js";

const ORIGIN = "https://maven.infrawrench.com";
const DIR = "com/infrawrench/infrawrench-sdk";
const JAR = `${DIR}/1.94.0/infrawrench-sdk-1.94.0.jar`;
const METADATA = `${DIR}/maven-metadata.xml`;
const AUTH = `Basic ${btoa("ci:secret")}`;

/** Just enough of `R2Bucket` for the Worker: head, get (with onlyIf) and put. */
function fakeBucket(store: Map<string, string>): R2Bucket {
  const meta = (key: string) => ({
    size: store.get(key)?.length ?? 0,
    httpEtag: `"etag-${key}"`,
    uploaded: new Date("2026-11-06T12:00:00Z"),
    writeHttpMetadata(headers: Headers) {
      headers.set("content-type", "application/octet-stream");
    },
  });
  return {
    async head(key: string) {
      return store.has(key) ? meta(key) : null;
    },
    async get(key: string, options?: { onlyIf?: Headers }) {
      const body = store.get(key);
      if (body === undefined) return null;
      if (options?.onlyIf?.get("if-none-match") === `"etag-${key}"`) return meta(key);
      return { ...meta(key), body: new Response(body).body, text: async () => body };
    },
    async put(key: string, value: ReadableStream) {
      store.set(key, await new Response(value).text());
      return meta(key);
    },
  } as unknown as R2Bucket;
}

describe("maven repository", () => {
  let store: Map<string, string>;
  let env: Env;

  function send(path: string, init: RequestInit = {}): Promise<Response> {
    const request = new Request(`${ORIGIN}/${path}`, init);
    return worker.fetch(request as Parameters<typeof worker.fetch>[0], env) as Promise<Response>;
  }

  function put(path: string, body = "bytes", auth: string | null = AUTH): Promise<Response> {
    const headers = new Headers({ "content-length": String(body.length) });
    if (auth) headers.set("authorization", auth);
    return send(path, { method: "PUT", body, headers });
  }

  beforeEach(() => {
    store = new Map();
    env = { ARTIFACTS: fakeBucket(store), DEPLOY_USERNAME: "ci", DEPLOY_PASSWORD: "secret" };
  });

  describe("reading", () => {
    it("serves a release publicly, marked immutable", async () => {
      store.set(JAR, "jar");
      const response = await send(JAR);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("jar");
      expect(response.headers.get("cache-control")).toContain("immutable");
    });

    it("keeps metadata fresh enough to announce a new version", async () => {
      store.set(METADATA, "<metadata/>");
      const response = await send(METADATA);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    });

    it("answers HEAD without a body", async () => {
      store.set(JAR, "jar");
      const response = await send(JAR, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("3");
      expect(await response.text()).toBe("");
    });

    it("answers a matching conditional GET with 304", async () => {
      store.set(JAR, "jar");
      const response = await send(JAR, { headers: { "if-none-match": `"etag-${JAR}"` } });
      expect(response.status).toBe(304);
    });

    it("404s a missing release", async () => {
      expect((await send(JAR)).status).toBe(404);
    });

    it("never looks in the bucket for someone else's coordinates", async () => {
      const path = "org/slf4j/slf4j-api/2.0.0/slf4j-api-2.0.0.pom";
      store.set(path, "planted");
      const response = await send(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    });
  });

  describe("authenticating writes", () => {
    it("challenges an anonymous PUT with Basic, as Maven expects", async () => {
      const response = await put(JAR, "bytes", null);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Basic /);
      expect(store.size).toBe(0);
    });

    it.each([
      ["a wrong password", `Basic ${btoa("ci:wrong")}`],
      ["a wrong username", `Basic ${btoa("root:secret")}`],
      ["malformed base64", "Basic %%%"],
      ["another scheme", "Bearer secret"],
    ])("refuses %s", async (_name, auth) => {
      expect((await put(JAR, "bytes", auth)).status).toBe(401);
      expect(store.size).toBe(0);
    });

    it("locks writes when the secrets are unset, even for empty credentials", async () => {
      env = { ARTIFACTS: env.ARTIFACTS };
      expect((await put(JAR, "bytes", `Basic ${btoa(":")}`)).status).toBe(401);
      expect((await put(JAR, "bytes", `Basic ${btoa("undefined:undefined")}`)).status).toBe(401);
    });

    it("does not reveal which paths are valid to an anonymous caller", async () => {
      expect((await put("org/evil/x.html", "bytes", null)).status).toBe(401);
    });
  });

  describe("writing", () => {
    it("stores a new release file", async () => {
      expect((await put(JAR, "jar")).status).toBe(201);
      expect(store.get(JAR)).toBe("jar");
    });

    it("lets a deploy that died before its metadata be re-run", async () => {
      store.set(METADATA, "<version>1.93.0</version>");
      expect((await put(JAR, "first")).status).toBe(201);
      expect((await put(JAR, "second")).status).toBe(201);
      expect(store.get(JAR)).toBe("second");
    });

    it("refuses to change any file of a version listed in the metadata", async () => {
      store.set(METADATA, "<version>1.94.0</version>");
      store.set(JAR, "original");
      const response = await put(JAR, "tampered");
      expect(response.status).toBe(409);
      expect(store.get(JAR)).toBe("original");
      expect((await put(`${JAR}.sha1`, "tampered")).status).toBe(409);
    });

    it("does not confuse a version with one it is a prefix of", async () => {
      store.set(METADATA, "<version>1.94.01</version>");
      expect((await put(JAR, "jar")).status).toBe(201);
    });

    it("lets metadata be replaced, since each deploy adds a version to it", async () => {
      store.set(METADATA, "<version>1.93.0</version>");
      expect((await put(METADATA, "<version>1.94.0</version>")).status).toBe(201);
    });

    it("refuses a path outside the repository's layout", async () => {
      const response = await put("org/evil/evil/1.0/evil-1.0.jar");
      expect(response.status).toBe(400);
      expect(store.size).toBe(0);
    });
  });

  it("rejects other methods", async () => {
    const response = await send(JAR, { method: "DELETE", headers: { authorization: AUTH } });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PUT");
  });
});

describe("locate", () => {
  it.each([
    `/${JAR}`,
    `/${JAR}.sha1`,
    `/${JAR}.asc`,
    `/${JAR}.asc.sha256`,
    `/${DIR}/1.94.0/infrawrench-sdk-1.94.0.pom`,
    `/${DIR}/1.94.0/infrawrench-sdk-1.94.0-sources.jar`,
    `/${DIR}/1.94.0/infrawrench-sdk-1.94.0-javadoc.jar.md5`,
    `/${DIR}/1.94.0/infrawrench-sdk-1.94.0.module`,
    `/${DIR}/maven-metadata.xml`,
    `/${DIR}/maven-metadata.xml.sha512`,
  ])("accepts %s", (path) => {
    expect(locate(path)).not.toBeNull();
  });

  it.each([
    ["root", "/"],
    ["a directory", `/${DIR}/1.94.0/`],
    ["another group", "/org/slf4j/slf4j-api/2.0.0/slf4j-api-2.0.0.jar"],
    ["a group that merely starts the same", "/com/infrawrench2/a/1.0/a-1.0.jar"],
    ["HTML", `/${DIR}/1.94.0/infrawrench-sdk-1.94.0.html`],
    ["HTML with a jar-like name", `/${DIR}/1.94.0/index.html`],
    ["a file from another version", `/${DIR}/1.94.0/infrawrench-sdk-1.93.0.jar`],
    ["a file from another artifact", `/${DIR}/1.94.0/other-1.94.0.jar`],
    ["a snapshot", `/${DIR}/1.0-SNAPSHOT/infrawrench-sdk-1.0-SNAPSHOT.jar`],
    ["an encoded traversal", `/${DIR}/%2e%2e/infrawrench-sdk-1.94.0.jar`],
    ["a hidden segment", `/com/infrawrench/.a/1.0/.a-1.0.jar`],
    ["group-level metadata", "/com/infrawrench/maven-metadata.xml"],
  ])("rejects %s", (_name, path) => {
    expect(locate(path)).toBeNull();
  });
});
