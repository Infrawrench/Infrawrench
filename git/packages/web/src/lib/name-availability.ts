/**
 * Whether a repository may take a name, for the forms that say so while the
 * name is typed: the name rules here, then the API's answer for the name once
 * typing stops (`repositoryLists.nameAvailability` for a new repository,
 * `repositories.renameAvailability` for a rename).
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  REPOSITORY_NAME_MAX_LENGTH,
  nameProblemMessage,
  repositoryNameProblem,
  type RepositoryNameAvailability,
} from "@infrawrench/git-contract";
import { queries } from "../api/queries";
import type { RepoRef } from "./paths";

/** `value`, a moment after it stops changing. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface NameAvailability {
  /**
   * `same` is the repository's own name, in any case. `unknown` is a check
   * that failed: the form may still submit, and the server decides.
   */
  readonly state: "empty" | "invalid" | "same" | "checking" | "taken" | "available" | "unknown";
  /** Why not, for `invalid` and `taken`. */
  readonly message: string | null;
}

export function deriveNameAvailability(input: {
  readonly name: string;
  /** The name the last answer was asked for. */
  readonly settled: string;
  /** The repository's name now, when this is a rename. */
  readonly current?: string | undefined;
  readonly answer: RepositoryNameAvailability | undefined;
  readonly failed: boolean;
}): NameAvailability {
  const { name, settled, current, answer, failed } = input;
  if (name === "") return { state: "empty", message: null };
  const problem = repositoryNameProblem(name);
  if (problem !== null) {
    return { state: "invalid", message: nameProblemMessage(problem, REPOSITORY_NAME_MAX_LENGTH) };
  }
  if (current !== undefined && name.toLowerCase() === current.toLowerCase()) {
    return { state: "same", message: null };
  }
  if (name !== settled) return { state: "checking", message: null };
  if (answer !== undefined && answer.name === name) {
    if (answer.available) return { state: "available", message: null };
    return { state: answer.reason === "taken" ? "taken" : "invalid", message: answer.message };
  }
  return failed ? { state: "unknown", message: null } : { state: "checking", message: null };
}

/** Whether a form holding this answer may submit. */
export const mayUseName = (availability: NameAvailability): boolean =>
  availability.state === "available" || availability.state === "unknown";

const worthAsking = (name: string, current?: string): boolean =>
  name !== "" &&
  repositoryNameProblem(name) === null &&
  (current === undefined || name.toLowerCase() !== current.toLowerCase());

/** A new repository's name in `namespace`, which the caller may create in. */
export function useNewNameAvailability(namespace: string, name: string): NameAvailability {
  const settled = useDebounced(name, 300);
  const lookup = useQuery({
    ...queries.repositoryLists.nameAvailability({
      params: { namespace },
      query: { name: settled },
    }),
    enabled: worthAsking(settled),
    retry: false,
    staleTime: 0,
  });
  return deriveNameAvailability({
    name,
    settled,
    answer: lookup.data,
    failed: lookup.isError,
  });
}

/** Another name for the repository at `repo`, whose name is `current`. */
export function useRenameAvailability(
  repo: RepoRef,
  current: string,
  name: string,
): NameAvailability {
  const settled = useDebounced(name, 300);
  const lookup = useQuery({
    ...queries.repositories.renameAvailability({ params: repo, query: { name: settled } }),
    enabled: worthAsking(settled, current),
    retry: false,
    staleTime: 0,
  });
  return deriveNameAvailability({
    name,
    settled,
    current,
    answer: lookup.data,
    failed: lookup.isError,
  });
}
