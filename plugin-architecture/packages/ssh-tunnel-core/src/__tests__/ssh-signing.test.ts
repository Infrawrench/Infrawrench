import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { utils, type ParsedKey } from "ssh2";

import {
  SSH_SIGN_ALGORITHMS,
  isSshSignAlgorithm,
  keyTypeForAlgorithm,
  signatureAlgorithmFor,
  signSshData,
} from "../ssh-signing.js";
import { generateEd25519OpenSshKeyPair } from "../openssh-keys.js";

const { parseKey } = utils;

let tmpDir: string;
const fixtures: Record<"ed" | "rsa" | "ec256", { priv: string; pub: string }> = {
  ed: { priv: "", pub: "" },
  rsa: { priv: "", pub: "" },
  ec256: { priv: "", pub: "" },
};

function keygen(type: string, file: string, extra: string[] = []): { priv: string; pub: string } {
  const p = path.join(tmpDir, file);
  execFileSync("ssh-keygen", [
    "-t",
    type,
    "-f",
    p,
    "-N",
    "",
    "-q",
    "-C",
    "test@infrawrench",
    ...extra,
  ]);
  return { priv: fs.readFileSync(p, "utf8"), pub: fs.readFileSync(`${p}.pub`, "utf8") };
}

function parsePub(pub: string): ParsedKey {
  const k = parseKey(pub);
  if (k instanceof Error) throw k;
  return Array.isArray(k) ? k[0]! : k;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-signing-test-"));
  fixtures.ed = keygen("ed25519", "ed");
  fixtures.rsa = keygen("rsa", "rsa", ["-b", "2048"]);
  fixtures.ec256 = keygen("ecdsa", "ec256", ["-b", "256"]);
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
    expect(sig[0]).toBe(0x30); // DER SEQUENCE — conversion is the agent's job
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
