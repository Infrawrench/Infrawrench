/**
 * The server against a scripted client: everything a well-behaved client
 * never does, and the exact messages around what it does.
 */
import { connect } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DisconnectReason } from "../src/index";
import { Msg, OpenFailure } from "../src/messages";
import { WireWriter } from "../src/wire";
import { Disconnected, generateUserKey, TestClient, type UserKey } from "./client";
import {
  createWorkspace,
  generateKey,
  MISSING_TOOLS,
  sleep,
  startServer,
  type ExecHandler,
  type TestServer,
  type Workspace,
} from "./support";
import { fingerprintSha256, type SshServerLimits } from "../src/index";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Set by a test to let the `gate` command start reading. */
let openGate: () => void = () => {};

const exec: ExecHandler = async (principal, command, channel, env) => {
  const [verb, argument] = command.split(" ");
  switch (verb) {
    case "whoami": {
      const out = channel.stdout.getWriter();
      await out.write(encoder.encode(principal));
      await out.close();
      return 7;
    }
    case "env": {
      const out = channel.stdout.getWriter();
      await out.write(encoder.encode(JSON.stringify([...env])));
      await out.close();
      return 0;
    }
    case "echo":
      await channel.stdin.pipeTo(channel.stdout);
      return 0;
    case "produce": {
      const out = channel.stdout.getWriter();
      const block = new Uint8Array(64 * 1024).fill(0x61);
      for (let left = Number(argument); left > 0; left -= block.length) {
        await out.write(block.subarray(0, Math.min(block.length, left)));
      }
      await out.close();
      return 0;
    }
    case "deaf": {
      // Starts to read, then gives up on its input, as a command does whose own stdin closed.
      const reader = channel.stdin.getReader();
      void reader.read().catch(() => {});
      await reader.cancel();
      await new Promise<void>((resolve, reject) => {
        openGate = resolve;
        channel.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return 5;
    }
    case "gate": {
      // Reads nothing until the test says so, then counts what the client sent.
      await new Promise<void>((resolve, reject) => {
        openGate = resolve;
        channel.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      let total = 0;
      for await (const chunk of channel.stdin) total += chunk.length;
      const out = channel.stdout.getWriter();
      await out.write(encoder.encode(String(total)));
      await out.close();
      return 0;
    }
    default:
      return 127;
  }
};

describe.skipIf(MISSING_TOOLS.length > 0)("protocol", () => {
  let workspace: Workspace;
  let hostKeyPem: string;
  let user: UserKey;
  let rsaUser: UserKey;
  let stranger: UserKey;
  let users: Map<string, string>;
  let server: TestServer;
  const clients: TestClient[] = [];
  const servers: TestServer[] = [];

  const start = async (
    limits?: SshServerLimits,
    overrides?: Parameters<typeof startServer>[0]["overrides"],
  ) => {
    const started = await startServer({
      hostKey: hostKeyPem,
      users,
      exec,
      ...(limits ? { limits } : {}),
      ...(overrides ? { overrides } : {}),
    });
    servers.push(started);
    return started;
  };

  const dial = async (options?: Parameters<typeof TestClient.connect>[1], to = server) => {
    const client = await TestClient.connect(to.port, options);
    clients.push(client);
    return client;
  };

  const session = async (options?: Parameters<typeof TestClient.connect>[1], to = server) => {
    const client = await dial(options, to);
    await client.login(user);
    return client;
  };

  beforeAll(async () => {
    workspace = await createWorkspace();
    hostKeyPem = (await generateKey(workspace, "host", "ed25519")).privateKey;
    user = generateUserKey("ed25519");
    rsaUser = generateUserKey("rsa");
    stranger = generateUserKey("ed25519");
    users = new Map([
      [await fingerprintSha256(user.blob), "alice"],
      [await fingerprintSha256(rsaUser.blob), "rsa-alice"],
    ]);
    server = await start();
  });

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  afterAll(async () => {
    for (const started of servers) await started.close();
    await workspace.cleanup();
  });

  describe("handshake", () => {
    it.each(["aes256-gcm@openssh.com", "aes128-gcm@openssh.com", "chacha20-poly1305@openssh.com"])(
      "completes with %s and advertises the signature algorithms",
      async (cipher) => {
        const client = await session({ cipher });
        expect(client.serverVersion).toBe("SSH-2.0-InfrawrenchGit");
        expect(client.serverSigAlgs).toEqual([
          "ssh-ed25519",
          "ecdsa-sha2-nistp256",
          "ecdsa-sha2-nistp384",
          "ecdsa-sha2-nistp521",
          "rsa-sha2-512",
          "rsa-sha2-256",
        ]);
      },
    );

    it("works with a client that does not know strict key exchange", async () => {
      const summary = server.nextSummary();
      const client = await session({
        strict: false,
        // Tolerated without strict mode, where they cannot shift sequence numbers unnoticed.
        beforeKexInit: [new WireWriter().byte(Msg.IGNORE).string("x").finish()],
        duringKex: [
          new WireWriter().byte(Msg.DEBUG).boolean(false).string("x").string("").finish(),
        ],
      });
      const { id } = await client.openSession();
      await client.exec(id, "whoami");
      client.close();
      expect((await summary).strictKex).toBe(false);
    });

    it("strict: refuses a KEXINIT that was not the first packet", async () => {
      const client = await dial({ manual: true });
      const failed = client.keyExchange(undefined, () =>
        client.send(new WireWriter().byte(Msg.IGNORE).string("x").finish()),
      );
      await expect(failed).rejects.toMatchObject({ reason: DisconnectReason.KEY_EXCHANGE_FAILED });
    });

    it("strict: refuses an injected message during the first key exchange", async () => {
      const connecting = dial({
        duringKex: [new WireWriter().byte(Msg.IGNORE).string("x").finish()],
      });
      await expect(connecting).rejects.toMatchObject({
        reason: DisconnectReason.KEY_EXCHANGE_FAILED,
      });
    });

    it("refuses a service request in the middle of key exchange, strict or not", async () => {
      for (const strict of [true, false]) {
        const connecting = dial({
          strict,
          duringKex: [new WireWriter().byte(Msg.SERVICE_REQUEST).string("ssh-userauth").finish()],
        });
        await expect(connecting).rejects.toBeInstanceOf(Disconnected);
      }
    });

    it("refuses a low-order ECDH point", async () => {
      const connecting = dial({ ecdhPublic: new Uint8Array(32) });
      await expect(connecting).rejects.toMatchObject({
        reason: DisconnectReason.KEY_EXCHANGE_FAILED,
      });
    });

    it("drops a wrongly guessed first key exchange packet", async () => {
      const client = await session({ wrongGuess: true });
      const { id } = await client.openSession();
      await client.exec(id, "whoami");
    });

    it("refuses a client with no cipher in common", async () => {
      const connecting = dial({ cipher: "aes256-ctr" });
      await expect(connecting).rejects.toMatchObject({
        reason: DisconnectReason.KEY_EXCHANGE_FAILED,
        message: "no matching cipher found",
      });
    });

    it.each([
      ["SSH-1.5-Ancient", DisconnectReason.PROTOCOL_VERSION_NOT_SUPPORTED],
      ["GET / HTTP/1.1", DisconnectReason.PROTOCOL_VERSION_NOT_SUPPORTED],
      ["SSH-2.0-", DisconnectReason.PROTOCOL_VERSION_NOT_SUPPORTED],
      [`SSH-2.0-${"x".repeat(300)}`, DisconnectReason.PROTOCOL_ERROR],
      ["SSH-2.0-nul\0byte", DisconnectReason.PROTOCOL_ERROR],
    ])("refuses the identification line %j", async (version, reason) => {
      const summary = server.nextSummary();
      const client = await dial({ manual: true, version });
      await client.closed();
      expect((await summary).error?.reason).toBe(reason);
    });

    it("refuses a packet longer than the limit, and one with a bad length", async () => {
      for (const length of [256 * 1024 + 4, 1, 21]) {
        const summary = server.nextSummary();
        const client = await dial({ manual: true });
        client.writeRaw(Uint8Array.of(length >>> 24, length >>> 16, length >>> 8, length));
        await client.closed();
        expect((await summary).error).toMatchObject({
          reason: DisconnectReason.PROTOCOL_ERROR,
          message: "invalid packet length",
        });
      }
    });

    it.each(["aes256-gcm@openssh.com", "chacha20-poly1305@openssh.com"])(
      "drops the connection when a packet under %s was tampered with",
      async (cipher) => {
        const summary = server.nextSummary();
        const client = await dial({ cipher });
        const wire = await client.sealPacket(
          new WireWriter().byte(Msg.SERVICE_REQUEST).string("ssh-userauth").finish(),
        );
        wire[wire.length - 20]! ^= 0x01;
        client.writeRaw(wire);
        await client.closed();
        expect((await summary).error?.reason).toBe(DisconnectReason.MAC_ERROR);
      },
    );
  });

  describe("authentication", () => {
    it("refuses RSA with SHA-1 without looking the key up", async () => {
      const client = await dial();
      await client.requestService();
      server.lookups.length = 0;
      expect(await client.publicKeyAuth(rsaUser, { algorithm: "ssh-rsa", query: true })).toBe(
        Msg.USERAUTH_FAILURE,
      );
      expect(await client.publicKeyAuth(rsaUser, { algorithm: "ssh-rsa" })).toBe(
        Msg.USERAUTH_FAILURE,
      );
      expect(server.lookups).toEqual([]);
    });

    it("refuses a SHA-1 signature passed off as rsa-sha2-256", async () => {
      const client = await dial();
      await client.requestService();
      server.lookups.length = 0;
      expect(await client.publicKeyAuth(rsaUser, { algorithm: "rsa-sha2-256", hash: "sha1" })).toBe(
        Msg.USERAUTH_FAILURE,
      );
      // And a signature blob that names a different algorithm than the request.
      expect(
        await client.publicKeyAuth(rsaUser, {
          algorithm: "rsa-sha2-512",
          hash: "sha256",
          signatureName: "rsa-sha2-256",
        }),
      ).toBe(Msg.USERAUTH_FAILURE);
      expect(server.lookups).toEqual([]);
      expect(await client.publicKeyAuth(rsaUser, { algorithm: "rsa-sha2-512" })).toBe(
        Msg.USERAUTH_SUCCESS,
      );
    });

    it("answers a query for a known key, and a signature proves it", async () => {
      const client = await dial();
      await client.requestService();
      server.lookups.length = 0;
      expect(await client.publicKeyAuth(user, { query: true })).toBe(Msg.USERAUTH_PK_OK);
      expect(await client.publicKeyAuth(stranger, { query: true })).toBe(Msg.USERAUTH_FAILURE);
      expect(await client.publicKeyAuth(user)).toBe(Msg.USERAUTH_SUCCESS);
      expect(server.lookups.map((lookup) => lookup.phase)).toEqual(["query", "query", "verified"]);
    });

    it("refuses a registered key the client cannot sign with", async () => {
      const client = await dial();
      await client.requestService();
      server.lookups.length = 0;
      // Alice's public key, a signature by someone else.
      expect(await client.publicKeyAuth(user, { signWith: stranger })).toBe(Msg.USERAUTH_FAILURE);
      // A signature made for a different session cannot be replayed.
      expect(await client.publicKeyAuth(user, { sessionId: new Uint8Array(32) })).toBe(
        Msg.USERAUTH_FAILURE,
      );
      // No lookup happens for a signature that does not verify.
      expect(server.lookups).toEqual([]);
    });

    it("refuses other methods and names the one it takes", async () => {
      const client = await dial();
      await client.requestService();
      for (const method of ["none", "password", "keyboard-interactive", "hostbased"]) {
        const request = new WireWriter()
          .byte(Msg.USERAUTH_REQUEST)
          .string("git")
          .string("ssh-connection")
          .string(method);
        if (method === "password") request.boolean(false).string("hunter2");
        await client.send(request.finish());
        const failure = await client.expect(Msg.USERAUTH_FAILURE);
        expect(failure.nameList()).toEqual(["publickey"]);
        expect(failure.boolean()).toBe(false);
      }
    });

    it("refuses a weak RSA key", async () => {
      const weak = generateUserKey("rsa", 1024);
      const lenient = await start(undefined, {
        // Even a host that would accept the key never gets to see it.
        authenticate: async () => "anyone",
      });
      const client = await dial(undefined, lenient);
      await client.requestService();
      expect(await client.publicKeyAuth(weak, { algorithm: "rsa-sha2-256" })).toBe(
        Msg.USERAUTH_FAILURE,
      );
    });

    it("disconnects after too many failures", async () => {
      const strict = await start({ maxAuthAttempts: 3 });
      const client = await dial(undefined, strict);
      await client.requestService();
      expect(await client.publicKeyAuth(stranger)).toBe(Msg.USERAUTH_FAILURE);
      expect(await client.publicKeyAuth(stranger)).toBe(Msg.USERAUTH_FAILURE);
      await expect(client.publicKeyAuth(stranger)).rejects.toMatchObject({
        message: "Too many authentication failures",
      });
    });

    it("disconnects a client that only ever asks", async () => {
      const strict = await start({ maxAuthAttempts: 2 });
      const client = await dial(undefined, strict);
      await client.requestService();
      for (let i = 0; i < 8; i++) {
        expect(await client.publicKeyAuth(user, { query: true })).toBe(Msg.USERAUTH_PK_OK);
      }
      await expect(client.publicKeyAuth(user, { query: true })).rejects.toBeInstanceOf(
        Disconnected,
      );
    });

    it("treats a lookup that throws as a refusal and tells the host", async () => {
      const broken = await start(undefined, {
        authenticate: async () => {
          throw new Error("database is down");
        },
      });
      const client = await dial(undefined, broken);
      await client.requestService();
      expect(await client.publicKeyAuth(user)).toBe(Msg.USERAUTH_FAILURE);
      expect(broken.errors).toHaveLength(1);
    });

    it("refuses channels and unknown services before authentication", async () => {
      const early = await dial();
      await early.send(
        new WireWriter()
          .byte(Msg.CHANNEL_OPEN)
          .string("session")
          .uint32(0)
          .uint32(1024)
          .uint32(1024)
          .finish(),
      );
      expect((await early.expectDisconnect()).reason).toBe(DisconnectReason.PROTOCOL_ERROR);

      const wrongService = await dial();
      await wrongService.send(
        new WireWriter().byte(Msg.SERVICE_REQUEST).string("ssh-connection").finish(),
      );
      expect((await wrongService.expectDisconnect()).reason).toBe(
        DisconnectReason.SERVICE_NOT_AVAILABLE,
      );

      const noService = await dial();
      await expect(noService.publicKeyAuth(user)).rejects.toMatchObject({
        reason: DisconnectReason.PROTOCOL_ERROR,
      });
    });

    it("gives up on a client that does not authenticate in time", async () => {
      const impatient = await start({ authTimeoutMs: 300 });
      const summary = impatient.nextSummary();
      const started = Date.now();
      // A raw socket that says nothing at all.
      const socket = connect({ port: impatient.port, host: "127.0.0.1" });
      socket.resume();
      await new Promise((resolve) => socket.on("close", resolve));
      expect(Date.now() - started).toBeLessThan(3000);
      expect((await summary).error?.message).toBe("authentication timed out");

      // And one that finishes the handshake but never logs in.
      const idle = await dial(undefined, impatient);
      expect((await idle.expectDisconnect()).message).toBe("authentication timed out");
    });
  });

  describe("sessions", () => {
    it("runs a command: data, exit status, EOF, close, in that order", async () => {
      const client = await session();
      const { id, window, maxPacket } = await client.openSession();
      expect({ window, maxPacket }).toEqual({ window: 2 * 1024 * 1024, maxPacket: 32768 });
      await client.exec(id, "whoami");

      const data = await client.expect(Msg.CHANNEL_DATA);
      expect(data.uint32()).toBe(0);
      expect(decoder.decode(data.string())).toBe("alice");

      const status = await client.expect(Msg.CHANNEL_REQUEST);
      status.uint32();
      expect(status.text()).toBe("exit-status");
      expect(status.boolean()).toBe(false);
      expect(status.uint32()).toBe(7);

      await client.expect(Msg.CHANNEL_EOF);
      await client.expect(Msg.CHANNEL_CLOSE);

      // The channel number is free again once the client has closed too.
      await client.send(new WireWriter().byte(Msg.CHANNEL_CLOSE).uint32(id).finish());
      expect((await client.openSession()).id).toBe(id);
    });

    it("collects env requests, within limits, until the command starts", async () => {
      const client = await session();
      const { id } = await client.openSession();
      const env = (name: string, value: string) =>
        client.channelRequest(
          id,
          "env",
          true,
          new WireWriter().string(name).string(value).finish(),
        );
      await env("GIT_PROTOCOL", "version=2");
      await client.expect(Msg.CHANNEL_SUCCESS);
      await env("BAD NAME", "x");
      await client.expect(Msg.CHANNEL_FAILURE);
      await env("BIG", "x".repeat(5000));
      await client.expect(Msg.CHANNEL_FAILURE);
      await client.exec(id, "env");
      const data = await client.expect(Msg.CHANNEL_DATA);
      data.uint32();
      expect(JSON.parse(decoder.decode(data.string()))).toEqual([["GIT_PROTOCOL", "version=2"]]);
    });

    it("refuses a second command, a PTY, a subsystem and agent forwarding on a channel", async () => {
      const client = await session();
      const { id } = await client.openSession();
      const string = (value: string) => new WireWriter().string(value).finish();
      for (const [type, rest] of [
        ["pty-req", undefined],
        ["subsystem", string("sftp")],
        ["auth-agent-req@openssh.com", undefined],
        ["x11-req", undefined],
        ["exec", string("")],
        ["exec", string("x".repeat(5000))],
        ["exec", Uint8Array.of(0, 0, 0, 2, 0xff, 0xfe)],
      ] as const) {
        await client.channelRequest(id, type, true, rest);
        await client.expect(Msg.CHANNEL_FAILURE);
      }
      await client.exec(id, "gate");
      await client.channelRequest(id, "exec", true, string("whoami"));
      await client.expect(Msg.CHANNEL_FAILURE);
      await client.channelRequest(id, "shell", true);
      await client.expect(Msg.CHANNEL_FAILURE);
    });

    it("refuses forwarding, in both directions", async () => {
      const client = await session();
      await client.send(
        new WireWriter()
          .byte(Msg.GLOBAL_REQUEST)
          .string("tcpip-forward")
          .boolean(true)
          .string("0.0.0.0")
          .uint32(8080)
          .finish(),
      );
      await client.expect(Msg.REQUEST_FAILURE);

      await client.send(
        new WireWriter()
          .byte(Msg.CHANNEL_OPEN)
          .string("direct-tcpip")
          .uint32(5)
          .uint32(1024)
          .uint32(1024)
          .string("127.0.0.1")
          .uint32(22)
          .string("127.0.0.1")
          .uint32(1234)
          .finish(),
      );
      const failure = await client.expect(Msg.CHANNEL_OPEN_FAILURE);
      expect(failure.uint32()).toBe(5);
      expect(failure.uint32()).toBe(OpenFailure.ADMINISTRATIVELY_PROHIBITED);
    });

    it("caps the sessions open at once", async () => {
      const small = await start({ maxChannels: 2 });
      const client = await session(undefined, small);
      await client.openSession(1 << 20, 32768, 0);
      await client.openSession(1 << 20, 32768, 1);
      await client.send(
        new WireWriter()
          .byte(Msg.CHANNEL_OPEN)
          .string("session")
          .uint32(2)
          .uint32(1 << 20)
          .uint32(32768)
          .finish(),
      );
      const failure = await client.expect(Msg.CHANNEL_OPEN_FAILURE);
      failure.uint32();
      expect(failure.uint32()).toBe(OpenFailure.RESOURCE_SHORTAGE);
    });

    it("answers an unknown message type with UNIMPLEMENTED and carries on", async () => {
      const client = await session();
      await client.send(Uint8Array.of(199, 1, 2, 3));
      const reply = await client.expect(Msg.UNIMPLEMENTED);
      expect(reply.uint32()).toBe(client.lastSentSequence);
      await client.openSession();
    });

    it("disconnects on a message for a channel that is not open", async () => {
      const client = await session();
      await client.data(3, encoder.encode("hello"));
      expect((await client.expectDisconnect()).reason).toBe(DisconnectReason.PROTOCOL_ERROR);
    });
  });

  describe("flow control", () => {
    it("never sends more than the client's window", async () => {
      const client = await session();
      const { id } = await client.openSession(5000, 2000);
      await client.exec(id, "produce 20000");
      let received = 0;
      const sizes: number[] = [];
      while (received < 5000) {
        const data = await client.expect(Msg.CHANNEL_DATA);
        data.uint32();
        const length = data.string().length;
        sizes.push(length);
        received += length;
      }
      expect(received).toBe(5000);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(2000);

      // Nothing more arrives until the window is opened again.
      const next = client.read();
      const early = await Promise.race([next.then(() => "data"), sleep(300).then(() => "quiet")]);
      expect(early).toBe("quiet");
      await client.windowAdjust(id, 100_000);
      let payload = await next;
      for (;;) {
        if (payload[0] !== Msg.CHANNEL_DATA) break;
        received += payload.length - 9;
        payload = await client.read();
      }
      expect(received).toBe(20000);
      expect(payload[0]).toBe(Msg.CHANNEL_REQUEST);
    });

    it("opens its own window only as the command reads", async () => {
      const small = await start({ channelWindow: 64 * 1024 });
      const client = await session(undefined, small);
      const { id, window } = await client.openSession();
      expect(window).toBe(64 * 1024);
      await client.exec(id, "gate");

      // Fill the window exactly. The command is not reading, so no more is granted.
      const chunk = new Uint8Array(16 * 1024);
      for (let sent = 0; sent < window; sent += chunk.length) await client.data(id, chunk);
      const next = client.read();
      const early = await Promise.race([next.then(() => "adjust"), sleep(300).then(() => "quiet")]);
      expect(early).toBe("quiet");

      openGate();
      let granted = 0;
      let payload = await next;
      while (payload[0] === Msg.CHANNEL_WINDOW_ADJUST) {
        granted += new DataView(payload.buffer, payload.byteOffset).getUint32(5);
        if (granted >= window) break;
        payload = await client.read();
      }
      expect(granted).toBe(window);

      await client.eof(id);
      const data = await client.expect(Msg.CHANNEL_DATA);
      data.uint32();
      expect(decoder.decode(data.string())).toBe(String(window));
    });

    it("keeps taking input a command has stopped reading, without holding it", async () => {
      const small = await start({ channelWindow: 64 * 1024 });
      const client = await session(undefined, small);
      const { id, window } = await client.openSession();
      await client.exec(id, "deaf");
      // Several windows' worth: each is granted back as it is thrown away.
      const chunk = new Uint8Array(32 * 1024);
      let granted = 0;
      for (let sent = 0; sent < 4 * window; sent += chunk.length) {
        await client.data(id, chunk);
        // Half a window has gone by, which is when the server tops it up.
        const adjust = await client.expect(Msg.CHANNEL_WINDOW_ADJUST);
        adjust.uint32();
        granted += adjust.uint32();
      }
      expect(granted).toBe(4 * window);
      await client.eof(id);
      openGate();
      const status = await client.expect(Msg.CHANNEL_REQUEST);
      status.uint32();
      status.text();
      status.boolean();
      expect(status.uint32()).toBe(5);
      expect(small.errors).toEqual([]);
    });

    it("disconnects a client that overruns the window", async () => {
      const small = await start({ channelWindow: 64 * 1024 });
      const client = await session(undefined, small);
      const { id } = await client.openSession();
      await client.exec(id, "gate");
      const chunk = new Uint8Array(32 * 1024);
      await client.data(id, chunk);
      await client.data(id, chunk);
      await client.data(id, Uint8Array.of(1));
      expect(await client.expectDisconnect()).toMatchObject({
        reason: DisconnectReason.PROTOCOL_ERROR,
        message: "channel window exceeded",
      });
    });

    it("disconnects a client that sends more than the maximum packet", async () => {
      const client = await session();
      const { id } = await client.openSession();
      await client.exec(id, "gate");
      await client.data(id, new Uint8Array(32768 + 1));
      expect((await client.expectDisconnect()).message).toBe("channel packet too large");
    });

    it("disconnects a client that grows the window past 2^32", async () => {
      const client = await session();
      const { id } = await client.openSession(0xffffff00);
      await client.windowAdjust(id, 0x1000);
      expect((await client.expectDisconnect()).message).toBe("channel window overflow");
    });
  });

  describe("re-keying", () => {
    it.each(["aes128-gcm@openssh.com", "chacha20-poly1305@openssh.com"])(
      "starts a new key exchange after enough data, under %s",
      async (cipher) => {
        const eager = await start({ rekeyAfterBytes: 64 * 1024 });
        const summary = eager.nextSummary();
        for (const strict of [true, false]) {
          const client = await session({ cipher, strict }, eager);
          const { id } = await client.openSession(1 << 30);
          await client.exec(id, "produce 8000000");
          let received = 0;
          for (;;) {
            const payload = await client.read();
            if (payload[0] !== Msg.CHANNEL_DATA) break;
            received += payload.length - 9;
          }
          expect(received).toBe(8_000_000);
          // The first exchange and at least one the server asked for. Far
          // fewer than one per 64 KiB: data keeps flowing while an exchange
          // is in flight, and this client shares the server's event loop.
          expect(client.keyExchanges).toBeGreaterThan(1);
          client.close();
        }
        expect((await summary).keyExchanges).toBeGreaterThan(1);
      },
    );

    it("answers what arrived between the two KEXINITs once the exchange is done", async () => {
      const eager = await start({ rekeyAfterBytes: 64 * 1024 });
      const client = await session(undefined, eager);
      const { id } = await client.openSession(1 << 30);
      await client.exec(id, "produce 200000");

      let received = 0;
      let serverKexInit: Uint8Array | null = null;
      while (!serverKexInit) {
        const payload = (await client.readRaw())!;
        if (payload[0] === Msg.CHANNEL_DATA) received += payload.length - 9;
        else if (payload[0] === Msg.KEXINIT) serverKexInit = payload;
      }
      // The server has asked for new keys. A request sent before the client
      // answers is legal, and its reply has to wait for the exchange.
      await client.keyExchange(serverKexInit, () => client.channelRequest(id, "pty-req", true));
      const afterwards: number[] = [];
      for (;;) {
        const payload = await client.read();
        afterwards.push(payload[0]!);
        if (payload[0] === Msg.CHANNEL_DATA) received += payload.length - 9;
        if (payload[0] === Msg.CHANNEL_CLOSE) break;
      }
      expect(afterwards).toContain(Msg.CHANNEL_FAILURE);
      expect(received).toBe(200_000);
    });

    it("gives up on a key exchange the client never answers", async () => {
      const eager = await start({ rekeyAfterBytes: 64 * 1024, authTimeoutMs: 400 });
      const summary = eager.nextSummary();
      const client = await session(undefined, eager);
      const { id } = await client.openSession(1 << 30);
      await client.exec(id, "produce 200000");
      await client.closed();
      expect((await summary).error?.message).toBe("key exchange timed out");
    });
  });

  describe("timeouts and shutdown", () => {
    it("closes an idle connection", async () => {
      const quick = await start({ idleTimeoutMs: 300 });
      const client = await session(undefined, quick);
      const started = Date.now();
      expect((await client.expectDisconnect()).message).toBe("idle timeout");
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("frees a connection whose client has stopped reading", async () => {
      const quick = await start({ idleTimeoutMs: 300 });
      const summary = quick.nextSummary();
      const client = await session(undefined, quick);
      const { id } = await client.openSession(0xffffffff);
      await client.exec(id, "produce 268435456");
      // The client takes nothing more off the socket. The command blocks on
      // its write, the read loop has nothing to read, and only the idle
      // timer can end it.
      client.pause();
      const ended = await summary;
      expect(ended.error?.message).toBe("idle timeout");
      expect(ended.bytesOut).toBeLessThan(128 * 1024 * 1024);
      expect(quick.errors).toEqual([]);
    }, 15_000);

    it("disconnects everyone when the host aborts", async () => {
      const controller = new AbortController();
      const stoppable = await start(undefined, { signal: controller.signal });
      const client = await session(undefined, stoppable);
      controller.abort();
      expect((await client.expectDisconnect()).reason).toBe(DisconnectReason.BY_APPLICATION);
    });
  });
});
