/**
 * The WorkOS client, for handlers, loaded on first use rather than at import.
 *
 * `auth/workos.ts` throws at import without `WORKOS_API_KEY`, and every domain
 * in `./domains.ts` is loaded by the spec build and its scripts
 * (`generate:openapi`, `spec-diff`), which run with no secrets set. A domain
 * that imported it, or a service that does (`auth/step-up.ts`,
 * `services/account-deletion.ts`), statically would make documenting the API
 * need a WorkOS key. Route tests' `vi.mock("@/auth/workos")` still applies.
 */
import { legacy } from "./legacy";

export const workosClient = legacy(() => import("../auth/workos"));
