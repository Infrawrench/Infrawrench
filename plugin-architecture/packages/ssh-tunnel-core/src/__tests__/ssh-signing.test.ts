import { describe, it, expect, beforeAll } from "vitest";
import { utils, type ParsedKey } from "ssh2";

import {
  SSH_SIGN_ALGORITHMS,
  isSshSignAlgorithm,
  keyTypeForAlgorithm,
  signatureAlgorithmFor,
  signSshData,
} from "../ssh-signing.js";
import { generateEd25519OpenSshKeyPair } from "../openssh-keys.js";
import { generateOpenSshKey, type OpenSshKeyFiles } from "./openssh-test-keys.js";

const { parseKey } = utils;

// Generated at runtime in the files `ssh-keygen` writes (./openssh-test-keys.ts).
const fixtures: Record<"ed" | "rsa" | "ec256", OpenSshKeyFiles> = {
  ed: { priv: "", pub: "" },
  rsa: { priv: "", pub: "" },
  ec256: { priv: "", pub: "" },
};

function parsePub(pub: string): ParsedKey {
  const k = parseKey(pub);
  if (k instanceof Error) throw k;
  return Array.isArray(k) ? k[0]! : k;
}

beforeAll(() => {
  fixtures.ed = generateOpenSshKey("ed25519");
  fixtures.rsa = generateOpenSshKey("rsa");
  fixtures.ec256 = generateOpenSshKey("ecdsa-256");
});

describe("algorithm vocabulary", () => {
  it("isSshSignAlgorithm accepts every listed algorithm and nothing else", () => {
    for (const a of SSH_SIGN_ALGORITHMS) expect(isSshSignAlgorithm(a)).toBe(true);
    expect(isSshSignAlgorithm("ssh-dss")).toBe(false);
    expect(isSshSignAlgorithm("")).toBe(false);
  });

  it("keyTypeForAlgorithm folds the rsa variants onto ssh-rsa", () => {
    expect(keyTypeForAlgorithm("rsa-sha2-256")).toBe("ssh-rsa");
    expect(keyTypeForAlgorithm("rsa-sha2-512")).toBe("ssh-rsa");
    expect(keyTypeForAlgorithm("ssh-rsa")).toBe("ssh-rsa");
    expect(keyTypeForAlgorithm("ssh-ed25519")).toBe("ssh-ed25519");
    expect(keyTypeForAlgorithm("ecdsa-sha2-nistp384")).toBe("ecdsa-sha2-nistp384");
  });

  it("signatureAlgorithmFor maps key type + negotiated hash", () => {
    expect(signatureAlgorithmFor("ssh-ed25519")).toBe("ssh-ed25519");
    expect(signatureAlgorithmFor("ssh-rsa", "sha256")).toBe("rsa-sha2-256");
    expect(signatureAlgorithmFor("ssh-rsa", "sha512")).toBe("rsa-sha2-512");
    expect(signatureAlgorithmFor("ssh-rsa")).toBe("ssh-rsa");
    expect(signatureAlgorithmFor("ecdsa-sha2-nistp256")).toBe("ecdsa-sha2-nistp256");
    expect(signatureAlgorithmFor("ssh-dss")).toBeNull();
  });
});

describe("signSshData", () => {
  it("produces a verifiable ed25519 signature", () => {
    const data = Buffer.from("userauth-request-blob");
    const sig = signSshData(fixtures.ed.priv, data, "ssh-ed25519");
    expect(parsePub(fixtures.ed.pub).verify(data, sig)).toBe(true);
  });

  it("signs with a server-generated key (the cloud key format)", async () => {
    const { publicKey, privateKey } = await generateEd25519OpenSshKeyPair("cloud-key");
    const data = Buffer.from("blob");
    const sig = signSshData(privateKey, data, "ssh-ed25519");
    expect(parsePub(publicKey).verify(data, sig)).toBe(true);
  });

  it("produces verifiable rsa-sha2 signatures", () => {
    const data = Buffer.from("blob");
    const pub = parsePub(fixtures.rsa.pub);
    expect(pub.verify(data, signSshData(fixtures.rsa.priv, data, "rsa-sha2-256"), "sha256")).toBe(
      true,
    );
    expect(pub.verify(data, signSshData(fixtures.rsa.priv, data, "rsa-sha2-512"), "sha512")).toBe(
      true,
    );
  });

  it("produces a DER ECDSA signature the public key verifies", () => {
    const data = Buffer.from("blob");
    const sig = signSshData(fixtures.ec256.priv, data, "ecdsa-sha2-nistp256");
    expect(sig[0]).toBe(0x30); // DER SEQUENCE: conversion is the agent's job
    expect(parsePub(fixtures.ec256.pub).verify(data, sig)).toBe(true);
  });

  it("rejects a key/algorithm mismatch", () => {
    expect(() => signSshData(fixtures.ed.priv, Buffer.from("x"), "rsa-sha2-256")).toThrow(
      /cannot produce/,
    );
  });

  it("rejects an unparseable key and a public-only key", () => {
    expect(() => signSshData("not a key", Buffer.from("x"), "ssh-ed25519")).toThrow(/unparseable/);
    expect(() => signSshData(fixtures.ed.pub, Buffer.from("x"), "ssh-ed25519")).toThrow(
      /No private key/,
    );
  });
});
