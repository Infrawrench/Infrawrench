"use server";

import { requireAuth } from "@/auth/session";
import { createWsToken } from "@/services/ws-tokens";

export async function generateWsToken(): Promise<string> {
  const { userId, organizationId } = await requireAuth();
  return createWsToken(userId, organizationId);
}
