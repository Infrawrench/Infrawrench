/**
 * Typed errors callers can catch to distinguish bastion-routing failures
 * from genuine cloud-API failures. The host-services layer surfaces these
 * synchronously when the account is bound to a bastion that isn't reachable;
 * plugins shouldn't retry on these — the user has to bring the bastion back
 * up or unbind the account from it.
 */

export class BastionError extends Error {
  readonly bastionId: string;
  constructor(message: string, bastionId: string) {
    super(message);
    this.name = "BastionError";
    this.bastionId = bastionId;
  }
}

/** Account is bound to a bastion, but no agent is currently connected. */
export class BastionDisconnectedError extends BastionError {
  constructor(bastionId: string) {
    super(`Bastion ${bastionId} is offline — start the agent to restore connectivity.`, bastionId);
    this.name = "BastionDisconnectedError";
  }
}

/** Account is bound to a bastion id that no longer exists (revoked or deleted). */
export class BastionRevokedError extends BastionError {
  constructor(bastionId: string) {
    super(`Bastion ${bastionId} has been revoked.`, bastionId);
    this.name = "BastionRevokedError";
  }
}

/** Agent rejected the open — destination outside the allowlist or DNS failure. */
export class BastionStreamOpenError extends BastionError {
  constructor(bastionId: string, reason: string) {
    super(`Bastion ${bastionId} refused to open stream: ${reason}`, bastionId);
    this.name = "BastionStreamOpenError";
  }
}

export function isBastionError(err: unknown): err is BastionError {
  return err instanceof BastionError;
}
