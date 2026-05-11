import { z } from "../zod";
import { strict, ErrorResponses, Uuid, Ok, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const CreateAccountRequest = strict({
  sshHost: z.string(),
  sshPort: z.number().int().min(1).max(65535),
  sshUser: z.string(),
  sshKeyId: Uuid,
  remoteHost: z.string(),
  remotePort: z.number().int().min(1).max(65535),
  pluginId: z.string(),
  displayName: z.string(),
  credentials: z.record(z.string()),
}).openapi("SshTunnelCreateAccountRequest");

const CreateAccountResponse = strict({ accountId: Uuid }).openapi("SshTunnelCreateAccountResponse");

const TunnelInfo = strict({
  localPort: z.number().int(),
  sshHost: z.string(),
  remotePort: z.number().int(),
}).openapi("ActiveTunnel");

const ExecRequest = strict({
  sshHost: z.string(),
  sshPort: z.number().int().min(1).max(65535),
  sshUser: z.string(),
  sshKeyId: Uuid,
  command: z.string(),
}).openapi("SshExecRequest");

const ExecResponse = strict({
  stdout: z.string(),
  stderr: z.string().optional(),
  code: z.number().int(),
}).openapi("SshExecResponse");

export function registerSshTunnelPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-tunnels/create-account",
    tags: ["SSH tunnels"],
    summary: "Create an account whose traffic is tunneled over SSH",
    description: "Verifies the SSH connection works before persisting.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CreateAccountRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Created",
        content: { "application/json": { schema: CreateAccountResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-tunnels/open",
    tags: ["SSH tunnels"],
    summary: "Re-open the tunnel for an existing account",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: strict({ accountId: Uuid }) } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Tunnel info",
        content: {
          "application/json": {
            schema: strict({ tunnelId: z.string(), localPort: z.number().int() }),
          },
        },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-tunnels/close",
    tags: ["SSH tunnels"],
    summary: "Close a tunnel by id",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: strict({ tunnelId: z.string() }) } },
        required: true,
      },
    },
    responses: { 200: { description: "Closed", content: { "application/json": { schema: Ok } } } },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/ssh-tunnels/active",
    tags: ["SSH tunnels"],
    summary: "List active tunnels for this org",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Map of tunnelId → info",
        content: { "application/json": { schema: z.record(TunnelInfo) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/ssh-tunnels/exec",
    tags: ["SSH tunnels"],
    summary: "Run a command over SSH using an org SSH key",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: ExecRequest } }, required: true },
    },
    responses: {
      200: {
        description: "Exec result",
        content: { "application/json": { schema: ExecResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });
}
