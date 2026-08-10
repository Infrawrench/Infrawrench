/**
 * Route for break-glass access requests. Lives under settings to match web's
 * `/org/:orgId/settings/access-requests`, and is where an `access_request`
 * push deep-links (with `?requestId=` so the screen can surface that request
 * first).
 */
export { default } from "@/features/access/AccessRequestsScreen";
