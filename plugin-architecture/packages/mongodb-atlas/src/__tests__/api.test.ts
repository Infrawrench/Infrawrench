import { beforeEach, describe, expect, it } from "vitest";
import {
  AtlasApiError,
  atlasRequest,
  authFromCredentials,
  digestAuthorization,
  listAll,
  parseDigestChallenge,
  resetAuthCaches,
} from "../api.js";
import { md5Hex } from "../md5.js";
import { plugin } from "../plugin.js";
import { ctxWith, makeHttp, reply } from "./helpers.js";

beforeEach(() => resetAuthCaches());

describe("md5", () => {
  it("matches the RFC 1321 test suite", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(
      md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
    ).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });
});

describe("auth", () => {
  it("picks service account auth from the mdb_sa_id_ prefix, API key otherwise", () => {
    expect(authFromCredentials({ clientId: "mdb_sa_id_abc", clientSecret: "s" }).kind).toBe(
      "service-account",
    );
    expect(authFromCredentials({ clientId: "abcdefgh", clientSecret: "uuid" }).kind).toBe(
      "api-key",
    );
    expect(() => authFromCredentials({ clientId: "", clientSecret: "" })).toThrow();
  });

  it("computes the RFC 2617 digest example response", () => {
    const challenge = parseDigestChallenge(
      'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    )!;
    const header = digestAuthorization(
      challenge,
      "Mufasa",
      "Circle Of Life",
      "GET",
      "/dir/index.html",
      "0a4f113b",
    );
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain("nc=00000001");
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it("sends a bearer token and the endpoint's versioned media type", async () => {
    const { http, calls } = makeHttp(() => ({ ok: true }));
    await atlasRequest(ctxWith(http), "GET", "/api/atlas/v2/orgs", { version: "2024-08-05" });
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(calls[0]!.headers["Accept"]).toBe("application/vnd.atlas.2024-08-05+json");
  });

  it("answers a digest challenge and reuses it with an incremented nonce count", async () => {
    let n = 0;
    const { http, calls } = makeHttp((call) => {
      n++;
      if (!call.headers["Authorization"]) {
        return reply({
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Digest realm="MMS Public API", nonce="abc", algorithm=MD5, qop="auth"',
          },
          body: { error: 401 },
        });
      }
      return { n };
    });
    const ctx = {
      auth: { kind: "api-key" as const, publicKey: "pub", privateKey: "priv" },
      baseUrl: "https://cloud.mongodb.com",
      http,
    };
    await atlasRequest(ctx, "GET", "/api/atlas/v2/orgs");
    await atlasRequest(ctx, "GET", "/api/atlas/v2/groups");
    expect(calls).toHaveLength(3);
    expect(calls[1]!.headers["Authorization"]).toContain("nc=00000001");
    expect(calls[2]!.headers["Authorization"]).toContain("nc=00000002");
    expect(calls[2]!.headers["Authorization"]).toContain('uri="/api/atlas/v2/groups"');
  });

  it("throws AtlasApiError with the status and errorCode", async () => {
    const { http } = makeHttp(() =>
      reply({ status: 403, body: { errorCode: "USER_UNAUTHORIZED", detail: "nope" } }),
    );
    const err = (await atlasRequest(ctxWith(http), "GET", "/api/atlas/v2/orgs").catch(
      (e: unknown) => e,
    )) as AtlasApiError;
    expect(err).toBeInstanceOf(AtlasApiError);
    expect(err.status).toBe(403);
    expect(err.errorCode).toBe("USER_UNAUTHORIZED");
  });

  it("pages until a short page", async () => {
    const { http, calls } = makeHttp((call) => {
      const page = Number(new URL(call.url).searchParams.get("pageNum"));
      return { results: page === 1 ? Array.from({ length: 500 }, (_, i) => i) : [1, 2] };
    });
    const all = await listAll<number>(ctxWith(http), "/api/atlas/v2/orgs/o/groups");
    expect(all).toHaveLength(502);
    expect(calls).toHaveLength(2);
  });
});

describe("organization picker", () => {
  it("lists organizations for the credential", async () => {
    const { http } = makeHttp(() => ({
      results: [
        { id: "b", name: "Beta" },
        { id: "a", name: "Alpha" },
        { id: "d", name: "Gone", isDeleted: true },
      ],
    }));
    const options = await plugin.listCredentialOptions!(
      "orgId",
      { clientId: "mdb_sa_id_1", clientSecret: "s" },
      { http },
    );
    expect(options).toEqual([
      { id: "a", label: "Alpha", description: "a" },
      { id: "b", label: "Beta", description: "b" },
    ]);
  });

  it("explains a rejected credential", async () => {
    const { http } = makeHttp(() => reply({ status: 401, body: {} }));
    await expect(
      plugin.listCredentialOptions!("orgId", { clientId: "abc", clientSecret: "s" }, { http }),
    ).rejects.toThrow(/rejected the credential/);
  });
});
