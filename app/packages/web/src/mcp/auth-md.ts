/**
 * `GET /auth.md` — the agent registration skill document.
 *
 * Served from our own origin rather than proxied from a vendor, because the
 * flow it describes is ours: we mint the credential, we own the claim ceremony,
 * and the trial semantics (24 hours, no card, zero AI budget) are product
 * decisions no generated document would know about.
 *
 * Written as instructions to an agent, in the imperative, with literal curl.
 * That is the format's whole point — an agent that finds this should be able to
 * act on it without a human translating, and without an SDK.
 */
import { Hono } from "hono";
import type { Context } from "hono";

import {
  CLAIM_CODE_TTL_MS,
  REGISTRATIONS_PER_IP_PER_HOUR,
} from "@infrawrench/server-core/trials/ceremony";
import { TRIAL_DURATION_MS } from "@infrawrench/server-core/trials/create";

function baseUrl(c: Context): string {
  const fromEnv = process.env["PUBLIC_BASE_URL"] ?? process.env["APP_URL"];
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  return `${proto ? `${proto}:` : u.protocol}//${u.host}`;
}

function authMarkdown(base: string): string {
  const trialHours = Math.round(TRIAL_DURATION_MS / 3_600_000);
  const codeMinutes = Math.round(CLAIM_CODE_TTL_MS / 60_000);

  return `# Infrawrench agent authentication

Infrawrench is a cloud infrastructure console. This document tells you how to
get credentials for it without a human having to create an account first.

## What you get, and what it costs your user

Registering opens a **trial workspace**: a real organization with every paid
feature enabled and no payment details required.

- It is **deleted ${trialHours} hours after it is created** unless a person claims it.
  Everything in it goes with it.
- It has a **zero AI budget**. Infrawrench's own chat agent will refuse to run.
  You are expected to bring your own model — you already have one.
- It can invite up to 3 people, and those invitations expire with the workspace.

Tell your user both of these things when you register. A workspace that
disappears overnight without warning is worse than no workspace.

## 1. Register

\`\`\`
curl -X POST ${base}/api/agent/identity \\
  -H 'Content-Type: application/json' \\
  -d '{"label": "a short name for this workspace"}'
\`\`\`

The response contains \`credential\` — an \`iwa_\` bearer token. **It is shown once
and cannot be recovered.** Store it before doing anything else.

\`\`\`json
{
  "registration_id": "...",
  "credential": "iwa_...",
  "organization_id": "...",
  "trial_expires_at": "2026-01-01T00:00:00.000Z",
  "claim_url": "${base}/claim"
}
\`\`\`

Registration is limited to ${REGISTRATIONS_PER_IP_PER_HOUR} workspaces per hour per address. A 429 means
you should claim the workspace you already have rather than open another.

## 2. Use the API

Send the credential as a bearer token:

\`\`\`
curl ${base}/api/org/<organization_id>/resources \\
  -H 'Authorization: Bearer iwa_...'
\`\`\`

The full API is described at ${base}/openapi.json. You may also connect to the
MCP endpoint at ${base}/api/mcp with the same credential.

You can do almost everything a member can. You cannot manage billing, mint API
keys, invite people, or revoke agent registrations — those need a person.

## 3. Ask to be claimed

Claiming binds the workspace to a real user account and stops the clock. Start
the ceremony whenever you like; sooner is better.

\`\`\`
curl -X POST ${base}/api/agent/identity/claim \\
  -H 'Authorization: Bearer iwa_...'
\`\`\`

\`\`\`json
{
  "user_code": "K7MP-2Q9X",
  "verification_uri": "${base}/claim",
  "expires_at": "...",
  "interval": 5
}
\`\`\`

Show your user **both** values in one message. For example:

> I've set up a workspace at ${base}/claim — open it, sign in, and enter the
> code K7MP-2Q9X to keep it. Without that it is deleted at 09:00 tomorrow.

Do not email the code and do not put it in a URL you log. It is a bearer secret
for ${codeMinutes} minutes: anyone who has it can take the workspace.

## 4. Poll until it is claimed

\`\`\`
curl ${base}/api/agent/identity -H 'Authorization: Bearer iwa_...'
\`\`\`

\`\`\`json
{ "claimed": false, "claim_pending": true, "trial_expires_in_ms": 84600000 }
\`\`\`

Poll no more often than the \`interval\` seconds returned above. When \`claimed\`
becomes true you are done — your credential does not change and keeps working.

\`trial_expires_in_ms\` is on every response, not just near the end. Use it to
remind your user before the deadline rather than after it.

## Errors

| Status | Meaning |
| --- | --- |
| 401 | The credential is wrong, or the registration was revoked by its owner. |
| 403 | You tried something agents may not do. The message names it. |
| 429 | Rate limited. Back off; do not retry in a loop. |

If your credential stops working after the workspace was claimed, a person
revoked it deliberately. Ask them, rather than registering again.
`;
}

const app = new Hono();

app.get("/auth.md", (c) =>
  c.text(authMarkdown(baseUrl(c)), 200, {
    "content-type": "text/markdown; charset=utf-8",
    // Short, because the document embeds live limits and the trial duration.
    "cache-control": "public, max-age=300",
  }),
);

export { app as authMdRoutes };
