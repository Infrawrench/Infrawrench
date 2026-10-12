/**
 * The rule for "a flagged seat was acted on", kept free of the database so it
 * is tested on its own (`__tests__/seats-acted.test.ts`).
 */
import type { SeatFinding, SeatRow } from "@infrawrench/client-core";
import type { SeatRecord } from "@infrawrench/plugin-base";

function identity(memberId: string, seatKey: string): string {
  return `${memberId}\u0000${seatKey}`;
}

/**
 * Which previous findings the new snapshot shows were acted on. Pure, so the
 * rule is tested without a database.
 */
export function actedOnFindings(
  previous: readonly SeatRow[],
  previousFindings: readonly SeatFinding[],
  current: readonly SeatRecord[],
): Array<{ seat: SeatRow; finding: SeatFinding; action: "remove" | "downgrade" }> {
  const now = new Map(current.map((s) => [identity(s.memberId, s.seatKey ?? ""), s]));
  const byId = new Map(previous.map((s) => [s.id, s]));
  const out: Array<{ seat: SeatRow; finding: SeatFinding; action: "remove" | "downgrade" }> = [];
  for (const finding of previousFindings) {
    const seat = byId.get(finding.seatId);
    if (!seat) continue;
    const next = now.get(identity(seat.memberId, seat.seatKey));
    if (finding.kind === "downgrade") {
      if (next && seat.downgrade && next.seatType === seat.downgrade.seatType) {
        out.push({ seat, finding, action: "downgrade" });
      }
      continue;
    }
    if (!next || (next.pendingRemovalOn && !seat.pendingRemovalOn)) {
      out.push({ seat, finding, action: "remove" });
    }
  }
  return out;
}
