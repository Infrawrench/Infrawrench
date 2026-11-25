/**
 * Key parsing against what the real `ssh-keygen` writes and prints.
 */
import { execFile } from "node:child_process";
import { verify } from "node:crypto";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fingerprintSha256,
  KeyFormatError,
  loadHostKey,
  parseAuthorizedKey,
  parseOpenSshPrivateKey,
} from "../src/index";
import { decodePublicKey } from "../src/keys/public";
import { verifySignature } from "../src/keys/verify";
import { WireReader, WireWriter } from "../src/wire";
import {
  createWorkspace,
  generateKey,
  MISSING_TOOLS,
  type KeyPair,
  type Workspace,
} from "./support";

const run = promisify(execFile);

describe.skipIf(MISSING_TOOLS.length > 0)("keys", () => {
  let workspace: Workspace;
  const keys: Record<string, KeyPair> = {};

  beforeAll(async () => {
    workspace = await createWorkspace();
    keys.ed25519 = await generateKey(workspace, "ed25519", "ed25519");
    keys.ecdsa256 = await generateKey(workspace, "ecdsa256", "ecdsa", 256);
    keys.ecdsa384 = await generateKey(workspace, "ecdsa384", "ecdsa", 384);
    keys.ecdsa521 = await generateKey(workspace, "ecdsa521", "ecdsa", 521);
    keys.rsa2048 = await generateKey(workspace, "rsa2048", "rsa", 2048);
    keys.rsa4096 = await generateKey(workspace, "rsa4096", "rsa", 4096);
  }, 60_000);

  afterAll(() => workspace.cleanup());

  describe("parseAuthorizedKey", () => {
    it.each([
      ["ed25519", "ssh-ed25519"],
      ["ecdsa256", "ecdsa-sha2-nistp256"],
      ["ecdsa384", "ecdsa-sha2-nistp384"],
      ["ecdsa521", "ecdsa-sha2-nistp521"],
      ["rsa2048", "ssh-rsa"],
      ["rsa4096", "ssh-rsa"],
    ])("reads a %s key and prints the fingerprint ssh-keygen prints", async (name, algorithm) => {
      const key = keys[name]!;
      const parsed = (await parseAuthorizedKey(key.publicLine))!;
      expect(parsed.algorithm).toBe(algorithm);
      expect(parsed.comment).toBe(`${name}@test`);
      expect(Buffer.from(parsed.blob).toString("base64")).toBe(key.publicLine.split(" ")[1]);

      const { stdout } = await run("ssh-keygen", ["-l", "-E", "sha256", "-f", `${key.path}.pub`]);
      expect(parsed.fingerprint).toBe(stdout.split(" ")[1]);
      expect(await fingerprintSha256(parsed.blob)).toBe(parsed.fingerprint);
    });

    it("takes a line without a comment, with a long one, and with stray whitespace", async () => {
      const [type, blob] = keys.ed25519!.publicLine.split(" ");
      expect((await parseAuthorizedKey(`${type} ${blob}`))?.comment).toBe("");
      expect(
        (await parseAuthorizedKey(`  ${type}\t${blob}   my laptop (2026) \r\n`))?.comment,
      ).toBe("my laptop (2026)");
    });

    it("refuses anything that is not one supported key", async () => {
      const [type, blob] = keys.ed25519!.publicLine.split(" ") as [string, string];
      const rsaBlob = keys.rsa2048!.publicLine.split(" ")[1]!;
      const weak = await generateKeyLine(workspace, "weak", ["-t", "rsa", "-b", "1024"]);
      const refused = [
        "",
        "ssh-ed25519",
        "not a key at all",
        // The type in front names a different key than the blob holds.
        `ssh-rsa ${blob}`,
        `ssh-ed25519 ${rsaBlob}`,
        `${type} ${blob.slice(0, -4)}`,
        `${type} ${blob}!!`,
        `${type} ${blob}\n${type} ${blob}`,
        // authorized_keys options are not accepted.
        `command="/bin/sh" ${type} ${blob}`,
        `no-pty ${type} ${blob}`,
        // Types this server does not take.
        "ssh-dss AAAAB3NzaC1kc3MAAACBAJ",
        "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t",
        weak,
        `${type} ${"A".repeat(9000)}`,
      ];
      for (const line of refused) expect(await parseAuthorizedKey(line), line).toBeNull();
    });

    it("refuses an EC point that is not on its curve", async () => {
      const blob = keys.ecdsa256!.publicKey.blob.slice();
      blob[blob.length - 1]! ^= 0x01;
      const line = `ecdsa-sha2-nistp256 ${Buffer.from(blob).toString("base64")}`;
      // Well-formed, so it decodes; WebCrypto is what rejects the point.
      expect(decodePublicKey(blob)).not.toBeNull();
      expect(await parseAuthorizedKey(line)).toBeNull();
    });

    it("refuses a key blob with trailing bytes or the wrong curve name", () => {
      const blob = keys.ed25519!.publicKey.blob;
      expect(decodePublicKey(Uint8Array.from([...blob, 0]))).toBeNull();
      const point = new WireReader(keys.ecdsa256!.publicKey.blob);
      point.string();
      point.string();
      const mislabelled = new WireWriter()
        .string("ecdsa-sha2-nistp256")
        .string("nistp384")
        .string(point.string())
        .finish();
      expect(decodePublicKey(mislabelled)).toBeNull();
    });
  });

  describe("verifySignature", () => {
    it("never throws on malformed signatures", async () => {
      const data = new Uint8Array(32);
      for (const name of ["ed25519", "ecdsa256", "rsa2048"]) {
        const key = decodePublicKey(keys[name]!.publicKey.blob)!;
        const algorithm = key.type === "ssh-rsa" ? "rsa-sha2-256" : key.type;
        const blobs = [
          new Uint8Array(0),
          Uint8Array.of(0, 0, 0, 1),
          new WireWriter().string(algorithm).string(new Uint8Array(0)).finish(),
          new WireWriter().string(algorithm).string(new Uint8Array(2000)).finish(),
          new WireWriter().string(algorithm).string(new Uint8Array(64)).byte(0).finish(),
          new WireWriter().string("ssh-dss").string(new Uint8Array(40)).finish(),
        ];
        for (const blob of blobs) {
          expect(await verifySignature(key, algorithm, blob, data)).toBe(false);
        }
      }
    });
  });

  describe("host keys", () => {
    it("reads an OpenSSH ed25519 private key", async () => {
      const key = keys.ed25519!;
      const parsed = await parseOpenSshPrivateKey(key.privateKey);
      expect(parsed.comment).toBe("ed25519@test");
      expect(parsed.seed.length).toBe(32);
      expect(parsed.publicKey).toEqual({
        algorithm: "ssh-ed25519",
        blob: key.publicKey.blob,
        fingerprint: key.publicKey.fingerprint,
      });
      // Line endings and surrounding text do not matter, as a pasted secret may have either.
      const messy = `\n  some note\n${key.privateKey.replace(/\n/g, "\r\n")}\n`;
      expect((await parseOpenSshPrivateKey(messy)).publicKey.fingerprint).toBe(
        key.publicKey.fingerprint,
      );
    });

    it("signs with the key the file holds", async () => {
      const key = keys.ed25519!;
      const hostKey = await loadHostKey(key.privateKey);
      expect(hostKey.algorithm).toBe("ssh-ed25519");
      expect(hostKey.publicKey.fingerprint).toBe(key.publicKey.fingerprint);

      const data = new TextEncoder().encode("exchange hash");
      const signature = new WireReader(await hostKey.sign(data));
      expect(signature.text()).toBe("ssh-ed25519");
      const raw = signature.string();
      signature.end();
      const { createPublicKey } = await import("node:crypto");
      const publicKey = createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: Buffer.from(key.publicKey.blob.subarray(-32)).toString("base64url"),
        },
        format: "jwk",
      });
      expect(verify(null, data, publicKey, raw)).toBe(true);
    });

    it("explains why it will not take a key", async () => {
      const encrypted = workspace.path("encrypted");
      await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "hunter2", "-f", encrypted]);
      const { readFile } = await import("node:fs/promises");
      await expect(parseOpenSshPrivateKey(await readFile(encrypted, "utf8"))).rejects.toThrow(
        /passphrase-protected/,
      );
      await expect(parseOpenSshPrivateKey(keys.rsa2048!.privateKey)).rejects.toThrow(
        "unsupported host key type ssh-rsa; only ssh-ed25519 is supported",
      );
      await expect(parseOpenSshPrivateKey(keys.ecdsa256!.privateKey)).rejects.toThrow(
        /only ssh-ed25519 is supported/,
      );
      await expect(parseOpenSshPrivateKey(keys.ed25519!.publicLine)).rejects.toThrow(
        /not an OpenSSH private key/,
      );
      await expect(
        parseOpenSshPrivateKey(
          "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
        ),
      ).rejects.toBeInstanceOf(KeyFormatError);
    });

    it("refuses a truncated or altered key without echoing any of it", async () => {
      const lines = keys.ed25519!.privateKey.trim().split("\n");
      const truncated = [lines[0], ...lines.slice(1, -2), lines.at(-1)].join("\n");
      await expect(parseOpenSshPrivateKey(truncated)).rejects.toThrow(KeyFormatError);

      // Swap in another key's private section: the halves no longer match.
      const other = await generateKey(workspace, "other", "ed25519");
      const body = (pem: string) => Buffer.from(pem.split("\n").slice(1, -2).join(""), "base64");
      const mine = body(keys.ed25519!.privateKey);
      const theirs = body(other.privateKey);
      // Everything up to the private section is the same size for two ed25519 keys.
      const publicEnd = mine.indexOf(Buffer.from("ssh-ed25519"), 40) + 11 + 4 + 32;
      const spliced = Buffer.concat([mine.subarray(0, publicEnd), theirs.subarray(publicEnd)]);
      const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${spliced.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`;
      const failure = await parseOpenSshPrivateKey(pem).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KeyFormatError);
      expect((failure as Error).message).not.toContain(spliced.toString("base64").slice(100, 120));
    });
  });
});

async function generateKeyLine(
  workspace: Workspace,
  name: string,
  args: string[],
): Promise<string> {
  const path = workspace.path(name);
  await run("ssh-keygen", ["-q", ...args, "-N", "", "-f", path]);
  const { readFile } = await import("node:fs/promises");
  return (await readFile(`${path}.pub`, "utf8")).trim();
}
