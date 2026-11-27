import { useGT } from "gt-react";
import { GIT_FORGE_LIMITS } from "@infrawrench/client-core";

const GIB = 1024 ** 3;

/** What each plan says about Infrawrench CI and git.infrawrench.com, as list lines. */
export interface PlanFeatureLines {
  /** What the free plan includes. */
  free: string[];
  /** What the free plan leaves out, said where the free plan is described. */
  freeWithout: string[];
  /** What Pro adds. */
  pro: string[];
}

/**
 * The CI and Git lines of the free and Pro plans, for every place the two
 * are set side by side (the plan choice after creating an organization, and
 * Settings > Billing on web and desktop). The numbers are `GIT_FORGE_LIMITS`,
 * the ones the forge enforces, so a changed limit changes these lines; the
 * docs' plan table (`team-and-billing/billing-and-plans.md`) says the same.
 */
export function usePlanFeatureLines(): PlanFeatureLines {
  const gt = useGT();
  const { free, paid } = GIT_FORGE_LIMITS;
  const gib = (bytes: number) => String(bytes / GIB);
  return {
    free: [
      gt("git.infrawrench.com: public repositories, plus {count} private (up to {size} GiB)", {
        count: String(free.privateRepositories ?? 0),
        size: gib(free.privateStorageBytes),
      }),
      gt("Review agents, from the same AI allowance"),
    ],
    freeWithout: [gt("Infrawrench CI is part of Pro")],
    pro: [
      gt("Infrawrench CI, billed by usage"),
      paid.privateRepositories === null
        ? gt(
            "git.infrawrench.com: your organization's name, unlimited private repositories, {size} GiB included",
            { size: gib(paid.includedStorageBytes) },
          )
        : gt(
            "git.infrawrench.com: your organization's name, {count} private repositories, {size} GiB included",
            { count: String(paid.privateRepositories), size: gib(paid.includedStorageBytes) },
          ),
      gt("Review agents, billed with your AI usage"),
    ],
  };
}
