"use server";

import { v4 as uuid } from "uuid";
import { randomBytes } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { users, invitations } from "@/db/schema";
import { requireAuth } from "@/auth/session";
import { logAudit } from "@/services/audit";

export interface TeamMember {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  createdAt: Date;
}

export interface InvitationSummary {
  id: string;
  email: string;
  role: string;
  acceptedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export async function listMembers(): Promise<TeamMember[]> {
  const session = await requireAuth();
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.organizationId, session.organizationId));
}

export async function listInvitations(): Promise<InvitationSummary[]> {
  const session = await requireAuth();
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.organizationId, session.organizationId));
}

export async function sendInvitation(input: {
  email: string;
  role: string;
}): Promise<{ id: string; token: string }> {
  const session = await requireAuth();
  const token = randomBytes(32).toString("base64url");
  const id = uuid();

  await db.insert(invitations).values({
    id,
    organizationId: session.organizationId,
    email: input.email,
    role: input.role,
    invitedByUserId: session.userId,
    token,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
  });

  void logAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    action: "member.invite",
    entityType: "member",
    entityId: id,
    metadata: { email: input.email, role: input.role },
  });

  return { id, token };
}

export async function removeMember(userId: string): Promise<void> {
  const session = await requireAuth();
  await db
    .delete(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, session.organizationId)));

  void logAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    action: "member.remove",
    entityType: "member",
    entityId: userId,
  });
}

export async function changeRole(userId: string, role: string): Promise<void> {
  const session = await requireAuth();
  await db
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.organizationId, session.organizationId)));

  void logAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    action: "member.role_change",
    entityType: "member",
    entityId: userId,
    metadata: { newRole: role },
  });
}

export async function revokeInvitation(invitationId: string): Promise<void> {
  const session = await requireAuth();
  await db
    .delete(invitations)
    .where(
      and(
        eq(invitations.id, invitationId),
        eq(invitations.organizationId, session.organizationId),
        isNull(invitations.acceptedAt),
      ),
    );
}
