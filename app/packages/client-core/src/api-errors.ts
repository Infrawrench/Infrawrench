/**
 * Structured API errors shared by every client transport.
 *
 * The web app's cookie fetch and the desktop's IPC settings proxy both throw
 * these for the corresponding structured responses, so shared UI (the
 * settings sections) can `instanceof`-match without knowing the transport.
 */

/** Payload of the structured 409 an invite gets when the paid plan is full. */
export interface SeatLimitPayload {
  error: string;
  code: "seat_limit_reached";
  /** Total capacity, monthly subscription seats plus prepaid capacity slots. */
  seatCount: number;
  seatsUsed: number;
  /**
   * Whether retrying with `addSeat: true` can work. False when the org's
   * capacity is entirely prepaid capacity slots: there is no monthly seat to
   * add, so the only remedy is buying another slot, and the prompt must send
   * the user to Billing instead of offering a retry. Optional so a response
   * from a server predating the field reads as the old add-a-seat behaviour.
   */
  canAddSeat?: boolean;
}

export function isSeatLimitResponse(parsed: unknown): parsed is SeatLimitPayload {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { code?: unknown }).code === "seat_limit_reached"
  );
}

/**
 * Thrown for the structured `seat_limit_reached` 409. Callers can `catch` it
 * to drive an "add a seat?" prompt, then retry the invite with `addSeat: true`.
 */
export class SeatLimitReachedClientError extends Error {
  readonly payload: SeatLimitPayload;
  constructor(payload: SeatLimitPayload) {
    super(payload.error || "All seats are in use");
    this.name = "SeatLimitReachedClientError";
    this.payload = payload;
  }
}

/**
 * Thrown for any 402: the organization's plan does not include the attempted
 * action. Callers can `catch` it to render an upgrade prompt instead of a
 * plain error message.
 */
export class PlanRequiredClientError extends Error {
  constructor(message: string) {
    super(message || "This feature requires a paid plan");
    this.name = "PlanRequiredClientError";
  }
}

/**
 * Payload of the structured 409 a GitHub filing or pull request gets when the
 * org's GitHub App installation has not been granted the permission it needs.
 *
 * GitHub applies a GitHub App's newly requested permissions to an existing
 * installation only once an owner of that GitHub account approves them, so an
 * installation made before issue filing existed keeps working for workflows
 * and agents but answers 403 here until then. The UI turns this into a
 * "grant the permission" prompt linking to {@link manageUrl}.
 */
export interface GithubPermissionRequiredPayload {
  error: string;
  code: "github_permission_required";
  /** GitHub permission names missing write access, e.g. `["issues"]`. */
  permissions: string[];
  installationId: number;
  accountLogin: string | null;
  /** Where an owner reviews and approves the requested permissions. */
  manageUrl: string | null;
}

export function isGithubPermissionRequiredResponse(
  parsed: unknown,
): parsed is GithubPermissionRequiredPayload {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { code?: unknown }).code === "github_permission_required"
  );
}

/** Thrown for the structured `github_permission_required` 409. */
export class GithubPermissionRequiredClientError extends Error {
  readonly payload: GithubPermissionRequiredPayload;
  constructor(payload: GithubPermissionRequiredPayload) {
    super(payload.error || "The GitHub App needs more permissions");
    this.name = "GithubPermissionRequiredClientError";
    this.payload = payload;
  }
}
