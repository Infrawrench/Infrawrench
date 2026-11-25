/**
 * The pieces under the transport: data encoding, packet framing, exact
 * reads, and key derivation.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aes256Gcm } from "../src/cipher/aes-gcm";
import { chacha20Poly1305 } from "../src/cipher/chacha20-poly1305";
import { cleartext } from "../src/cipher/none";
import { SshError } from "../src/index";
import { deriveKey } from "../src/kex/curve25519";
import { encodeServerKexInit, negotiate, parseKexInit } from "../src/kex/negotiate";
import { ByteReader } from "../src/transport/byte-reader";
import {
  checkPacketLength,
  framePacket,
  MAX_PACKET_LENGTH,
  unframePacket,
} from "../src/transport/packet";
import { WireReader, WireWriter } from "../src/wire";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "hex"));

describe("wire encoding", () => {
  it("writes mpints as RFC 4251 section 5 shows them", () => {
    const mpint = (value: string) => hex(new WireWriter().mpint(unhex(value)).finish());
    expect(mpint("")).toBe("00000000");
    expect(mpint("00")).toBe("00000000");
    expect(mpint("09a378f9b2e332a7")).toBe("0000000809a378f9b2e332a7");
    expect(mpint("80")).toBe("000000020080");
    expect(mpint("000080")).toBe("000000020080");
    expect(mpint("7f")).toBe("000000017f");
  });

  it("reads back what it wrote", () => {
    const message = new WireWriter()
      .byte(94)
      .boolean(true)
      .uint32(0xfffffffe)
      .string("héllo")
      .nameList(["a", "b@example.com"])
      .nameList([])
      .mpint(unhex("00ff01"))
      .string(Uint8Array.of(1, 2, 3))
      .finish();
    const reader = new WireReader(message);
    expect(reader.byte()).toBe(94);
    expect(reader.boolean()).toBe(true);
    expect(reader.uint32()).toBe(0xfffffffe);
    expect(reader.text()).toBe("héllo");
    expect(reader.nameList()).toEqual(["a", "b@example.com"]);
    expect(reader.nameList()).toEqual([]);
    expect(hex(reader.mpint())).toBe("ff01");
    expect(hex(reader.string())).toBe("010203");
    reader.end();
  });

  it("refuses truncated, oversized, negative and non-text input", () => {
    expect(() => new WireReader(unhex("000000")).uint32()).toThrow(SshError);
    expect(() => new WireReader(unhex("00000005 61")).string()).toThrow("truncated message");
    expect(() => new WireReader(unhex("ffffffff 61")).string()).toThrow("truncated message");
    expect(() => new WireReader(unhex("00000001 80")).mpint()).toThrow("negative mpint");
    expect(() => new WireReader(unhex("00000002 fffe")).text()).toThrow("not valid UTF-8");
    expect(() => new WireReader(unhex("00000003 612062")).nameList()).toThrow("name-list");
    expect(() => new WireReader(unhex("00")).end()).toThrow("trailing bytes");
  });

  it("keeps text byte for byte, a leading byte order mark included", () => {
    const bytes = unhex("00000004 efbbbf61");
    const text = new WireReader(bytes).text();
    expect(hex(new WireWriter().string(text).finish())).toBe(hex(bytes));
  });
});

describe("packet framing", () => {
  it.each([
    ["cleartext", cleartext, 8, 4],
    ["AES-GCM", { blockSize: 16, lengthIsPadded: false }, 16, 0],
    ["ChaCha20-Poly1305", { blockSize: 8, lengthIsPadded: false }, 8, 0],
  ] as const)("pads every payload size correctly for %s", (_name, cipher, block, counted) => {
    for (let size = 1; size <= 300; size++) {
      const payload = randomBytes(size);
      const packet = framePacket(payload, cipher);
      const length = new DataView(packet.buffer).getUint32(0);
      const padding = packet[4]!;
      expect(length).toBe(packet.length - 4);
      expect((length + counted) % block).toBe(0);
      expect(padding).toBeGreaterThanOrEqual(4);
      expect(padding).toBeLessThan(4 + block);
      checkPacketLength(length, cipher);
      expect(hex(unframePacket(packet.subarray(4)))).toBe(hex(payload));
    }
  });

  it("joins a message header and its data without an intermediate copy", () => {
    const packet = framePacket(Uint8Array.of(94, 0, 0, 0, 1), cleartext, Uint8Array.of(7, 8, 9));
    expect(hex(unframePacket(packet.subarray(4)))).toBe("5e00000001070809");
  });

  it("refuses lengths no packet could have", () => {
    for (const length of [0, 5, MAX_PACKET_LENGTH + 4, 0xffffffff, 24, 13]) {
      expect(() => checkPacketLength(length, cleartext)).toThrow("invalid packet length");
    }
    expect(() => checkPacketLength(24, { blockSize: 16, lengthIsPadded: false })).toThrow();
    checkPacketLength(MAX_PACKET_LENGTH, { blockSize: 16, lengthIsPadded: false });
  });

  it("refuses padding that leaves no payload, or too little padding", () => {
    expect(() => unframePacket(Uint8Array.of(3, 1, 0, 0, 0))).toThrow("invalid padding length");
    expect(() => unframePacket(Uint8Array.of(4, 0, 0, 0, 0))).toThrow("invalid padding length");
    expect(() => unframePacket(Uint8Array.of(200, 1, 0, 0, 0, 0))).toThrow();
    expect(hex(unframePacket(Uint8Array.of(4, 0x15, 0, 0, 0, 0)))).toBe("15");
  });
});

describe("ByteReader", () => {
  function readerOver(chunks: Uint8Array[], fail?: Error): ByteReader {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else if (fail) controller.error(fail);
        else controller.close();
      },
    });
    return new ByteReader(stream.getReader());
  }

  it("returns exact lengths whatever the chunking", async () => {
    const data = randomBytes(10_000);
    for (const chunkSize of [1, 3, 7, 1000, 10_000]) {
      const chunks: Uint8Array[] = [];
      for (let at = 0; at < data.length; at += chunkSize) {
        chunks.push(new Uint8Array(data.subarray(at, at + chunkSize)), new Uint8Array(0));
      }
      const reader = readerOver(chunks);
      const out: Uint8Array[] = [];
      for (const size of [4, 1, 995, 4000, 5000]) out.push((await reader.read(size))!);
      expect(hex(Buffer.concat(out))).toBe(hex(data));
      expect(await reader.read(1)).toBeNull();
      expect(await reader.read(1)).toBeNull();
    }
  });

  it("tells a clean end from one in the middle of a read", async () => {
    const reader = readerOver([Uint8Array.of(1, 2, 3)]);
    expect(hex((await reader.read(2))!)).toBe("0102");
    await expect(reader.read(2)).rejects.toThrow("connection closed mid-packet");
  });

  it("reports a failing stream as a lost connection", async () => {
    const reader = readerOver([Uint8Array.of(1)], new Error("ECONNRESET"));
    await expect(reader.read(2)).rejects.toMatchObject({
      name: "SshError",
      message: "connection lost",
    });
  });
});

describe("key exchange", () => {
  it("derives keys as RFC 4253 section 7.2 defines them, extended when one hash is too short", async () => {
    const secret = unhex(`80${"11".repeat(31)}`);
    const hash = randomBytes(32);
    const sessionId = randomBytes(32);
    // K is an mpint: the high bit of the first byte means a zero byte in front.
    const k = Buffer.concat([unhex("00000021 00"), secret]);
    const sha = (...parts: Uint8Array[]) =>
      createHash("sha256").update(Buffer.concat(parts)).digest();
    const k1 = sha(k, hash, Buffer.from("C"), sessionId);
    const k2 = sha(k, hash, k1);
    const k3 = sha(k, hash, k1, k2);

    expect(hex(await deriveKey(secret, hash, sessionId, "C", 16))).toBe(hex(k1.subarray(0, 16)));
    expect(hex(await deriveKey(secret, hash, sessionId, "C", 32))).toBe(hex(k1));
    expect(hex(await deriveKey(secret, hash, sessionId, "C", 64))).toBe(
      hex(Buffer.concat([k1, k2])),
    );
    expect(hex(await deriveKey(secret, hash, sessionId, "C", 80))).toBe(
      hex(Buffer.concat([k1, k2, k3]).subarray(0, 80)),
    );
    expect((await deriveKey(secret, hash, sessionId, "A", 0)).length).toBe(0);
    expect(aes256Gcm.keyLength + aes256Gcm.ivLength).toBe(44);
    expect(chacha20Poly1305.keyLength).toBe(64);
  });

  it("offers strict key exchange in the first KEXINIT only", () => {
    const first = parseKexInit(encodeServerKexInit(["ssh-ed25519"], true));
    const later = parseKexInit(encodeServerKexInit(["ssh-ed25519"], false));
    expect(first.kex).toEqual([
      "curve25519-sha256",
      "curve25519-sha256@libssh.org",
      "kex-strict-s-v00@openssh.com",
    ]);
    expect(later.kex).toEqual(["curve25519-sha256", "curve25519-sha256@libssh.org"]);
    expect(first.cipherClientToServer).toEqual([
      "aes256-gcm@openssh.com",
      "aes128-gcm@openssh.com",
      "chacha20-poly1305@openssh.com",
    ]);
    expect(first.compressionClientToServer).toEqual(["none"]);
  });

  it("lets the client's preference decide, and names what is missing", () => {
    const client = {
      kex: ["sntrup761x25519-sha512", "curve25519-sha256@libssh.org", "curve25519-sha256"],
      hostKey: ["rsa-sha2-512", "ssh-ed25519"],
      cipherClientToServer: [
        "aes256-ctr",
        "chacha20-poly1305@openssh.com",
        "aes256-gcm@openssh.com",
      ],
      cipherServerToClient: ["aes128-gcm@openssh.com"],
      compressionClientToServer: ["zlib@openssh.com", "none"],
      compressionServerToClient: ["none"],
      firstKexPacketFollows: false,
    };
    const chosen = negotiate(client, ["ssh-ed25519"]);
    expect(chosen.kex).toBe("curve25519-sha256@libssh.org");
    expect(chosen.cipherIn.name).toBe("chacha20-poly1305@openssh.com");
    expect(chosen.cipherOut.name).toBe("aes128-gcm@openssh.com");
    expect(chosen).toMatchObject({ clientWantsStrictKex: false, clientWantsExtInfo: false });

    expect(() => negotiate({ ...client, hostKey: ["ssh-rsa"] }, ["ssh-ed25519"])).toThrow(
      "no matching host key type found",
    );
    expect(() =>
      negotiate({ ...client, kex: ["diffie-hellman-group14-sha1"] }, ["ssh-ed25519"]),
    ).toThrow("no matching key exchange method found");
    expect(() =>
      negotiate({ ...client, compressionServerToClient: ["zlib"] }, ["ssh-ed25519"]),
    ).toThrow("no matching compression found");
    // The marker names are not key exchange methods.
    expect(() =>
      negotiate({ ...client, kex: ["kex-strict-s-v00@openssh.com", "ext-info-c"] }, [
        "ssh-ed25519",
      ]),
    ).toThrow("no matching key exchange method found");
  });
});
