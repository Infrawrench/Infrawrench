# @infrawrench/git-ssh

An SSH-2 server over any duplex byte stream: Web Streams in, Web Streams out, WebCrypto for the mathematics. It knows nothing about git. Who a key belongs to and what a command does are callbacks. `git/README.md` has where it sits in the forge.

Nothing in `src/` imports `node:*` or `cloudflare:*`, and the package has no dependencies. The tests are the only place Node appears.

## Public API

```ts
import {
  serveConnection, // (stream, options) => Promise<void>
  loadHostKey, // (pem) => Promise<HostKey>, once per isolate
  parseAuthorizedKey, // (line) => Promise<AuthorizedKey | null>, when a user adds a key
  parseOpenSshPrivateKey, // (pem) => Promise<OpenSshPrivateKey>
  fingerprintSha256, // (blob) => Promise<"SHA256:...">
  SshError,
  DisconnectReason,
  KeyFormatError,
} from "@infrawrench/git-ssh";
```

`serveConnection` resolves when the connection is over, however it ended. It rejects only for a configuration error (an unusable host key or `softwareVersion`), before anything is sent. Everything else is reported through two hooks:

- `onClose(summary)`: once per connection. Client version, whether it authenticated, key exchange method, cipher, whether strict key exchange was on, how many key exchanges, bytes each way, and `error` (an `SshError`, or null when the client closed). Nothing in it is secret.
- `onError(error)`: something broke on our side (a callback threw, or a bug). A misbehaving client is never reported here; it is `summary.error`.

The three key helpers are async because the fingerprint is a WebCrypto digest.

## Algorithms

| What         | Supported                                                                                                          | Notes                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Key exchange | `mlkem768x25519-sha256`, `curve25519-sha256`, `curve25519-sha256@libssh.org`                                       | The hybrid only where the runtime has ML-KEM (see below). `kex-strict-s-v00@openssh.com` in the first exchange.             |
| Host key     | `ssh-ed25519`                                                                                                      | One key. RSA and ECDSA host keys are not implemented.                                                                       |
| Cipher       | `aes256-gcm@openssh.com`, `aes128-gcm@openssh.com`, `chacha20-poly1305@openssh.com`                                | In that order of server preference; the client's own order decides. AEAD only: there is no CBC, no CTR and no separate MAC. |
| Compression  | `none`                                                                                                             |                                                                                                                             |
| User keys    | `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ecdsa-sha2-nistp521`, `rsa-sha2-512`, `rsa-sha2-256` | Advertised through `server-sig-algs` (`ext-info`). `ssh-rsa` (SHA-1) is refused. RSA moduli from 2048 to 8192 bits.         |
| Extensions   | `ext-info-c` answered with `server-sig-algs`                                                                       | The server does not ask for the client's extensions, but ignores an `EXT_INFO` if one arrives.                              |

AES-GCM, X25519, Ed25519, ECDSA, RSA and SHA-2 are WebCrypto. ChaCha20 and Poly1305 are not in WebCrypto, so `src/cipher/chacha20.ts` and `src/cipher/poly1305.ts` are this package's own: checked against the RFC 8439 vectors, against Node's ChaCha20, against Poly1305 computed from its definition in big integers, and against the real OpenSSH client.

### The post-quantum hybrid needs a compatibility flag

A current OpenSSH client (seen with 10.3) prints a three-line warning on every connection whose key exchange is not post-quantum ("store now, decrypt later"). That is every `git fetch` for anyone on one, so the server offers `mlkem768x25519-sha256`, the method those clients prefer.

ML-KEM-768 encapsulation comes from WebCrypto's Modern Algorithms API, which Node 24 has (checked on 24.21) and Workers has behind the `webcrypto_modern_algorithms` compatibility flag. `mlkemAvailable()` tries one encapsulation per isolate and the method is offered only if it works; without it the server offers curve25519 alone and everything still connects, with the warning. **The worker's `wrangler.jsonc` should add `"webcrypto_modern_algorithms"` to `compatibility_flags`.** Checked both ways in local workerd (wrangler 4.162).

## Security decisions

- **Strict key exchange** (Terrapin, CVE-2023-48795) whenever the client offers it: sequence numbers reset at every NEWKEYS, the client's KEXINIT must be the very first packet, and any packet that is not part of the first exchange ends the connection. A client that does not offer it is still served. Refusing would lock out older OpenSSH and several libraries, and what the attack buys against this server is small: there is no CBC or EtM, so only ChaCha20-Poly1305 is affected, and the one thing a truncation can remove is `EXT_INFO`, which cannot downgrade anything because SHA-1 signatures are refused outright. `summary.strictKex` says which it was.
- **A key is looked up for real only after its signature verifies.** `authenticate(user, key, "query")` runs when a client asks whether a key would be accepted (it has proved nothing, and the answer only decides whether the server says "go on"). `authenticate(user, key, "verified")` runs after the signature over the session id has been checked, and only that principal is used. Side effects (last-used time, audit) belong in `"verified"`. A lookup that throws refuses the key and goes to `onError`.
- **`ssh-rsa` with SHA-1 is refused before the key is decoded**, and the algorithm named inside a signature must be the one the request named, so a client cannot ask for `rsa-sha2-512` and sign with something else.
- **Attempts are capped** (`maxAuthAttempts`, default 10 failures), and so are requests of any kind (four times that), since a "yes" to a query is not a failure and would otherwise be free for ever.
- **Constant-time comparison** for the Poly1305 tag, which is checked before a byte is decrypted. AES-GCM tags are checked inside WebCrypto. The ChaCha20 and Poly1305 code has no secret-dependent branches or table lookups; a JIT gives no stronger guarantee than that.
- **A low-order X25519 point is refused** (all-zero shared secret), for both key exchange methods.
- **Messages sent to a client only describe what the client did.** An internal failure is "internal error"; the detail goes to `onError`.
- **No compression**, so there is nothing to inflate.
- **The host key's seed is zeroed after import** and the `CryptoKey` is not extractable. The PEM string it came from is the host's to manage. `loadHostKey` signs and verifies once, so a file whose public and private halves disagree fails at start instead of at the first client.
- **Whether a key is registered is visible to anyone who has the public key** (the answer to a query). That is inherent to SSH public key authentication and the same on every forge.
- **`exec` commands, env values and user names are refused unless valid UTF-8**, and text is never rewritten on the way through. The command string is passed to the callback as sent: the host must parse it, never hand it to a shell.
- **Refused outright**: port forwarding in both directions, agent forwarding, X11, subsystems (so no SFTP), PTYs, any channel type but `session`, any auth method but `publickey`.

## Limits

| Limit                          | Value                               | Option                   |
| ------------------------------ | ----------------------------------- | ------------------------ |
| Identification line            | 255 bytes                           |                          |
| Packet (`packet_length`)       | 256 KiB, checked before it is read  |                          |
| Time to authenticate           | 30 s from the first byte            | `limits.authTimeoutMs`   |
| A later key exchange           | the same 30 s                       | `limits.authTimeoutMs`   |
| Idle (no packet either way)    | 5 min                               | `limits.idleTimeoutMs`   |
| Failed auth attempts           | 10                                  | `limits.maxAuthAttempts` |
| Sessions open at once          | 8 per connection                    | `limits.maxChannels`     |
| Channel window (ours)          | 2 MiB, clamped to 64 KiB..16 MiB    | `limits.channelWindow`   |
| Channel data per message       | 32 KiB each way                     |                          |
| Re-key                         | after 1 GiB or 2^31 packets         | `limits.rekeyAfterBytes` |
| `env` per channel              | 32 variables, 128-byte names, 4 KiB |                          |
| `exec` command                 | 4 KiB                               |                          |
| Replies queued during a re-key | 256                                 |                          |

Memory per connection is bounded by flow control, not by the size of what is transferred:

- **Inbound**: the client may send one window (2 MiB) per channel. The window is topped up only as the command reads its `stdin`, so data nobody reads stays in the client. A command that cancels its `stdin`, or has finished, has its input thrown away and the window topped up, so the client is never left stuck.
- **Outbound**: a write to `stdout`/`stderr` waits for the client's window and then for the socket's own backpressure. A command that produces faster than the client takes is slowed down, not buffered.

Measured: with 128 MiB going through in a `git push` and again in a `git clone`, the server's buffers peak at up to about 20 MiB above where they started, sampled every 25 ms after a forced collection, and the figure is the same for 448 MiB. What is live is a window and what is in flight; the rest is buffers already freed and not yet swept. `test/git.test.ts` fails at 48 MiB, far below what holding the stream would show.

## What the Worker host must do

```ts
import { loadHostKey, serveConnection, type HostKey } from "@infrawrench/git-ssh";

let hostKey: Promise<HostKey> | undefined;

export default {
  async connect(socket: Socket, env: Env, ctx: ExecutionContext): Promise<void> {
    hostKey ??= loadHostKey(env.SSH_HOST_KEY);
    const { remoteAddress } = await socket.opened;
    // Keep this promise pending for the life of the connection: the runtime
    // closes the socket when the handler settles.
    await serveConnection(socket, {
      hostKeys: [await hostKey],
      authenticate: (user, key, phase) => lookUpKey(env, user, key.fingerprint, phase),
      exec: (principal, command, channel, gitEnv) =>
        runGit(env, principal, command, channel, gitEnv),
      shellGreeting: (principal) => `Hi ${principal.username}! ...\n`,
      onClose: (summary) => log(remoteAddress, summary),
      onError: (error) => report(error),
    });
  },
};
```

- **The socket is the stream.** A `connect()` socket's `readable`/`writable` are already what `DuplexStream` is; no adapter. `startTls` is not needed. The server treats end of the readable side as the end of the connection, and closes the writable side itself.
- **Host key secret**: the text of an unencrypted OpenSSH ed25519 private key, exactly as `ssh-keygen -t ed25519 -N "" -C git.infrawrench.com -f host_ed25519` writes it (`wrangler secret put SSH_HOST_KEY < host_ed25519`). Line endings and surrounding whitespace do not matter. A passphrase-protected key, or any other type, is refused with a message that says why. Load it once per isolate. Publish `hostKey.publicKey.fingerprint`; clients pin it, so replacing the key warns every user, and there is no rotation extension yet.
- **`user`** is whatever the client sent (`git` for `git@host:...`). The package does not insist on it; the host should.
- **`key.algorithm`** is the key type as in `authorized_keys` (`ssh-rsa` for RSA keys, whichever SHA-2 signature the client used). Look keys up by `key.fingerprint`, which is what `parseAuthorizedKey` returned when the key was added.
- **`exec`** gets `stdin` (ReadableStream), `stdout` and `stderr` (WritableStreams) and an `AbortSignal`. Resolve with the exit status only after the writes have been accepted (`await` them, or the `pipeTo`); the channel is closed as soon as the promise settles. Throwing reports exit status 1 to the client and the error to `onError`. The signal aborts, and the streams fail, when the client closes the channel or the connection goes away.
- **`env`** is what the client sent with `env` requests before the command; git sends `GIT_PROTOCOL=version=2`. The package only bounds it; which names to honour is the host's choice.
- **Long silences.** The idle timer counts packets in either direction. A command that works for minutes without output (indexing a large push) must send something (git's side-band keepalive) or the host must raise `idleTimeoutMs`.
- **Rate limiting by address** is the host's: the package never sees `remoteAddress`. So is a cap on connections per principal.
- **`signal`**: pass one to disconnect clients cleanly when the host wants them gone.
- **CPU.** Every byte is encrypted in the isolate. AES-GCM is native; ChaCha20-Poly1305 is JavaScript and costs several times more per byte (below). Clients that list AES-GCM first get it; OpenSSH lists ChaCha20 first.

## Throughput

`SSH_BENCH=1 npx vitest run test/throughput.test.ts` moves 512 MiB each way through the server with the real `ssh` client, per cipher. Apple M4, Node 24.21, loopback, a busy machine (other work was running), so read these as a range:

| Cipher                          | Upload (client to server) | Download         |
| ------------------------------- | ------------------------- | ---------------- |
| `aes128-gcm@openssh.com`        | 340 to 920 MiB/s          | 330 to 760 MiB/s |
| `aes256-gcm@openssh.com`        | 420 to 940 MiB/s          | 310 to 750 MiB/s |
| `chacha20-poly1305@openssh.com` | 100 to 170 MiB/s          | 100 to 175 MiB/s |

The same server inside local workerd (`wrangler dev` with a `connect` TCP listener, 256 MiB each way): AES-128-GCM about 195 MiB/s up and 500 MiB/s down, ChaCha20-Poly1305 about 33 MiB/s up and 67 MiB/s down. Production numbers through Spectrum will be set by the network long before the AES path is.

## Tests

`npx vitest run` (about 10 s; `vitest.config.ts` passes `--expose-gc` for the memory measurement). They never leave 127.0.0.1.

- `interop.test.ts`: the installed OpenSSH client. Every key type, each cipher and each key exchange method forced in turn, `RekeyLimit=1M`, the shell greeting, a refused PTY (through `script`, for a real terminal), subsystem, agent and port forwards, several sessions over a `ControlMaster`.
- `git.test.ts`: the real `git` over `GIT_SSH_COMMAND`, with `exec` running the real `git upload-pack`/`receive-pack`. Clone, fetch and push in protocol v0 and v2, branches and tags, and the 128 MiB push and clone with the memory bound.
- `protocol.test.ts`: `test/client.ts`, a scripted client that says what a real one never does: SHA-1 signatures, replayed signatures, injected packets during a strict key exchange, low-order points, window and packet overruns, a client that stops reading, a key exchange the server starts, each timeout.
- `cipher.test.ts`, `transport.test.ts`, `keys.test.ts`: vectors and unit tests; keys against what `ssh-keygen` writes and prints.

Tests that need `ssh`, `ssh-keygen` or `git` are skipped with a warning where one is missing, so a runner without them reports far fewer tests rather than a failure.

## Left out

- RSA and ECDSA **host** keys, and passphrase-protected host keys (bcrypt-pbkdf is not in WebCrypto).
- FIDO keys (`sk-ssh-ed25519@openssh.com`, `sk-ecdsa-sha2-nistp256@openssh.com`) and certificates. `parseAuthorizedKey` refuses them, so the UI can say so when a user pastes one. The `sk-` types would be a small addition (the signature covers a different structure) and are the likeliest next request.
- `sntrup761x25519-sha512`: not in WebCrypto. `mlkem768x25519-sha256` covers the same clients.
- `ping@openssh.com`, host key rotation (`hostkeys-00@openssh.com`), compression, a pre-auth banner.
