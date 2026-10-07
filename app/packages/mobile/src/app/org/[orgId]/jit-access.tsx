/**
 * Just-in-time access: request a cloud role under a policy, and approve or
 * deny colleagues' requests. A `jit_access_request` push deep-links here with
 * `?requestId=` (and `&action=approve|deny` from the notification buttons).
 */
export { default } from "@/features/jit-access/JitAccessScreen";
