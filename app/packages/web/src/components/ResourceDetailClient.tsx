"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { DetailView, type QueryResult, type ChildResource } from "@infrawrench/ui";
import type { DetailViewSchema } from "@infrawrench/plugin-base";

interface ChildResourceData {
  id: string;
  displayName: string;
  resourceTypeId: string;
  pluginId: string;
  accountId: string;
}

interface Props {
  detailSchema: DetailViewSchema;
  childResources: ChildResourceData[];
  pluginId: string;
  pluginLogoSvg: string;
  resourceId: string;
}

export function ResourceDetailClient({
  detailSchema,
  childResources,
  pluginId,
  pluginLogoSvg,
  resourceId,
}: Props) {
  const router = useRouter();

  // SQL queries are not yet supported on web -- placeholder
  const handleRunQuery = useCallback(
    async (_sql: string): Promise<QueryResult> => {
      return { rows: [], durationMs: 0 };
    },
    [],
  );

  const handleChildClick = useCallback(
    (child: ChildResource) => {
      router.push(
        `/resources/${child.pluginId}/${child.resourceTypeId}/${encodeURIComponent(child.id)}`,
      );
    },
    [router],
  );

  return (
    <div className="p-6 h-full">
      <DetailView
        schema={detailSchema}
        resourceId={resourceId}
        pluginLogoSvg={pluginLogoSvg}
        onRunQuery={handleRunQuery}
        onChildClick={handleChildClick}
      />
    </div>
  );
}
