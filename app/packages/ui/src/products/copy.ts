import { useMemo } from "react";
import { useGT } from "gt-react";
import type { ProductId } from "./registry.js";

export interface ProductCopy {
  name: string;
  /** One line, shown on the Home card. */
  tagline: string;
}

/**
 * The translated copy for every product. A hook rather than data because
 * every string here is a `gt("literal")`: the gt CLI extracts literals only,
 * so the copy cannot live in `registry.ts` and be passed through a variable.
 */
export function useProductCopy(): Record<ProductId, ProductCopy> {
  const gt = useGT();
  return useMemo(
    () => ({
      infrastructure: {
        name: gt("Infrastructure"),
        tagline: gt("Everything you run, across every provider, in one inventory."),
      },
      costs: {
        name: gt("Costs"),
        tagline: gt("See what you spend, why it moved, and where to cut it."),
      },
      observability: {
        name: gt("Observability"),
        tagline: gt("Logs, metrics, uptime and objectives for what you run."),
      },
      incidents: {
        name: gt("Incident response"),
        tagline: gt("Declare it, run it, tell people, and learn from it."),
      },
      security: {
        name: gt("Security"),
        tagline: gt("Find what is exposed, prove what is covered, control who gets in."),
      },
      delivery: {
        name: gt("Delivery"),
        tagline: gt("Build, ship and measure every change."),
      },
      automation: {
        name: gt("Automation"),
        tagline: gt("Hand work to agents and workflows."),
      },
    }),
    [gt],
  );
}

/**
 * One line per org tool, keyed by the tool's `key`. A tool with no entry
 * still shows on its product's page, with its name only.
 */
export function useToolDescriptions(): Record<string, string> {
  const gt = useGT();
  return useMemo(
    () => ({
      graph: gt("How your resources are wired together, and what depends on what."),
      services: gt("Resources grouped into the services you run, graded against your own bar."),
      changes: gt("Every resource that appeared, changed or disappeared."),
      iac: gt("What Terraform manages, what drifted and what it does not know about."),
      "resource-reports": gt("Saved tables of resources with the columns you choose."),
      dns: gt("Every DNS zone and record, with takeover risks flagged."),
      quotas: gt("How close each account is to its provider limits."),
      "ssh-fanout": gt("One command across many hosts, with the odd one out diffed."),
      costs: gt("Graphs, budgets and savings for your cloud spend."),
      "cost-reports": gt("Cost graphs saved by name."),
      "cost-canvases": gt("Cost reports the assistant builds from a description."),
      "k8s-efficiency": gt("How much of your clusters' cost bought capacity you used."),
      invoices: gt("Invoices for the cloud spend you bill on to customers."),
      "price-catalog": gt("Instance types and list prices compared across providers."),
      logs: gt("Logs from several resources in one searchable pane."),
      "metric-alerts": gt("Threshold rules on the metrics we collect."),
      probes: gt("Uptime and latency checks from outside your infrastructure."),
      slos: gt("Objectives, error budgets and burn-rate alerts."),
      "query-monitors": gt("Scheduled SQL queries with a threshold and an alert."),
      wallboard: gt("Everything that is wrong right now, readable from across the room."),
      incidents: gt("Declare an incident, follow its timeline and write the postmortem."),
      "status-pages": gt("Public pages that show the state of your probes."),
      runbooks: gt("Checklists you run step by step."),
      calendar: gt("Freezes, expiries, scheduled runs and incidents on one calendar."),
      posture: gt("Security checks across your accounts, ranked by severity."),
      vulnerabilities: gt("Known vulnerabilities, next to what is running them."),
      compliance: gt("Controls, the evidence for them and the gaps."),
      "access-review": gt("Who has access to what, with stale and unowned access flagged."),
      "jit-access": gt("Roles granted for a set time, with an approver."),
      expiring: gt("Certificates, domains, tokens and passwords that are running out."),
      backups: gt("What is recoverable, and how old the newest backup is."),
      deploy: gt("Deploy your repositories and see what shipped."),
      ci: gt("Pipelines on every push and pull request."),
      delivery: gt("How often, how fast and how safely you ship."),
      environments: gt("Short-lived copies of an environment, made from a template."),
      "environment-diff": gt("Two accounts compared side by side."),
      agents: gt("Coding agents running on cloud machines."),
      workflows: gt("Scripts that act across all your accounts."),
    }),
    [gt],
  );
}
