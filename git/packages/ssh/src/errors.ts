/** `SSH_MSG_DISCONNECT` reason codes (RFC 4253, section 11.1). */
export const DisconnectReason = {
  HOST_NOT_ALLOWED_TO_CONNECT: 1,
  PROTOCOL_ERROR: 2,
  KEY_EXCHANGE_FAILED: 3,
  MAC_ERROR: 5,
  SERVICE_NOT_AVAILABLE: 7,
  PROTOCOL_VERSION_NOT_SUPPORTED: 8,
  CONNECTION_LOST: 10,
  BY_APPLICATION: 11,
  TOO_MANY_CONNECTIONS: 12,
  NO_MORE_AUTH_METHODS_AVAILABLE: 14,
} as const;

/**
 * A failure that ends the connection. `message` is sent to the client in the
 * disconnect packet, so it only ever says what the client did, never anything
 * about the server's state.
 */
export class SshError extends Error {
  override readonly name = "SshError";

  constructor(
    readonly reason: number,
    message: string,
  ) {
    super(message);
  }
}

export function protocolError(message: string): SshError {
  return new SshError(DisconnectReason.PROTOCOL_ERROR, message);
}
