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
  seatCount: number;
  seatsUsed: number;
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
 * Thrown for any 402 — the organization's plan does not include the attempted
 * action. Callers can `catch` it to render an upgrade prompt instead of a
 * plain error message.
 */
export class PlanRequiredClientError extends Error {
  constructor(message: string) {
    super(message || "This feature requires a paid plan");
    this.name = "PlanRequiredClientError";
  }
}
