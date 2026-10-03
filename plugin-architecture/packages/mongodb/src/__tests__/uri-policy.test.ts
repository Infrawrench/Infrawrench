import { describe, it, expect } from "vitest";
import { MongoClient } from "mongodb";
import { serverDriver, serverMongoConnectionStringError } from "../driver.js";
import { findServerUnsafeMongoOptions, serverMongoUriError } from "../uri-policy.js";
import { plugin } from "../plugin.js";

// The real driver parses here (no mock): the constructor neither reads files
// nor dials, and parsing through it is the point of the policy.
const optionsOf = (uri: string) => new MongoClient(uri).options;

describe("findServerUnsafeMongoOptions", () => {
  it("accepts password-based connection strings", () => {
    for (const uri of [
      "mongodb://user:pass@db.example.com:27017/app",
      "mongodb+srv://user:pass@cluster0.example.mongodb.net/?retryWrites=true&w=majority",
      "mongodb://user:pass@db.example.com/?authMechanism=SCRAM-SHA-256&authSource=admin",
      "mongodb://user:pass@db.example.com/?authMechanism=SCRAM-SHA-1",
      "mongodb://user:pass@db.example.com/?authMechanism=PLAIN&authSource=$external",
      "mongodb://db.example.com/?tls=true",
    ]) {
      expect(findServerUnsafeMongoOptions(optionsOf(uri))).toEqual([]);
    }
  });

  it.each([
    [
      "MONGODB-OIDC with a k8s environment",
      "mongodb://db.example.com/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:k8s",
      "MONGODB-OIDC",
    ],
    [
      "MONGODB-OIDC with a gcp environment",
      "mongodb://db.example.com/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:gcp,TOKEN_RESOURCE:aud",
      "MONGODB-OIDC",
    ],
    ["MONGODB-AWS", "mongodb://db.example.com/?authMechanism=MONGODB-AWS", "MONGODB-AWS"],
    [
      "MONGODB-X509",
      "mongodb://db.example.com/?authMechanism=MONGODB-X509&tls=true",
      "MONGODB-X509",
    ],
    ["GSSAPI", "mongodb://user@db.example.com/?authMechanism=GSSAPI", "GSSAPI"],
  ])("rejects %s", (_name, uri, expected) => {
    const reasons = findServerUnsafeMongoOptions(optionsOf(uri));
    expect(reasons.join(" ")).toContain(expected);
  });

  it.each(["tlsCAFile", "tlsCertificateKeyFile", "tlsCRLFile"])("rejects %s", (key) => {
    const reasons = findServerUnsafeMongoOptions(
      optionsOf(`mongodb://u:p@db.example.com/?tls=true&${key}=/etc/hostname`),
    );
    expect(reasons.join(" ")).toContain(key);
  });

  it("matches option names case-insensitively, as the driver does", () => {
    const reasons = findServerUnsafeMongoOptions(
      optionsOf("mongodb://db.example.com/?AUTHMECHANISM=MONGODB-AWS&TLSCAFILE=/x&tls=true"),
    );
    expect(reasons).toHaveLength(2);
  });
});

describe("serverMongoConnectionStringError", () => {
  it("returns null for safe and for unparseable strings", () => {
    expect(serverMongoConnectionStringError("mongodb://u:p@db.example.com/app")).toBeNull();
    expect(serverMongoConnectionStringError("not a uri")).toBeNull();
  });

  it("returns one user-facing message", () => {
    expect(
      serverMongoConnectionStringError("mongodb://db.example.com/?authMechanism=MONGODB-AWS"),
    ).toMatch(/^MongoDB connection string rejected: .*desktop app/);
  });
});

describe("serverMongoUriError (driver-free, save time)", () => {
  // Every URI here is one the real driver parses; the driver-free check must
  // refuse exactly when the driver-backed one does.
  const corpus = [
    "mongodb://u:p@db.example.com:27017/app",
    "mongodb+srv://u:p@cluster0.example.mongodb.net/?retryWrites=true&w=majority",
    "mongodb://u:p@a.example.com,b.example.com/app?replicaSet=rs0&authSource=admin",
    "mongodb://u:p@db.example.com/?authMechanism=SCRAM-SHA-256",
    "mongodb://u:p@db.example.com/?authMechanism=scram-sha-1",
    "mongodb://u:p@db.example.com/?authMechanism=PLAIN",
    "mongodb://u:p@db.example.com/?authMechanism=DEFAULT",
    "mongodb://db.example.com/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:k8s",
    "mongodb://db.example.com/?authMechanism=oidc&authMechanismProperties=ENVIRONMENT:gcp,TOKEN_RESOURCE:a",
    "mongodb://db.example.com/?authMechanism=MONGODB-AWS",
    "mongodb://db.example.com/?authmechanism=aws",
    "mongodb://db.example.com/?authMechanism=MONGODB-X509&tls=true",
    "mongodb://u@db.example.com/?authMechanism=GSSAPI",
    "mongodb://u:p@db.example.com/?tls=true&tlsCAFile=/etc/hostname",
    "mongodb://u:p@db.example.com/?tls=true&TLSCERTIFICATEKEYFILE=/k",
    "mongodb://u:p@db.example.com/?tls=true&tlsCRLFile=%2Fetc%2Fhostname",
  ];

  it.each(corpus)("agrees with the driver's own parse: %s", (uri) => {
    expect(serverMongoUriError(uri) === null).toBe(serverMongoConnectionStringError(uri) === null);
  });

  it("refuses a repeated authMechanism when any value is unsafe", () => {
    expect(
      serverMongoUriError("mongodb://u:p@h/?authMechanism=SCRAM-SHA-256&authMechanism=MONGODB-AWS"),
    ).toContain("MONGODB-AWS");
  });

  it("refuses a mechanism it does not recognise", () => {
    expect(serverMongoUriError("mongodb://u:p@h/?authMechanism=NEW-THING")).toContain("NEW-THING");
  });

  it("backs plugin.validateServerCredentials", () => {
    expect(plugin.validateServerCredentials?.({ connectionString: corpus[0]! })).toBeNull();
    expect(plugin.validateServerCredentials?.({})).toBeNull();
    expect(
      plugin.validateServerCredentials?.({
        connectionString: "mongodb://db.example.com/?authMechanism=MONGODB-AWS",
      }),
    ).toMatch(/^MongoDB connection string rejected: .*MONGODB-AWS/);
  });
});

describe("mongodb serverDriver", () => {
  it("reports seed and SRV destinations to the server egress guard", () => {
    expect(serverDriver.dialTargets("mongodb://u:p@a.example.com,b.example.com:27018/app")).toEqual(
      [
        { kind: "host", host: "a.example.com", port: 27017 },
        { kind: "host", host: "b.example.com", port: 27018 },
      ],
    );
    expect(serverDriver.dialTargets("mongodb+srv://u:p@cluster0.example.net/app")).toEqual([
      { kind: "srv", name: "_mongodb._tcp.cluster0.example.net" },
    ]);
  });

  it("rejects unsafe options before reporting dial targets", () => {
    expect(() =>
      serverDriver.dialTargets("mongodb://db.example.com/?authMechanism=MONGODB-AWS"),
    ).toThrow(/MONGODB-AWS/);
    expect(() =>
      serverDriver.dialTargets("mongodb://db.example.com/?tls=true&tlsCAFile=/etc/hostname"),
    ).toThrow(/tlsCAFile/);
  });

  it("refuses an unsafe connection string before connecting", async () => {
    await expect(
      serverDriver.command(
        "mongodb://db.example.com/?authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:k8s",
        "listCollections",
        ["app"],
      ),
    ).rejects.toThrow(/MONGODB-OIDC/);
  });
});
