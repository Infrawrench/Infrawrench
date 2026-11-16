import { describe, expect, it } from "vitest";
import type { CiLentValue } from "@infrawrench/plugin-base";

import {
  GKE_TOKEN_SCOPE,
  gkeCiToken,
  lendGcpToken,
  tokenFromGenerate,
  type GcpLendDeps,
} from "../ci-credential.js";

const text = (value: CiLentValue) =>
  typeof value === "string" ? value : value.map((p) => ("text" in p ? p.text : p.secret)).join("");
const secrets = (value: CiLentValue) =>
  typeof value === "string" ? [value] : value.flatMap((p) => ("secret" in p ? [p.secret] : []));

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function deps(generate?: GcpLendDeps["generate"]): GcpLendDeps & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    exchange: async () => ({ token: "exchanged-token", expiresAt: inHours(1) }),
    generate: async (bearer, seconds) => {
      asked.push(seconds);
      expect(bearer).toBe("exchanged-token");
      if (!generate) throw new Error("403 PERMISSION_DENIED");
      return generate(bearer, seconds);
    },
  };
}

describe("lendGcpToken", () => {
  it("lends a token, never the key, where gcloud and Terraform read it", async () => {
    const d = deps();
    const material = await lendGcpToken(d, "acme-prod", { alias: "gcp-prod", ttlSeconds: 1800 });
    // An hour covers it: no second call.
    expect(d.asked).toEqual([]);
    expect(text(material.env["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"]!)).toBe(
      "/root/.config/gcloud/gcp-prod.token",
    );
    expect(secrets(material.env["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE"]!)).toEqual([]);
    expect(material.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe("exchanged-token");
    expect(text(material.env["CLOUDSDK_CORE_PROJECT"]!)).toBe("acme-prod");
    expect(text(material.env["GOOGLE_CLOUD_PROJECT"]!)).toBe("acme-prod");
    expect(material.files).toEqual([
      { path: "/root/.config/gcloud/gcp-prod.token", mode: "600", content: "exchanged-token" },
    ]);
    expect(material.summary).toMatch(/^an access token for the service account, (59|60) minutes$/);
  });

  it("asks for the run's length where the account and organization allow it", async () => {
    const d = deps(async (_bearer, seconds) => ({
      token: "long-token",
      expiresAt: inHours(seconds / 3600),
    }));
    const material = await lendGcpToken(d, "p", { alias: "a", ttlSeconds: 4 * 3600 });
    expect(d.asked).toEqual([14_400]);
    expect(material.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe("long-token");
    expect(material.files[0]!.content).toBe("long-token");
    expect(material.summary).toMatch(/, (239|240) minutes$/);
  });

  it("keeps the hour when a longer token is refused, and asks for at most 12 hours", async () => {
    const d = deps();
    const material = await lendGcpToken(d, "p", { alias: "a", ttlSeconds: 48 * 3600 });
    expect(d.asked).toEqual([43_200]);
    expect(material.env["GOOGLE_OAUTH_ACCESS_TOKEN"]).toBe("exchanged-token");
  });

  it("fails when the key cannot be exchanged", async () => {
    await expect(
      lendGcpToken(
        {
          exchange: async () => {
            throw new Error("GCP auth error 400: invalid_grant");
          },
          generate: async () => ({ token: "x", expiresAt: inHours(1) }),
        },
        "p",
        { alias: "a", ttlSeconds: 600 },
      ),
    ).rejects.toThrow("invalid_grant");
  });
});

describe("tokenFromGenerate", () => {
  it("reads generateAccessToken's answer", () => {
    expect(tokenFromGenerate({ accessToken: "t", expireTime: "2026-11-15T20:00:00Z" })).toEqual({
      token: "t",
      expiresAt: "2026-11-15T20:00:00Z",
    });
    expect(() => tokenFromGenerate({ error: {} })).toThrow("without a token");
  });
});

describe("gkeCiToken", () => {
  const scoped = (scope: string) => ({ token: `scoped:${scope}`, expiresAt: inHours(1) });

  it("mints a token with only the scope GKE needs, as long as allowed", async () => {
    const asked: Array<{ bearer: string; seconds: number; scopes: readonly string[] }> = [];
    const token = await gkeCiToken(
      {
        exchange: async () => ({ token: "fresh-cloud-platform", expiresAt: inHours(1) }),
        generate: async (bearer, seconds, scopes) => {
          asked.push({ bearer, seconds, scopes });
          return { token: "narrow-long", expiresAt: inHours(seconds / 3600) };
        },
        exchangeScoped: async (scope) => scoped(scope),
      },
      7 * 3600,
    );
    expect(token.token).toBe("narrow-long");
    expect(asked).toEqual([
      { bearer: "fresh-cloud-platform", seconds: 7 * 3600, scopes: [GKE_TOKEN_SCOPE] },
    ]);
    expect(GKE_TOKEN_SCOPE).toBe("https://www.googleapis.com/auth/userinfo.email");
  });

  it("takes an hour where longer is refused, and a scoped exchange where minting is", async () => {
    const lifetimes: number[] = [];
    const hour = await gkeCiToken(
      {
        exchange: async () => ({ token: "fresh", expiresAt: inHours(1) }),
        generate: async (_b, seconds) => {
          lifetimes.push(seconds);
          if (seconds > 3600)
            throw new Error("constraints/iam.allowServiceAccountCredentialLifetimeExtension");
          return { token: "narrow-hour", expiresAt: inHours(1) };
        },
        exchangeScoped: async (scope) => scoped(scope),
      },
      7 * 3600,
    );
    expect(hour.token).toBe("narrow-hour");
    expect(lifetimes).toEqual([7 * 3600, 3600]);
    const exchanged = await gkeCiToken(
      {
        exchange: async () => ({ token: "fresh", expiresAt: inHours(1) }),
        generate: async () => {
          throw new Error("403 iam.serviceAccounts.getAccessToken");
        },
        exchangeScoped: async (scope) => scoped(scope),
      },
      7 * 3600,
    );
    expect(exchanged.token).toBe(`scoped:${GKE_TOKEN_SCOPE}`);
  });
});

describe("a GKE cluster's CI kubeconfig", () => {
  it("carries a token minted for it, never the cached one about to expire", async () => {
    const { resolveOutput } = await import("../resolve-output-client.js");
    const ctx = {
      project: "acme",
      // The gateway's cached token, with a minute left.
      token: async () => "cached-cloud-platform-token-60s-left",
      gkeCiToken: async () => ({ token: "minted-for-ci", expiresAt: inHours(7) }),
      getResource: async () => ({ externalId: "prod", fields: { location: "us-east4" } }),
      get: async () => ({
        name: "prod",
        endpoint: "203.0.113.9",
        masterAuth: { clusterCaCertificate: "Q0E=" },
      }),
    } as never;
    const ci = await resolveOutput(ctx, "gke-cluster", "r1", "ciKubeconfig", "acc");
    expect(ci).toContain("token: minted-for-ci");
    expect(ci).not.toContain("cached-cloud-platform");
    // The peer tabs keep reading the shared one.
    const tabs = await resolveOutput(ctx, "gke-cluster", "r1", "kubeconfig", "acc");
    expect(tabs).toContain("token: cached-cloud-platform-token-60s-left");
  });
});
