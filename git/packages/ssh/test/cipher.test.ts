/**
 * The ciphers against published vectors and against Node's own
 * implementations of the same primitives.
 */
import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aes128Gcm, aes256Gcm } from "../src/cipher/aes-gcm";
import { chacha20Xor, chachaKey } from "../src/cipher/chacha20";
import { chacha20Poly1305 } from "../src/cipher/chacha20-poly1305";
import { Poly1305, poly1305 } from "../src/cipher/poly1305";
import { DisconnectReason } from "../src/index";
import { framePacket } from "../src/transport/packet";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "hex"));
const sequentialKey = Uint8Array.from({ length: 32 }, (_, i) => i);

/** ChaCha20 as Node has it: a 32-bit little-endian counter followed by a 96-bit nonce. */
function nodeChaCha(key: Uint8Array, counter: number, nonce: Uint8Array, data: Uint8Array) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(counter, 0);
  iv.set(nonce, 4);
  return new Uint8Array(createCipheriv("chacha20", key, iv).update(data));
}

const le32 = (bytes: Uint8Array, at: number) => Buffer.from(bytes).readUInt32LE(at) | 0;

/** Poly1305 straight from the definition, in arbitrary-precision arithmetic. */
function referencePoly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  const le = (bytes: Uint8Array) =>
    bytes.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  const r = le(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = le(key.subarray(16, 32));
  const p = (1n << 130n) - 5n;
  let acc = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.subarray(offset, offset + 16);
    acc = ((acc + le(block) + (1n << BigInt(8 * block.length))) * r) % p;
  }
  let tag = (acc + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(tag & 0xffn);
    tag >>= 8n;
  }
  return out;
}

describe("ChaCha20", () => {
  it("produces the RFC 8439 section 2.3.2 block", () => {
    const nonce = unhex("000000090000004a00000000");
    const out = new Uint8Array(64);
    chacha20Xor(
      chachaKey(sequentialKey),
      1,
      le32(nonce, 0),
      le32(nonce, 4),
      le32(nonce, 8),
      new Uint8Array(64),
      out,
    );
    expect(hex(out)).toBe(
      "10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e" +
        "d2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e",
    );
  });

  it("encrypts the RFC 8439 section 2.4.2 message", () => {
    const nonce = unhex("000000000000004a00000000");
    const plaintext = new TextEncoder().encode(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const out = new Uint8Array(plaintext.length);
    chacha20Xor(
      chachaKey(sequentialKey),
      1,
      le32(nonce, 0),
      le32(nonce, 4),
      le32(nonce, 8),
      plaintext,
      out,
    );
    expect(hex(out.subarray(0, 16))).toBe("6e2e359a2568f98041ba0728dd0d6981");
    expect(hex(out.subarray(out.length - 2))).toBe("874d");
    expect(hex(out)).toBe(hex(nodeChaCha(sequentialKey, 1, nonce, plaintext)));
  });

  it("matches Node for every length around the block boundaries, in place too", () => {
    for (const length of [0, 1, 63, 64, 65, 127, 128, 129, 1000, 32768 + 21]) {
      const key = randomBytes(32);
      const nonce = randomBytes(12);
      const data = randomBytes(length);
      const counter = 0x7ffffff0;
      const expected = nodeChaCha(key, counter, nonce, data);
      const buffer = new Uint8Array(data);
      chacha20Xor(
        chachaKey(key),
        counter,
        le32(nonce, 0),
        le32(nonce, 4),
        le32(nonce, 8),
        buffer,
        buffer,
      );
      expect(hex(buffer)).toBe(hex(expected));
    }
  });
});

describe("Poly1305", () => {
  it("computes the RFC 8439 section 2.5.2 tag", () => {
    const key = unhex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
    const message = new TextEncoder().encode("Cryptographic Forum Research Group");
    expect(hex(poly1305(key, message))).toBe("a8061dc1305136c6c22b8baf0c0127a9");
  });

  it("agrees with the definition on the values that stress the carries", () => {
    const ones = (length: number) => new Uint8Array(length).fill(0xff);
    const cases: Array<[Uint8Array, Uint8Array]> = [
      [ones(32), ones(16)],
      [ones(32), ones(64)],
      [ones(32), ones(1)],
      [ones(32), new Uint8Array(0)],
      [new Uint8Array(32), ones(48)],
      // r = 2 and a block of 2^128 - 1: the product lands just past the modulus.
      [unhex(`02${"00".repeat(31)}`), ones(16)],
      [unhex(`${"00".repeat(16)}${"ff".repeat(16)}`), ones(33)],
    ];
    for (const [key, message] of cases) {
      expect(hex(poly1305(key, message))).toBe(hex(referencePoly1305(key, message)));
    }
  });

  it("agrees with the definition on random input of every length, however it is fed", () => {
    for (let length = 0; length <= 200; length++) {
      const key = randomBytes(32);
      const message = randomBytes(length);
      const expected = hex(referencePoly1305(key, message));
      expect(hex(poly1305(key, message))).toBe(expected);
      // The same bytes in pieces, as the packet cipher feeds header and body.
      const split = Math.floor(Math.random() * (length + 1));
      const mac = new Poly1305(key);
      mac.update(message.subarray(0, Math.min(4, split)));
      mac.update(message.subarray(Math.min(4, split), split));
      mac.update(message.subarray(split));
      expect(hex(mac.finish())).toBe(expected);
    }
    const large = randomBytes(40_000);
    const key = randomBytes(32);
    expect(hex(poly1305(key, large))).toBe(hex(referencePoly1305(key, large)));
  });
});

describe("chacha20-poly1305@openssh.com", () => {
  /** The construction from OpenSSH's PROTOCOL.chacha20poly1305, built from the reference pieces. */
  function reference(key: Uint8Array, sequence: number, packet: Uint8Array): Uint8Array {
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(sequence, 8);
    const main = key.subarray(0, 32);
    const header = key.subarray(32, 64);
    const polyKey = nodeChaCha(main, 0, nonce, new Uint8Array(32));
    const sealed = Buffer.concat([
      nodeChaCha(header, 0, nonce, packet.subarray(0, 4)),
      nodeChaCha(main, 1, nonce, packet.subarray(4)),
    ]);
    return new Uint8Array(Buffer.concat([sealed, referencePoly1305(polyKey, sealed)]));
  }

  it("seals exactly as the construction says, and opens what it sealed", async () => {
    const key = randomBytes(64);
    const seal = await chacha20Poly1305.create(key, new Uint8Array(0), "seal");
    const open = await chacha20Poly1305.create(key, new Uint8Array(0), "open");
    for (const [sequence, size] of [
      [0, 1],
      [1, 100],
      [0x01020304, 5000],
      [0xffffffff, 32768 + 9],
    ] as const) {
      const payload = randomBytes(size);
      const packet = framePacket(payload, seal);
      expect((packet.length - 4) % 8).toBe(0);
      const wire = await seal.seal(sequence, packet);
      expect(hex(wire)).toBe(hex(reference(key, sequence, packet)));

      const header = wire.subarray(0, 4);
      expect(open.readLength(sequence, header)).toBe(packet.length - 4);
      const clear = await open.open(sequence, header, wire.subarray(4));
      expect(hex(clear)).toBe(hex(packet.subarray(4)));
    }
  });

  it("refuses a packet with any bit changed, or opened under another sequence number", async () => {
    const key = randomBytes(64);
    const seal = await chacha20Poly1305.create(key, new Uint8Array(0), "seal");
    const open = await chacha20Poly1305.create(key, new Uint8Array(0), "open");
    const wire = await seal.seal(7, framePacket(randomBytes(64), seal));
    const mac = { reason: DisconnectReason.MAC_ERROR };
    for (const index of [0, 3, 4, 40, wire.length - 16, wire.length - 1]) {
      const tampered = wire.slice();
      tampered[index]! ^= 0x80;
      await expect(
        open.open(7, tampered.subarray(0, 4), tampered.subarray(4)),
      ).rejects.toMatchObject(mac);
    }
    await expect(open.open(8, wire.subarray(0, 4), wire.subarray(4))).rejects.toMatchObject(mac);
    await expect(open.open(7, wire.subarray(0, 4), wire.subarray(4))).resolves.toBeDefined();
  });
});

describe.each([
  ["aes128-gcm@openssh.com", aes128Gcm, "aes-128-gcm"],
  ["aes256-gcm@openssh.com", aes256Gcm, "aes-256-gcm"],
] as const)("%s", (_name, algorithm, nodeName) => {
  it(`is ${nodeName} with the length as associated data and a counting nonce`, async () => {
    const key = randomBytes(algorithm.keyLength);
    // A counter about to carry, to show the carry goes through the low eight bytes only.
    const iv = unhex("a1a2a3a4 00000000 0000ffff");
    const seal = await algorithm.create(key, iv, "seal");
    const open = await algorithm.create(key, iv, "open");
    expect(seal.blockSize).toBe(16);

    const nonces = [
      "a1a2a3a4000000000000ffff",
      "a1a2a3a40000000000010000",
      "a1a2a3a40000000000010001",
    ];
    for (const nonce of nonces) {
      const packet = framePacket(randomBytes(1 + Math.floor(Math.random() * 3000)), seal);
      expect((packet.length - 4) % 16).toBe(0);
      const wire = await seal.seal(0, packet);

      const node = createCipheriv(nodeName, key, unhex(nonce));
      node.setAAD(packet.subarray(0, 4));
      const expected = Buffer.concat([
        packet.subarray(0, 4),
        node.update(packet.subarray(4)),
        node.final(),
        node.getAuthTag(),
      ]);
      expect(hex(wire)).toBe(hex(expected));

      const header = wire.subarray(0, 4);
      expect(open.readLength(0, header)).toBe(packet.length - 4);
      expect(hex(await open.open(0, header, wire.subarray(4)))).toBe(hex(packet.subarray(4)));
    }
  });

  it("refuses a packet with any bit changed, the length included", async () => {
    const key = randomBytes(algorithm.keyLength);
    const iv = randomBytes(12);
    const seal = await algorithm.create(key, iv, "seal");
    const wire = await seal.seal(0, framePacket(randomBytes(100), seal));
    for (const index of [0, 3, 4, 50, wire.length - 1]) {
      // A fresh opener each time: its nonce advances with every packet, tampered or not.
      const open = await algorithm.create(key, iv, "open");
      const tampered = wire.slice();
      tampered[index]! ^= 0x01;
      await expect(
        open.open(0, tampered.subarray(0, 4), tampered.subarray(4)),
      ).rejects.toMatchObject({ reason: DisconnectReason.MAC_ERROR });
    }
  });
});
