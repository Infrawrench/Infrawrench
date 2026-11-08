import {
  useUIStore,
  type SeatListResponse,
  type SeatRemovalResponse,
  type SeatSettings,
  type SeatsClient,
} from "@infrawrench/ui";
import { Effect, Option, Predicate, Schema } from "effect";
import { cloudClient, CloudResponseError } from "./cloud-client";
import { withoutNullRemediation } from "./cloud-remediation";
import { runRpc } from "./rpc/client";

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The Seats row shows a refusal (a freeze, a provider error) verbatim, so a
 * failed answer carrying the server's `{ error }` sentence fails with that
 * sentence in place of the transport's `Cloud request failed: ...`; any other
 * body keeps the transport's message.
 */
function serverMessage<E>(error: E): E | CloudResponseError {
  if (!(error instanceof CloudResponseError)) return error;
  const message = decodeBody(error.body).pipe(
    Option.flatMap((body) =>
      Predicate.hasProperty(body, "error") && Predicate.isString(body.error)
        ? Option.some(body.error)
        : Option.none(),
    ),
  );
  return Option.isSome(message)
    ? new CloudResponseError({ message: message.value, status: error.status, body: error.body })
    : error;
}

const withServerMessage = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  call.pipe(Effect.mapError(serverMessage));

const seats = () => cloudClient("seats").seats;

/**
 * Seats-section data access; cloud-mode only (the caller leaves the section
 * off without an active cloud org): the inventory is collected by the cloud
 * poller. The org is resolved at call time, the rightsizing-client
 * convention, so switching org under a mounted Costs tab reaches the right
 * data.
 */
export function createDesktopSeatsClient(): SeatsClient {
  const requireOrg = (): string => {
    const orgId = useUIStore.getState().activeCloudOrgId;
    if (!orgId) throw new Error("Sign in to Infrawrench Cloud to see seats");
    return orgId;
  };
  return {
    listSeats: (): Promise<SeatListResponse> =>
      runRpc(
        seats()
          .list({ params: { orgId: requireOrg() } })
          .pipe(
            Effect.map((res): SeatListResponse => ({
              ...res,
              findings: res.findings.map(withoutNullRemediation),
            })),
          ),
      ),
    refreshSeats: (): Promise<{ queued: number }> =>
      runRpc(
        seats()
          .refresh({ params: { orgId: requireOrg() } })
          .pipe(withServerMessage),
      ),
    removeSeat: (seatId: string): Promise<SeatRemovalResponse> =>
      runRpc(
        seats()
          .remove({ params: { orgId: requireOrg(), seatId } })
          .pipe(withServerMessage),
      ),
    updateSeatSettings: (settings: SeatSettings): Promise<SeatSettings> =>
      runRpc(
        seats()
          .updateSettings({
            params: { orgId: requireOrg() },
            payload: { inactiveDays: settings.inactiveDays },
          })
          .pipe(withServerMessage),
      ),
  };
}
