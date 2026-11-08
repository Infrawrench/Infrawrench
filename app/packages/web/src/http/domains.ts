/**
 * Every API domain served by HttpApi. One line per domain; the server, the
 * spec builder and the route-shadowing test all read this list.
 *
 * A request no domain matches falls through to the legacy Hono app, so a
 * domain moves here by deleting its Hono routes in the same change.
 */
import type { Domain } from "./domain";
import { budgetsDomain } from "./domains/budgets";

export const DOMAINS: readonly Domain[] = [budgetsDomain];
