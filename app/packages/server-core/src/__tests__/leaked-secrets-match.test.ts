import { beforeAll, describe, expect, it } from "vitest";
import { leakedSecretHint, leakSeverity, openLeaksForAccount } from "@infrawrench/client-core";
import {
  fingerprintableFields,
  indexTokenFormats,
  matchLeak,
  resolveTokenOwner,
  type StoredSecretIndex,
} from "../leaked-secrets/match";
import { formatLeakAlert } from "../leaked-secrets/alerts";

const plugin = (
  id: string,
  formats: unknown[],
  fields: Array<[string, boolean]> = [["token", true]],
) => ({
  manifest: {
    id,
    displayName: id.toUpperCase(),
    credentialFields: fields.map(([key, sensitive]) => ({ key, label: key, sensitive })),
    tokenFormats: formats as never,
  },
});

const formats = indexTokenFormats([
  plugin("acme", [
    {
      id: "pat",
      label: "Acme token",
      scannerTypes: ["acme_pat", "Acme Token"],
      prefixes: ["acme_"],
    },
  ]),
  plugin("acmeplus", [
    { id: "key", label: "Acme Plus key", scannerTypes: [], prefixes: ["acme_plus_"] },
  ]),
  plugin(
    "cloud",
    [
      {
        id: "key",
        label: "Cloud key",
        scannerTypes: ["cloud_key_id"],
        credentialFields: ["keyId"],
      },
    ],
    [
      ["keyId", false],
      ["secret", true],
    ],
  ),
]);

describe("resolveTokenOwner", () => {
  it("matches scanner identifiers case-insensitively, across scanners", () => {
    expect(resolveTokenOwner(formats, "ACME_PAT")?.pluginId).toBe("acme");
    expect(resolveTokenOwner(formats, "acme token")?.pluginId).toBe("acme");
  });

  it("falls back to the raw value's prefix, longest first", () => {
    expect(resolveTokenOwner(formats, "generic", "acme_plus_...x")?.pluginId).toBe("acmeplus");
    expect(resolveTokenOwner(formats, "generic", "acme_...x")?.pluginId).toBe("acme");
    expect(resolveTokenOwner(formats, "generic", "other")).toBeNull();
    expect(resolveTokenOwner(formats, "generic")).toBeNull();
  });
});

describe("fingerprintableFields", () => {
  it("covers sensitive fields plus the ones a format names", () => {
    expect(
      fingerprintableFields(
        plugin(
          "cloud",
          [{ id: "k", label: "k", scannerTypes: ["x"], credentialFields: ["keyId"] }],
          [
            ["keyId", false],
            ["secret", true],
            ["region", false],
          ],
        ).manifest,
      ).sort(),
    ).toEqual(["keyId", "secret"]);
  });
});

describe("matchLeak", () => {
  const index: StoredSecretIndex = new Map([
    ["fp-account", [{ kind: "account", accountId: "a1", pluginId: "acme", fieldKey: "token" }]],
    [
      "fp-shared",
      [
        {
          kind: "secret-field",
          accountId: "a2",
          pluginId: "pg",
          resourceId: "r1",
          resourceTypeId: "db",
          fieldKey: "password",
        },
        {
          kind: "output",
          accountId: "a3",
          pluginId: "neon",
          resourceId: "src",
          resourceTypeId: "role",
          fieldKey: "password",
        },
      ],
    ],
  ]);
  const accounts = new Map([
    ["acme", ["a1"]],
    ["cloud", ["c1", "c2"]],
  ]);
  const acme = resolveTokenOwner(formats, "acme_pat");
  const cloud = resolveTokenOwner(formats, "cloud_key_id");

  it("matches a fingerprint byte-for-byte to an account", () => {
    expect(
      matchLeak({ fingerprint: "fp-account", index, owner: acme, accountsByPlugin: accounts }),
    ).toMatchObject({
      matchKind: "account",
      matchConfidence: "fingerprint",
      matchedAccountId: "a1",
      matchedFieldKey: "token",
    });
  });

  it("prefers the reissuable output over a literal copy of the same value", () => {
    expect(
      matchLeak({ fingerprint: "fp-shared", index, owner: null, accountsByPlugin: accounts }),
    ).toMatchObject({
      matchKind: "output",
      matchedResourceId: "src",
      matchedAccountId: "a3",
    });
  });

  it("offers no candidates when the value is known and matches nothing Infrawrench holds", () => {
    expect(
      matchLeak({ fingerprint: "fp-unknown", index, owner: acme, accountsByPlugin: accounts }),
    ).toMatchObject({
      matchKind: "none",
      matchConfidence: "none",
      candidateAccountIds: [],
    });
  });

  it("falls back to token type when the scanner withholds the value", () => {
    expect(
      matchLeak({ fingerprint: null, index, owner: acme, accountsByPlugin: accounts }),
    ).toMatchObject({
      matchKind: "account",
      matchConfidence: "token-type",
      matchedAccountId: "a1",
    });
    expect(
      matchLeak({ fingerprint: null, index, owner: cloud, accountsByPlugin: accounts }),
    ).toMatchObject({
      matchKind: "none",
      matchConfidence: "token-type",
      candidateAccountIds: ["c1", "c2"],
    });
    expect(
      matchLeak({ fingerprint: null, index, owner: null, accountsByPlugin: accounts }).matchKind,
    ).toBe("none");
  });
});

describe("shared leak helpers", () => {
  it("keeps at most four characters each end, and nothing of a short value", () => {
    expect(leakedSecretHint("abcd0123456789wxyz")).toBe("abcd…wxyz");
    expect(leakedSecretHint("short")).toBeNull();
  });

  it("rates a dead, unmatched token below critical", () => {
    expect(leakSeverity({ validity: "inactive", matchKind: "none" })).toBe("high");
    expect(leakSeverity({ validity: "inactive", matchKind: "account" })).toBe("critical");
    expect(leakSeverity({ validity: null, matchKind: "none" })).toBe("critical");
  });

  it("finds an account's open leaks, candidates included", () => {
    const base = { status: "open", matchedAccountId: null, candidateAccountIds: [] as string[] };
    const leaks = [
      { ...base, id: "1", matchedAccountId: "a" },
      { ...base, id: "2", candidateAccountIds: ["a", "b"] },
      { ...base, id: "3", status: "rotated", matchedAccountId: "a" },
    ] as never[];
    expect(openLeaksForAccount(leaks, "a").map((l: { id: string }) => l.id)).toEqual(["1", "2"]);
  });

  it("summarises a batch without the secret", () => {
    const leak = {
      tokenTypeLabel: "Acme token",
      repository: "o/r",
      path: ".env",
      line: 2,
      scannerAccountName: "GitHub",
      matchKind: "account",
      matchConfidence: "fingerprint",
      matchedAccountName: "Acme prod",
      matchedResourceName: null,
      secretHint: "acme…wxyz",
    } as never;
    const one = formatLeakAlert([leak]);
    expect(one.title).toBe("Leaked credential: Acme token");
    expect(one.body).toContain("o/r: .env:2 (account Acme prod)");
    expect(one.body).not.toContain("acme…wxyz");
    expect(formatLeakAlert([leak, leak]).title).toBe("2 leaked credentials found");
  });
});

describe("bundled token formats", () => {
  let registry: typeof import("../plugin-registry");
  beforeAll(async () => {
    registry = await import("../plugin-registry");
  }, 120_000);

  it("never let two plugins claim the same scanner identifier or prefix", () => {
    const types = new Map<string, string>();
    const prefixes = new Map<string, string>();
    const clashes: string[] = [];
    for (const p of registry.BUNDLED_PLUGINS) {
      for (const f of p.manifest.tokenFormats ?? []) {
        for (const t of f.scannerTypes) {
          const key = t.toLowerCase();
          const prior = types.get(key);
          if (prior && prior !== p.manifest.id) clashes.push(`${t}: ${prior} and ${p.manifest.id}`);
          types.set(key, p.manifest.id);
        }
        for (const pre of f.prefixes ?? []) {
          const prior = prefixes.get(pre);
          if (prior && prior !== p.manifest.id)
            clashes.push(`${pre}: ${prior} and ${p.manifest.id}`);
          prefixes.set(pre, p.manifest.id);
        }
      }
    }
    expect(clashes).toEqual([]);
    // The two scanners ship, and both own their own tokens.
    expect(types.get("github_personal_access_token")).toBe("github");
    expect(types.get("gitlab_personal_access_token")).toBe("gitlab");
  });
});
