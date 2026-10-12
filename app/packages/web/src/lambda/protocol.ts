/**
 * The contract between the edge Worker and the Lambda gateway, shared by both
 * so neither can drift. Kept free of imports: the Worker loads it at startup.
 */

/**
 * Carries `LAMBDA_GATEWAY_SECRET` from the Worker to the Lambda. The function
 * URL is public (`AuthType NONE`, because a Worker cannot sign SigV4 without
 * shipping AWS credentials to it), so this is what makes "this came through
 * the edge" a fact. The Lambda refuses every request without it, and trusts
 * `x-forwarded-host` only behind it.
 */
export const GATEWAY_SECRET_HEADER = "x-iw-gateway-secret";

/**
 * Set by the Lambda, with status 421, on a request it did not complete because
 * the work needs the long-lived session gateway (a bastion agent connection,
 * a session-only route). It has written nothing when it answers this way, so
 * the Worker replays its copy of the request there. The value is the reason,
 * for logs.
 */
export const SESSION_HANDOFF_HEADER = "x-iw-session-handoff";

/**
 * The largest request body the Worker sends to the Lambda. A function URL
 * accepts 6 MB of event, and a binary body arrives base64-encoded (a third
 * bigger), so anything over this goes straight to the session gateway; it is
 * also small enough for the Worker to keep a copy for the replay above.
 */
export const LAMBDA_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
