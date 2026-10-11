/**
 * The Seats response: the stored inventory, classified with the org's
 * threshold by client-core's `computeSeatFindings`, with each finding's
 * remediation commands from its plugin.
 *
 * **Cost visibility**: seat prices are per-account figures with no cost row to
 * test a cost centre or saved filter against, so a scoped caller sees only
 * the accounts its scope grants outright (`strictlyVisibleAccountIds`, the
 * commitments rule). Duplicates are computed over what the caller can see,
 * which can only ever hide a finding, never invent one.
 */
import {
  computeSeatFindings,
  type SeatFinding,
  type SeatListResponse,
  type SeatView,
} from "@infrawrench/client-core";
import {
  resolveSeatRemediationCommands,
  type SeatRemediationFinding,
} from "@infrawrench/plugin-base";
import { strictlyVisibleAccountIds } from "../cost/visibility-context";
import { getPlugin, pluginCodeAvailable } from "../plugin-loader";
import { GatewayOnlyError } from "../runtime/gateway-only";
import { getSeatSettings } from "./settings";
import { loadOrgSeats } from "./store";

export function seatRemediationFinding(
  seat: SeatView,
  finding: SeatFinding,
): SeatRemediationFinding {
  return {
    reason: finding.kind,
    seat: {
      memberId: seat.memberId,
      seatKey: seat.seatKey,
      email: seat.email,
      login: seat.login,
      name: seat.name,
      seatType: seat.seatType,
      targetSeatType: finding.targetSeatType ?? null,
      context: seat.context,
    },
  };
}

export interface ListSeatsOptions {
  /** Skip the cost-visibility narrowing: the poller and digest act org-wide. */
  unscoped?: boolean;
  /** Leave remediation off (the digest only needs totals). */
  withoutRemediation?: boolean;
  now?: number;
}

export async function listSeats(
  organizationId: string,
  opts: ListSeatsOptions = {},
): Promise<SeatListResponse> {
  const visible = opts.unscoped ? null : strictlyVisibleAccountIds(organizationId);
  const [settings, inventory] = await Promise.all([
    getSeatSettings(organizationId),
    loadOrgSeats(organizationId, visible),
  ]);
  const response = computeSeatFindings(inventory.rows, {
    inactiveDays: settings.inactiveDays,
    accounts: inventory.accounts,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  if (opts.withoutRemediation || response.findings.length === 0) return response;
  // The commands are plugin code, which the web edge Worker does not carry:
  // hand the read to the gateway rather than answer without them.
  if (!pluginCodeAvailable()) throw new GatewayOnlyError("seat remediation commands");

  const seatById = new Map(response.seats.map((s) => [s.id, s]));
  for (const finding of response.findings) {
    const seat = seatById.get(finding.seatId);
    if (!seat) continue;
    const plugin = (await getPlugin(seat.pluginId))?.plugin;
    finding.remediation = resolveSeatRemediationCommands(
      plugin,
      seatRemediationFinding(seat, finding),
    );
  }
  return response;
}
