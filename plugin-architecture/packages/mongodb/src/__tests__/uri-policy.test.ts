import { describe, it, expect } from "vitest";
import { MongoClient } from "mongodb";
import { serverDriver, serverMongoConnectionStringError } from "../driver.js";
import { findServerUnsafeMongoOptions } from "../uri-policy.js";

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

describe("mongodb serverDriver", () => {
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
