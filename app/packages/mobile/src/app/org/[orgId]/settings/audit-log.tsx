import { useInfiniteQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";

/** Shape of GET /api/org/:orgId/audit-logs (web api/routes/audit.ts). */
interface AuditEntry {
  id: string;
  userId: string | null;
  apiKeyId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
  /** Null for a browser action, and for a key row that has since been deleted. */
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
}

/**
 * A key call is attributed to the key, not just to the person who minted it —
 * a key acts as its owner, so the owner's name alone cannot say whether a
 * human or a token was at the other end. Filtering by key is web/desktop only
 * (the phone has no key picker); reading which key it was belongs everywhere.
 */
function describeActor(e: AuditEntry): string {
  const owner = e.userName ?? e.userEmail;
  if (!e.apiKeyId) return owner ?? "system";
  const key = e.apiKeyName ?? "deleted key";
  const label = e.apiKeyPrefix ? `${key} (${e.apiKeyPrefix}…)` : key;
  return owner ? `key ${label} · ${owner}` : `key ${label}`;
}

interface AuditPage {
  entries: AuditEntry[];
  total: number;
}

const PAGE_SIZE = 25;

export default function AuditLogScreen() {
  const { api, orgId } = useOrgApi();

  const logs = useInfiniteQuery({
    queryKey: ["audit-logs", orgId],
    queryFn: async ({ pageParam }) => {
      const page = await api.org<AuditPage>(
        orgId,
        `/audit-logs?page=${pageParam}&pageSize=${PAGE_SIZE}`,
      );
      return page ?? { entries: [], total: 0 };
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.entries.length, 0);
      return loaded < lastPage.total ? allPages.length + 1 : undefined;
    },
  });

  if (logs.isLoading) return <LoadingView />;
  if (logs.isError) {
    return (
      <ErrorView
        message={logs.error instanceof Error ? logs.error.message : "Failed to load"}
        onRetry={() => void logs.refetch()}
      />
    );
  }

  const entries = logs.data?.pages.flatMap((p) => p.entries) ?? [];
  if (entries.length === 0) return <EmptyView message="No audit log entries yet." />;

  return (
    <Screen onRefresh={() => void logs.refetch()} refreshing={logs.isRefetching}>
      <Card list>
        {entries.map((e) => (
          <Row
            key={e.id}
            title={e.action}
            subtitle={`${e.entityType} · ${describeActor(e)} · ${new Date(e.createdAt).toLocaleString()}`}
          />
        ))}
      </Card>
      {logs.hasNextPage && (
        <Button
          label={logs.isFetchingNextPage ? "Loading…" : "Load more"}
          variant="secondary"
          disabled={logs.isFetchingNextPage}
          onPress={() => void logs.fetchNextPage()}
        />
      )}
    </Screen>
  );
}
