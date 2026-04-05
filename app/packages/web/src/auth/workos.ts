import { WorkOS } from "@workos-inc/node";

const apiKey = process.env["WORKOS_API_KEY"];
if (!apiKey) throw new Error("WORKOS_API_KEY environment variable is required");

export const workos = new WorkOS(apiKey);
export const clientId = process.env["WORKOS_CLIENT_ID"] ?? "";
