/**
 * Which repository a comparison's head is in: the base repository itself, or
 * one of its forks the viewer can read. A fork's owner opens a pull request
 * to the parent by picking their fork here.
 */
import { useQuery } from "@tanstack/react-query";
import type { RepositorySummary } from "@infrawrench/git-contract";
import { queries } from "../api/queries";
import type { RepoRef } from "../lib/paths";
import { buttonClass } from "./Button";
import { Icon } from "./icons";
import { Picker } from "./Picker";

const keyOf = (repo: RepoRef): string => `${repo.owner}/${repo.repo}`.toLowerCase();

export interface HeadRepoPickerProps {
  /** The repository the comparison is into. */
  readonly base: RepoRef;
  /** The repository the head is in now. */
  readonly value: RepoRef;
  /** The fork picked, or null for the base repository itself. */
  readonly onSelect: (fork: RepositorySummary | null) => void;
}

/** Nothing while the base repository has no forks to pick and the head is its own. */
export function HeadRepoPicker({ base, value, onSelect }: HeadRepoPickerProps) {
  const forks = useQuery(queries.repositories.listForks({ params: base, query: { limit: 100 } }));
  const items = forks.data?.items ?? [];
  const own = keyOf(value) === keyOf(base);
  if (own && items.length === 0) return null;
  const options = [
    { value: keyOf(base), label: `${base.owner}/${base.repo}`, detail: "This repository" },
    ...items.map((fork) => ({
      value: keyOf({ owner: fork.owner.slug, repo: fork.name }),
      label: `${fork.owner.slug}/${fork.name}`,
      detail: "Fork",
    })),
  ];
  // A fork named in the URL that the list does not hold still shows as what is picked.
  if (!options.some((option) => option.value === keyOf(value))) {
    options.push({ value: keyOf(value), label: `${value.owner}/${value.repo}`, detail: "Fork" });
  }
  return (
    <Picker
      label="Head repository"
      options={options}
      selected={[keyOf(value)]}
      loading={forks.isLoading}
      onChange={([picked]) => {
        if (picked === undefined || picked === keyOf(value)) return;
        if (picked === keyOf(base)) return onSelect(null);
        const fork = items.find(
          (item) => keyOf({ owner: item.owner.slug, repo: item.name }) === picked,
        );
        if (fork !== undefined) onSelect(fork);
      }}
      trigger={({ props }) => (
        <button
          {...props}
          type="button"
          aria-haspopup="listbox"
          aria-label={`Switch head repository: ${value.owner}/${value.repo}`}
          className={buttonClass("secondary", "md", "max-w-64")}
        >
          <Icon name={own ? "book" : "gitFork"} />
          <span className="truncate">
            {value.owner}/{value.repo}
          </span>
          <Icon name="chevronDown" size={12} className="text-on-surface-muted" />
        </button>
      )}
    />
  );
}
