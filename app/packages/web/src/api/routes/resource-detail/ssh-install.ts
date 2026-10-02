import type { Hono } from "hono";
import { z } from "zod";
import { requirePermission } from "../../../auth/permissions";
import { listSshInstallAccounts, runSshInstall } from "../../../services/ssh-install";
import { checkChangeFreeze } from "../../../services/change-freezes";
import { logAudit } from "../../../services/audit";
import { HostKeyTrustRequiredError } from "../../../services/ssh-host-keys";
import { hostKeyTrustResponse } from "../ssh-host-keys";

export const sshInstallInputSchema = z
  .object({
    installerAccountId: z.string().min(1),
    target: z
      .object({
        accountId: z.string().min(1),
        resourceTypeId: z.string().min(1),
        resourceId: z.string().min(1),
      })
      .strict(),
    sshKeyId: z.string().min(1).optional(),
    username: z.string().min(1).max(64).optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

export function registerSshInstallRoutes(app: Hono) {
  app.get("/ssh-install/accounts", async (c) => {
    requirePermission(c, "resources:read");
    return c.json(await listSshInstallAccounts(c.get("organizationId")));
  });
  app.post("/ssh-install", async (c) => {
    requirePermission(c, "resources:write");
    requirePermission(c, "resources:execute");
    const parsed = sshInstallInputSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, 400);
    const input = parsed.data;
    const organizationId = c.get("organizationId");
    const metadata = {
      installerAccountId: input.installerAccountId,
      targetAccountId: input.target.accountId,
    };
    const frozen = await checkChangeFreeze(c, {
      action: "resource.ssh_install",
      entityType: "resource",
      entityId: input.target.resourceId,
      metadata,
    });
    if (frozen) return frozen;
    try {
      const result = await runSshInstall(organizationId, input);
      await logAudit({
        organizationId,
        userId: c.get("session").userId,
        action: "resource.ssh_install",
        entityType: "resource",
        entityId: input.target.resourceId,
        metadata: { ...metadata, success: true },
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof HostKeyTrustRequiredError) return hostKeyTrustResponse(c, error);
      await logAudit({
        organizationId,
        userId: c.get("session").userId,
        action: "resource.ssh_install",
        entityType: "resource",
        entityId: input.target.resourceId,
        metadata: { ...metadata, success: false },
      });
      return c.json(
        { error: error instanceof Error ? error.message : "SSH installation failed" },
        400,
      );
    }
  });
}
