/**
 * The directory hook: start an offboarding when the organization's identity
 * directory says someone has gone.
 *
 * Nothing in the repository receives directory events yet (enterprise SSO and
 * directory sync are separate, unmerged work). This is the one function that
 * work calls when a deprovision event arrives (a SCIM `DELETE /Users/{id}`
 * or `active: false`, a WorkOS `dsync.user.deleted` or a `dsync.user.updated`
 * whose state left `active`), so the receiving end needs no knowledge of
 * offboarding beyond an email address and the organization it belongs to.
 *
 * It is idempotent per person: a second event for somebody already being
 * offboarded lands on the open checklist (merging any handles the directory
 * knows them by), so a directory that retries its deliveries does not stack
 * up duplicate checklists.
 */
import { randomUUID as uuid } from "node:crypto";
import { db } from "../db/client";
import { auditLogs } from "../db/schema";
import { startOffboarding } from "./store";

export interface DirectoryDeprovisionEvent {
  /** The departed person's primary email, as the directory reports it. */
  email: string;
  /** Other names the directory knows them by (a username, a secondary email). */
  handles?: readonly string[];
  /** The directory or connection it came from, in a phrase ("Okta via SCIM"). */
  directoryName?: string | null;
  /** The provider's event or user id, recorded for the audit trail. */
  eventId?: string | null;
}

export async function startOffboardingFromDirectory(
  organizationId: string,
  event: DirectoryDeprovisionEvent,
): Promise<{ offboardingId: string; created: boolean }> {
  const sourceDetail = event.directoryName ?? "Directory sync";
  const { offboarding, created } = await startOffboarding(
    organizationId,
    {
      email: event.email,
      aliases: event.handles ?? [],
      source: "directory",
      sourceDetail,
    },
    null,
  );
  // Written directly rather than through the web's `logAudit`: the caller is
  // a webhook or a poller pass, with no request principal to attribute it to.
  await db.insert(auditLogs).values({
    id: uuid(),
    organizationId,
    userId: null,
    action: "offboarding.started",
    entityType: "offboarding",
    entityId: offboarding.id,
    metadata: {
      email: offboarding.email,
      source: "directory",
      directory: sourceDetail,
      eventId: event.eventId ?? null,
      created,
      items: offboarding.progress.total,
    },
  });
  return { offboardingId: offboarding.id, created };
}
