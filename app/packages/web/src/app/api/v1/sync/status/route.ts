import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, resources, dashboards, dashboardPins, associations } from "@/db/schema";
import { authenticateApiRequest } from "@/auth/api-auth";

export async function GET(request: Request) {
  const auth = await authenticateApiRequest(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgId = auth.organizationId;

  const [maxVersions] = await db
    .select({
      accounts: sql<number>`COALESCE(MAX(${accounts.syncVersion}), 0)`,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));

  const [resourceVersions] = await db
    .select({
      resources: sql<number>`COALESCE(MAX(${resources.syncVersion}), 0)`,
    })
    .from(resources)
    .where(eq(resources.organizationId, orgId));

  const maxSyncVersion = Math.max(
    maxVersions?.accounts ?? 0,
    resourceVersions?.resources ?? 0,
  );

  return NextResponse.json({ maxSyncVersion });
}
