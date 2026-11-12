/**
 * Keys for the agent suites, as the two files `ssh-keygen -N ""` writes: an
 * unencrypted private key in OpenSSH's own format (`openssh-key-v1`,
 * PROTOCOL.key) and its public key line. Generated with `node:crypto`, so the
 * suites need no `ssh-keygen` on the machine that runs them.
 *
 * Format: https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key
 * Key fields, in the order `sshkey_private_serialize` writes them:
 * https://github.com/openssh/openssh-portable/blob/master/sshkey.c
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

export type TestKeyType = "ed25519" | "rsa" | "ecdsa-256" | "ecdsa-384" | "ecdsa-521";

export interface OpenSshKeyFiles {
  /** The private key file (`id_<type>`). */
  priv: string;
  /** The public key file (`id_<type>.pub`). */
  pub: string;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

/** An SSH `string`: uint32 length, then the bytes. */
function str(data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  return Buffer.concat([u32(bytes.length), bytes]);
}

/** An SSH `mpint` from an unsigned big-endian JWK field (RFC 4251, section 5). */
function mpint(field: string | undefined): Buffer {
  let bytes = jwkBytes(field);
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  bytes = bytes.subarray(start);
  if (bytes.length > 0 && bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return str(bytes);
}

function jwkBytes(field: string | undefined): Buffer {
  if (!field) throw new Error("JWK field missing");
  return Buffer.from(field, "base64url");
}

/** The public key blob and the private key fields after the key type. */
function keyParts(type: TestKeyType): { name: string; pubBlob: Buffer; privFields: Buffer } {
  if (type === "ed25519") {
    const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const pub = jwkBytes(jwk.x);
    const name = "ssh-ed25519";
    return {
      name,
      pubBlob: Buffer.concat([str(name), str(pub)]),
      // The 64-byte private key OpenSSH stores is the seed followed by the public key.
      privFields: Buffer.concat([str(pub), str(Buffer.concat([jwkBytes(jwk.d), pub]))]),
    };
  }
  if (type === "rsa") {
    const jwk = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
    }).privateKey.export({ format: "jwk" });
    const name = "ssh-rsa";
    return {
      name,
      pubBlob: Buffer.concat([str(name), mpint(jwk.e), mpint(jwk.n)]),
      // n, e, d, iqmp (q^-1 mod p, which is JWK's qi), p, q.
      privFields: Buffer.concat([
        mpint(jwk.n),
        mpint(jwk.e),
        mpint(jwk.d),
        mpint(jwk.qi),
        mpint(jwk.p),
        mpint(jwk.q),
      ]),
    };
  }
  const bits = type.slice("ecdsa-".length);
  const jwk = generateKeyPairSync("ec", { namedCurve: `P-${bits}` }).privateKey.export({
    format: "jwk",
  });
  const curve = `nistp${bits}`;
  const name = `ecdsa-sha2-${curve}`;
  // The public point, uncompressed (SEC 1): 0x04, x, y, each the field's full width.
  const point = Buffer.concat([Buffer.from([4]), jwkBytes(jwk.x), jwkBytes(jwk.y)]);
  return {
    name,
    pubBlob: Buffer.concat([str(name), str(curve), str(point)]),
    privFields: Buffer.concat([str(curve), str(point), mpint(jwk.d)]),
  };
}

/** A new key of `type`, written as `ssh-keygen -t <type> -N "" -C <comment>` writes it. */
export function generateOpenSshKey(
  type: TestKeyType,
  comment = "test@infrawrench",
): OpenSshKeyFiles {
  const { name, pubBlob, privFields } = keyParts(type);
  // The check integer is written twice so a wrong passphrase can be told apart.
  const check = randomBytes(4);
  const section = Buffer.concat([check, check, str(name), privFields, str(comment)]);
  // Padded to the cipher's block size, 8 for "none", with the bytes 1, 2, 3, ...
  const padding = Buffer.from(
    Array.from({ length: (8 - (section.length % 8)) % 8 }, (_, i) => i + 1),
  );
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0"),
    str("none"), // cipher
    str("none"), // KDF
    str(""), // KDF options
    u32(1), // number of keys
    str(pubBlob),
    str(Buffer.concat([section, padding])),
  ]);
  const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
  return {
    priv: [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      ...lines,
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n"),
    pub: `${name} ${pubBlob.toString("base64")} ${comment}\n`,
  };
}
