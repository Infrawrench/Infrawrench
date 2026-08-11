/**
 * Turning a live participant list into the recording's attribution column.
 *
 * Pure, and separate from the hub, because this is the part a reader of a tape
 * six months from now depends on and it should be possible to check it without
 * a socket. The one judgement it makes is which role to write down for
 * somebody who both observed and drove: the **higher** one. A person who held
 * the keyboard for ten seconds of a two-hour session is a driver of that
 * session, and an attribution that quietly downgraded them to "observer"
 * because they gave it back would be worse than no attribution at all.
 */
import type { RecordingParticipant } from "@infrawrench/server-core/ssh-recording/recorder";
import type { ParticipantRow } from "@infrawrench/server-core/shared-console/store";

export function recordingParticipantsOf(
  participants: readonly ParticipantRow[],
  previous: readonly RecordingParticipant[] = [],
): RecordingParticipant[] {
  const seen = new Map<string, RecordingParticipant>();
  for (const entry of previous) {
    if (entry.userId) seen.set(entry.userId, entry);
  }
  for (const p of participants) {
    const before = seen.get(p.userId);
    seen.set(p.userId, {
      userId: p.userId,
      userName: p.userName,
      // Highest role held, not current role — see the note above.
      role: before?.role === "driver" || p.role === "driver" ? "driver" : "observer",
      joinedAt: (before ? new Date(before.joinedAt) : p.joinedAt).toISOString(),
      leftAt: p.leftAt ? p.leftAt.toISOString() : null,
    });
  }
  return [...seen.values()];
}
