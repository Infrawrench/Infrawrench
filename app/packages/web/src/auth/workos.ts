import { WorkOS } from "@workos-inc/node";

const apiKey = process.env["WORKOS_API_KEY"];
if (!apiKey) throw new Error("WORKOS_API_KEY environment variable is required");

const clientIdEnv = process.env["WORKOS_CLIENT_ID"];
if (!clientIdEnv) throw new Error("WORKOS_CLIENT_ID environment variable is required");

export const clientId = clientIdEnv;
export const workos = new WorkOS({ apiKey, clientId });
