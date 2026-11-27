/**
 * Where a person's own repositories run CI and review agents: one of their
 * organisations, or none. The choice is asked with the username and kept in
 * Settings > Profile; both read their options here.
 */
import type { SessionData } from "./session";

export type RunsInOption = Pick<SessionData["organizations"][number], "id" | "name" | "paid">;

/** The `<select>` value for "None". An organisation's id is never empty. */
export const RUNS_IN_NONE = "none";

/**
 * What the question starts on: the organisation on a paid plan when exactly
 * one of the person's is, since CI runs nowhere else. With none or several,
 * nothing: the person says.
 */
export const preselectedRunsIn = (organizations: readonly RunsInOption[]): string | null => {
  const paid = organizations.filter((organization) => organization.paid);
  return paid.length === 1 ? paid[0]!.id : null;
};

/** A `<select>` value as the API takes it: an organisation's id, or null for none. */
export const runsInOrganizationId = (value: string): string | null =>
  value === RUNS_IN_NONE ? null : value;

/** Said under the control when the chosen organisation cannot run CI yet. */
export const runsInHint = (
  organizations: readonly RunsInOption[],
  value: string | null,
): string | null => {
  const chosen = organizations.find((organization) => organization.id === value);
  return chosen !== undefined && !chosen.paid ? "CI needs a paid plan there" : null;
};
