import { z } from "../zod";
import { strict, OrgIdParam } from "../common";
import type { BuildContext } from "../index";

export function registerWsTokenPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ws-token",
    tags: ["WebSocket"],
    summary: "Mint a short-lived token for the WebSocket gateway",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Token",
        content: { "application/json": { schema: strict({ token: z.string() }) } },
      },
    },
  });
}
