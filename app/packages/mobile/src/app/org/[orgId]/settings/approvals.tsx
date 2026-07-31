/**
 * Route for the org-wide approvals inbox. Lives under settings to match web's
 * `/org/:orgId/settings/approvals`, and is where a `workflow_approval` push
 * deep-links (with `?approvalId=` so the inbox can surface that request first).
 */
export { default } from "@/features/approvals/ApprovalsScreen";
