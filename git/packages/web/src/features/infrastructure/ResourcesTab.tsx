import { useState } from "react";
import { api } from "../../api/client";
import { usePages } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Segmented } from "../../components/controls";
import { SearchInput } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel, Table, Td, Th, Tr } from "../../components/Panel";
import { EmptyState, ErrorState, Loading, LoadMore } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { formatMoney } from "../../lib/amounts";
import type { TerraformManagedResource } from "@infrawrench/git-contract";
import { useWorkspace } from "./WorkspaceLayout";
import { cursorQuery } from "../../lib/cursor";

type Matched = "all" | "true" | "false";

const DRIFT = {
  in_sync: null,
  drifted: { tone: "warning", label: "Drifted" },
  missing: { tone: "danger", label: "Missing" },
} as const;

/**
 * The line an empty list shows. The list is written after a state is saved
 * (the app matches its resources to the organisation's), so for a while a
 * state that has resources lists none, and saying it has none would be wrong.
 */
export function emptyResourcesLine(filtered: boolean, resourceCount: number): string {
  if (filtered) return "No resources match";
  return resourceCount > 0
    ? "The resources of the current state are not listed yet"
    : "The state has no resources";
}

export function ResourcesTab() {
  const repo = useRepoRef();
  const workspace = useWorkspace();
  const [words, setWords] = useState("");
  const [matched, setMatched] = useState<Matched>("all");
  const filter = {
    ...(words.trim() === "" ? {} : { q: words.trim() }),
    ...(matched === "all" ? {} : { matched }),
  };
  const request = { params: { ...repo, workspace: workspace.name } };
  const resources = usePages(["terraform", "listResources", request, filter], (cursor) =>
    api.terraform.listResources({
      ...request,
      query: { ...filter, ...cursorQuery(cursor), limit: 50 },
    }),
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Filter resources"
          placeholder="Address or type"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          className="min-w-48 flex-1 sm:max-w-xs"
        />
        <Segmented<Matched>
          label="Matched to Infrawrench"
          value={matched}
          onChange={setMatched}
          options={[
            { value: "all", label: "All" },
            { value: "true", label: "Matched" },
            { value: "false", label: "Unmatched" },
          ]}
        />
      </div>
      <Panel>
        {resources.error ? (
          <ErrorState error={resources.error} />
        ) : resources.isLoading ? (
          <Loading />
        ) : resources.items.length === 0 ? (
          <EmptyState>
            {emptyResourcesLine(words.trim() !== "" || matched !== "all", workspace.resourceCount)}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <Table caption="Managed resources">
              <thead>
                <tr>
                  <Th>Address</Th>
                  <Th>Infrawrench resource</Th>
                  <Th className="text-right">Monthly cost</Th>
                </tr>
              </thead>
              <tbody>
                {resources.items.map((resource) => {
                  const drift = resource.drift === null ? null : DRIFT[resource.drift];
                  return (
                    <Tr key={resource.address}>
                      <Td>
                        <div className="font-mono text-on-surface [overflow-wrap:anywhere]">
                          {resource.module !== null ? (
                            <span className="text-on-surface-muted">{resource.module}.</span>
                          ) : null}
                          {resource.module !== null
                            ? resource.address.slice(resource.module.length + 1)
                            : resource.address}
                        </div>
                        {resource.mode === "data" ? (
                          <Badge tone="outline">Data source</Badge>
                        ) : null}
                      </Td>
                      <Td>
                        {resource.infrawrench === null ? (
                          <span className="text-on-surface-muted">
                            {resource.mode === "data" ? "" : "Not matched"}
                          </span>
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <a
                              href={resource.infrawrench.appUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 font-medium text-on-surface hover:underline"
                            >
                              {resource.infrawrench.name}
                              <Icon
                                name="externalLink"
                                size={11}
                                className="text-on-surface-muted"
                              />
                            </a>
                            <span className="text-on-surface-muted">
                              {resource.infrawrench.resourceTypeId}
                            </span>
                            {drift ? <Badge tone={drift.tone}>{drift.label}</Badge> : null}
                          </span>
                        )}
                      </Td>
                      <Td className="text-right font-mono">
                        {resource.monthlyCost === null
                          ? ""
                          : formatMoney(resource.monthlyCost.amount, resource.monthlyCost.currency)}
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}
      </Panel>
      <LoadMore pages={resources} />
    </div>
  );
}
