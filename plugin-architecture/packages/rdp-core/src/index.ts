// Shared RDCleanPath → TCP proxy for the embedded IronRDP (ironrdp-wasm) client.
// The WASM client speaks RDP over a "WebSocket" using Devolutions' RDCleanPath
// extension: instead of opening a raw TCP socket (which a browser context
// cannot), it hands us an X.224 connection request wrapped in an ASN.1-DER PDU,
// we perform the TCP + X.224 + TLS handshake against the real RDP server, hand
// the negotiated certificate chain back, and then relay the TLS byte stream
// verbatim. See the RDCleanPath spec in the IronRDP repo.
//
// Transport-agnostic: it drives an abstract `RdpChannel`. Two hosts back it —
//   • desktop main (`electron/rdp-host.ts`): the channel is the renderer's
//     WebSocket-shim IPC relay, so no listening socket is opened;
//   • web server (`src/services/rdp-proxy.ts`): the channel is a real
//     server-side WebSocket, and `destinationOverride` forces the host resolved
//     from the authenticated resource so the browser can't drive an SSRF.
//
// Node-only (`net`/`tls`); the DER codec is hand-rolled (the wire format is a
// handful of fixed tags) rather than pulling in an ASN.1 library.
import net from "node:net";
import tls from "node:tls";

/**
 * A duplex byte channel between the WASM client and this proxy. rdp-host.ts
 * backs it with the renderer's WebSocket-shim IPC relay. `onMessage` SETS the
 * current inbound handler (the first-frame handler is later replaced by the
 * relay handler); the backing implementation buffers anything that arrives
 * before a handler is set.
 */
export interface RdpChannel {
  onMessage(cb: (data: Buffer) => void): void;
  send(data: Buffer): void;
  onClose(cb: () => void): void;
  close(): void;
}

// RDCleanPath protocol version — literally 3389 + 1.
const VERSION = 3390;

const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8STRING = 0x0c;
const ctx = (n: number): number => 0xa0 + n;

// ── DER encoding ──────────────────────────────────────────────────────────

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let temp = length;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derInteger(value: number): Buffer {
  if (value === 0) return derWrap(TAG_INTEGER, Buffer.from([0]));
  const bytes: number[] = [];
  let temp = value;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  if (bytes[0]! & 0x80) bytes.unshift(0); // keep it unsigned
  return derWrap(TAG_INTEGER, Buffer.from(bytes));
}

function derUtf8(str: string): Buffer {
  return derWrap(TAG_UTF8STRING, Buffer.from(str, "utf-8"));
}

function derOctetString(buf: Buffer): Buffer {
  return derWrap(TAG_OCTET_STRING, buf);
}

function derContext(tagNum: number, content: Buffer): Buffer {
  return derWrap(ctx(tagNum), content);
}

// ── DER decoding ──────────────────────────────────────────────────────────

function decodeLength(buf: Buffer, offset: number): { length: number; bytesRead: number } {
  const first = buf[offset]!;
  if (first < 0x80) return { length: first, bytesRead: 1 };
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = (length << 8) | buf[offset + 1 + i]!;
  return { length, bytesRead: 1 + numBytes };
}

interface Tlv {
  tag: number;
  value: Buffer;
  totalLength: number;
}

function decodeTlv(buf: Buffer, offset: number): Tlv {
  const tag = buf[offset]!;
  const { length, bytesRead } = decodeLength(buf, offset + 1);
  const headerLen = 1 + bytesRead;
  return {
    tag,
    value: buf.subarray(offset + headerLen, offset + headerLen + length),
    totalLength: headerLen + length,
  };
}

function decodeInteger(buf: Buffer): number {
  let val = 0;
  for (const b of buf) val = (val << 8) | b;
  return val;
}

function decodeChildren(buf: Buffer): Tlv[] {
  const children: Tlv[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const tlv = decodeTlv(buf, offset);
    children.push(tlv);
    offset += tlv.totalLength;
  }
  return children;
}

// ── RDCleanPath PDUs ──────────────────────────────────────────────────────

interface RdCleanPathRequest {
  destination: string;
  x224ConnectionRequest: Buffer;
}

function parseRequest(data: Buffer): RdCleanPathRequest {
  const outer = decodeTlv(data, 0);
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`Expected SEQUENCE (0x30), got 0x${outer.tag.toString(16)}`);
  }
  let version: number | null = null;
  let destination: string | null = null;
  let x224: Buffer | null = null;
  for (const child of decodeChildren(outer.value)) {
    const ctxTag = child.tag & 0x1f;
    switch (ctxTag) {
      case 0:
        version = decodeInteger(decodeTlv(child.value, 0).value);
        break;
      case 2:
        destination = decodeTlv(child.value, 0).value.toString("utf-8");
        break;
      case 6:
        x224 = decodeTlv(child.value, 0).value;
        break;
      // 3 (proxy_auth) and 5 (preconnection_blob) are unused by this proxy.
    }
  }
  if (version !== VERSION) throw new Error(`Unsupported RDCleanPath version: ${version}`);
  if (!destination) throw new Error("Missing destination in RDCleanPath request");
  if (!x224) throw new Error("Missing x224_connection_pdu in RDCleanPath request");
  return { destination, x224ConnectionRequest: Buffer.from(x224) };
}

function buildResponse(serverAddr: string, x224Response: Buffer, certChain: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(derContext(0, derInteger(VERSION)));
  parts.push(derContext(6, derOctetString(x224Response)));
  const certSeq = derWrap(TAG_SEQUENCE, Buffer.concat(certChain.map(derOctetString)));
  parts.push(derContext(7, certSeq));
  parts.push(derContext(9, derUtf8(serverAddr)));
  return derWrap(TAG_SEQUENCE, Buffer.concat(parts));
}

function buildError(errorCode: number, httpStatusCode?: number): Buffer {
  const errParts: Buffer[] = [derContext(0, derInteger(errorCode))];
  if (httpStatusCode != null) errParts.push(derContext(1, derInteger(httpStatusCode)));
  const errSeq = derWrap(TAG_SEQUENCE, Buffer.concat(errParts));
  return derWrap(
    TAG_SEQUENCE,
    Buffer.concat([derContext(0, derInteger(VERSION)), derContext(1, errSeq)]),
  );
}

// ── Destination + handshake ────────────────────────────────────────────────

export function parseDestination(destination: string): { host: string; port: number } {
  if (destination.startsWith("[")) {
    const end = destination.indexOf("]");
    if (end === -1) throw new Error(`Invalid IPv6 destination: ${destination}`);
    const host = destination.slice(1, end);
    const rest = destination.slice(end + 1);
    return { host, port: rest.startsWith(":") ? parseInt(rest.slice(1), 10) || 3389 : 3389 };
  }
  const lastColon = destination.lastIndexOf(":");
  if (lastColon === -1) return { host: destination, port: 3389 };
  const port = parseInt(destination.slice(lastColon + 1), 10);
  return { host: destination.slice(0, lastColon), port: isNaN(port) ? 3389 : port };
}

function extractCertChain(peerCert: tls.DetailedPeerCertificate | null): Buffer[] {
  const certs: Buffer[] = [];
  if (!peerCert || !peerCert.raw) return certs;
  const seen = new Set<string>();
  let current: tls.DetailedPeerCertificate | undefined = peerCert;
  while (current && current.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString("hex");
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    certs.push(Buffer.from(current.raw));
    if (current.issuerCertificate && current.issuerCertificate !== current) {
      current = current.issuerCertificate;
    } else {
      break;
    }
  }
  return certs;
}

interface HandshakeResult {
  x224Response: Buffer;
  certChain: Buffer[];
  tlsSocket: tls.TLSSocket;
}

function performHandshake(
  host: string,
  port: number,
  x224Request: Buffer,
): Promise<HandshakeResult> {
  return new Promise((resolve, reject) => {
    const tcpSocket = net.createConnection({ host, port }, () => {
      tcpSocket.write(x224Request);
    });

    tcpSocket.once("error", (err) => reject(new Error(`TCP connection failed: ${err.message}`)));

    // The RDP server answers the raw X.224 connection request before any TLS.
    tcpSocket.once("data", (x224Response: Buffer) => {
      if (x224Response.length === 0) {
        tcpSocket.destroy();
        reject(new Error("RDP server closed connection without an X.224 response"));
        return;
      }
      tcpSocket.removeAllListeners("error");
      tcpSocket.removeAllListeners("data");

      // RDP servers ship self-signed certificates by default; we hand the
      // negotiated chain back to the WASM client, which surfaces it for the
      // user to accept — so verifying it here would be redundant.
      const tlsSocket = tls.connect(
        { socket: tcpSocket, servername: host, rejectUnauthorized: false },
        () => {
          const certChain = extractCertChain(tlsSocket.getPeerCertificate(true));
          resolve({ x224Response: Buffer.from(x224Response), certChain, tlsSocket });
        },
      );
      tlsSocket.once("error", (err) => reject(new Error(`TLS handshake failed: ${err.message}`)));
    });

    tcpSocket.setTimeout(15000, () => {
      tcpSocket.destroy();
      reject(new Error("Connection to the RDP server timed out"));
    });
  });
}

function setupRelay(channel: RdpChannel, tlsSocket: tls.TLSSocket): void {
  tlsSocket.on("data", (data: Buffer) => channel.send(data));
  // Replaces the first-frame handler installed by handleRdpChannel.
  channel.onMessage((data: Buffer) => {
    if (!tlsSocket.destroyed) {
      try {
        tlsSocket.write(data);
      } catch {
        /* socket closed under us */
      }
    }
  });
  channel.onClose(() => {
    if (!tlsSocket.destroyed) tlsSocket.destroy();
  });
  const done = (): void => channel.close();
  tlsSocket.on("end", done);
  tlsSocket.on("error", done);
}

export interface HandleRdpOptions {
  /**
   * Force the TCP destination instead of trusting the one inside the client's
   * RDCleanPath request. Server-side callers (the web proxy) MUST set this to a
   * host resolved from the authenticated resource — otherwise a browser could
   * make the server dial any host:port (SSRF). Desktop-local callers can omit
   * it since the destination comes from their own trusted renderer.
   */
  destinationOverride?: string;
}

/**
 * Drive one RDCleanPath session over an RdpChannel. The first inbound frame is
 * the RDCleanPath request; after the handshake, everything is relayed to TLS.
 */
export function handleRdpChannel(channel: RdpChannel, options: HandleRdpOptions = {}): void {
  let handshakeStarted = false;
  channel.onMessage((data: Buffer) => {
    // Only the first frame reaches here — setupRelay swaps the handler after a
    // successful handshake. Guard anyway against a client that pipelines.
    if (handshakeStarted) return;
    handshakeStarted = true;
    void (async () => {
      try {
        const request = parseRequest(data);
        const { host, port } = parseDestination(options.destinationOverride ?? request.destination);
        const { x224Response, certChain, tlsSocket } = await performHandshake(
          host,
          port,
          request.x224ConnectionRequest,
        );
        channel.send(buildResponse(`${host}:${port}`, x224Response, certChain));
        setupRelay(channel, tlsSocket);
      } catch (err) {
        try {
          channel.send(buildError(1, 502));
        } catch {
          /* nothing to report to */
        }
        channel.close();
        console.warn("[rdp] RDCleanPath handshake failed:", (err as Error).message);
      }
    })();
  });
}
