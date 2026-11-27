import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { IacManagedBy } from "@infrawrench/client-core";

export interface ManagedByAnnotationProps {
  /**
   * The Terraform workspaces on git.infrawrench.com whose state holds this
   * resource (`GET /iac/resource`, `managedBy`). A load that fails, or a
   * caller without `iac:read`, shows nothing.
   */
  load: () => Promise<IacManagedBy[]>;
  /** Opens a workspace's page on the forge: a new tab on web, the system browser on desktop. */
  onOpen: (url: string) => void;
}

/**
 * "Managed by acme/infra (network/prod)" on a resource page: which repository
 * and Terraform root manage the resource, each linking to its workspace on
 * git.infrawrench.com. Renders nothing for a resource no workspace manages.
 */
export function ManagedByAnnotation({ load, onOpen }: ManagedByAnnotationProps) {
  const gt = useGT();
  const [managedBy, setManagedBy] = useState<IacManagedBy[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (list) => {
        if (!cancelled) setManagedBy(list);
      },
      () => {
        if (!cancelled) setManagedBy([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is usually an inline arrow; loading once per mount is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!managedBy || managedBy.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-on-surface-secondary">{gt("Managed by")}</span>
      {managedBy.map((entry) => (
        <a
          key={`${entry.url}#${entry.address}`}
          href={entry.url}
          target="_blank"
          rel="noreferrer"
          title={gt("{address} in the workspace {workspace}", {
            address: entry.address,
            workspace: entry.workspace,
          })}
          onClick={(event) => {
            event.preventDefault();
            onOpen(entry.url);
          }}
          className="text-info hover:underline"
        >
          {entry.rootPath === ""
            ? gt("{repository} (repository root)", { repository: entry.repository })
            : gt("{repository} ({root})", { repository: entry.repository, root: entry.rootPath })}
        </a>
      ))}
    </div>
  );
}
