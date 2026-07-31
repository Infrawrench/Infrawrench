import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchOrgChanges,
  summarizeChange,
  type Account,
  type ResourceChangeEntry,
  type ResourceChangeKind,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";
import { Chip, ChipRow } from "@/components/form";
import { colors, spacing } from "@/lib/theme";
import { ChangeDiffList, ChangeKindBadge } from "./ChangeParts";

/**
 * The org-wide change timeline — every resource the cloud poller saw appear,
 * change, or disappear, newest first. The native counterpart of
 * `@infrawrench/ui`'s `ChangesPanel` (web and desktop); the wire contract, the
 * reader and the wording all come from `@infrawrench/client-core`, so only the
 * markup is written twice.
 *
 * **Filters.** The endpoint takes `page`, `pageSize`, `kind`, `accountId`,
 * `from`, `to` and `resourceId`. Three of them are exposed here:
 *
 *  - **kind** and **account**, the two the web panel has — a phone shows five
 *    rows at a time, so narrowing matters more here, not less.
 *  - **a time window**, as presets rather than a range. `from`/`to` are a
 *    two-date picker on web; on a phone the useful questions are "today" and
 *    "this week", and the same parameter answers both without a calendar. A
 *    drift notification adds a fourth preset pinned to its own window.
 *
 * `resourceId` is deliberately not a filter here: one resource's slice is
 * reached by opening the resource, where `ResourceChangesCard` shows it. `to`
 * has no use without a full range picker — every preset ends at "now".
 *
 * Paging follows the audit log: `useInfiniteQuery` over the same
 * `{ entries, total }` envelope with a **Load more** button, plus
 * pull-to-refresh on the whole screen.
 */

const PAGE_SIZE = 25;

const KIND_OPTIONS: Array<{ value: ResourceChangeKind; label: string }> = [
  { value: "created", label: "Appeared" },
  { value: "updated", label: "Changed" },
  { value: "deleted", label: "Disappeared" },
];

/** Presets for the `from` parameter. `since` only exists on a drift deep link. */
type WindowKey = "all" | "24h" | "7d" | "30d" | "since";

const WINDOW_DAYS: Partial<Record<WindowKey, number>> = { "24h": 1, "7d": 7, "30d": 30 };

export interface ChangesScreenProps {
  /**
   * ISO timestamp from a `resource_drift` notification — the start of the
   * window the digest described. Present, the screen opens filtered to it.
   */
  since?: string | undefined;
  /** Account from the same notification, set only when the window was one account's. */
  accountId?: string | undefined;
}

export function ChangesScreen({ since, accountId: initialAccountId }: ChangesScreenProps) {
  const router = useRouter();
  const { api, orgId } = useOrgApi();

  const hasSince = !!since && !Number.isNaN(Date.parse(since));
  const [windowKey, setWindowKey] = useState<WindowKey>(hasSince ? "since" : "all");
  const [kind, setKind] = useState<ResourceChangeKind | null>(null);
  const [accountId, setAccountId] = useState<string | null>(initialAccountId ?? null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Computed once per window choice, not per render: `Date.now()` in the query
  // key would make every render a new key and refetch forever.
  const from = useMemo(() => {
    if (windowKey === "since") return hasSince ? since : undefined;
    const days = WINDOW_DAYS[windowKey];
    if (days === undefined) return undefined;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }, [windowKey, since, hasSince]);

  // Populates the account filter. A failure leaves the filter out entirely —
  // it is a convenience, and the feed works without it.
  const accounts = useQuery({
    queryKey: ["accounts", orgId],
    queryFn: () => api.org<Account[]>(orgId, "/accounts"),
  });

  const feed = useInfiniteQuery({
    queryKey: ["changes", orgId, kind, accountId, from ?? null],
    queryFn: ({ pageParam }) =>
      fetchOrgChanges(api, orgId, {
        page: pageParam,
        pageSize: PAGE_SIZE,
        ...(kind ? { kind } : {}),
        ...(accountId ? { accountId } : {}),
        ...(from ? { from } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, page) => n + page.entries.length, 0);
      return loaded < lastPage.total ? allPages.length + 1 : undefined;
    },
  });

  const windowOptions: Array<{ value: WindowKey; label: string }> = [
    ...(hasSince ? [{ value: "since" as const, label: "Since alert" }] : []),
    { value: "all", label: "Any time" },
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
  ];

  const accountList = accounts.data ?? [];
  const entries = feed.data?.pages.flatMap((page) => page.entries) ?? [];
  const total = feed.data?.pages[0]?.total ?? 0;

  const filters = (
    <View style={{ gap: spacing.sm }}>
      <ChipRow>
        {windowOptions.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={windowKey === option.value}
            onPress={() => setWindowKey(option.value)}
          />
        ))}
      </ChipRow>
      <ChipRow>
        <Chip label="All kinds" selected={kind === null} onPress={() => setKind(null)} />
        {KIND_OPTIONS.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={kind === option.value}
            onPress={() => setKind(option.value)}
          />
        ))}
      </ChipRow>
      {accountList.length > 1 && (
        <ChipRow>
          <Chip
            label="All accounts"
            selected={accountId === null}
            onPress={() => setAccountId(null)}
          />
          {accountList.map((account) => (
            <Chip
              key={account.id}
              label={account.displayName}
              selected={accountId === account.id}
              onPress={() => setAccountId(account.id)}
            />
          ))}
        </ChipRow>
      )}
      {windowKey === "since" && hasSince && (
        <Text style={styles.hint}>
          Showing what the drift alert covered — changes since {new Date(since).toLocaleString()}.
        </Text>
      )}
    </View>
  );

  if (feed.isLoading) return <LoadingView />;
  if (feed.isError) {
    return (
      <ErrorView
        message={
          feed.error instanceof Error ? feed.error.message : "Couldn't load the change feed."
        }
        onRetry={() => void feed.refetch()}
      />
    );
  }

  return (
    <Screen onRefresh={() => void feed.refetch()} refreshing={feed.isRefetching}>
      {filters}

      {entries.length === 0 ? (
        <EmptyView
          message={
            kind || accountId || from
              ? "No changes match these filters."
              : "No changes recorded yet. Events appear once the poller has synced your accounts at least twice."
          }
        />
      ) : (
        <Card list>
          {entries.map((entry) => (
            <ChangeEntryRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              onOpenResource={() =>
                router.push(
                  `/org/${orgId}/resources/${encodeURIComponent(entry.pluginId)}/${encodeURIComponent(entry.resourceTypeId)}/${encodeURIComponent(entry.resourceId)}?accountId=${encodeURIComponent(entry.accountId)}`,
                )
              }
            />
          ))}
        </Card>
      )}

      {feed.hasNextPage && (
        <Button
          label={feed.isFetchingNextPage ? "Loading…" : `Load more (${entries.length} of ${total})`}
          variant="secondary"
          disabled={feed.isFetchingNextPage}
          onPress={() => void feed.fetchNextPage()}
        />
      )}
    </Screen>
  );
}

/**
 * One event. Tapping opens it — the phone's stand-in for the web row's "Show
 * diff" link, since there is no room for a per-field diff and a summary on the
 * same line. The expanded body is the single-change detail view: the full
 * before → after list, the resource's identity, and the way through to it.
 */
function ChangeEntryRow({
  entry,
  expanded,
  onToggle,
  onOpenResource,
}: {
  entry: ResourceChangeEntry;
  expanded: boolean;
  onToggle: () => void;
  onOpenResource: () => void;
}) {
  const scope = [entry.accountName, `${entry.pluginId}/${entry.resourceTypeId}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceOverlay }]}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title} numberOfLines={1}>
            {entry.displayName}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {scope}
          </Text>
          <Text style={styles.summary} numberOfLines={1}>
            {new Date(entry.createdAt).toLocaleString()} · {summarizeChange(entry)}
          </Text>
        </View>
        <ChangeKindBadge kind={entry.changeKind} />
      </Pressable>
      {expanded && (
        <View style={styles.detail}>
          <ChangeDiffList entry={entry} />
          {entry.changeKind !== "updated" && (
            <Text style={styles.hint}>
              {entry.changeKind === "created"
                ? "This resource was not in the previous sync."
                : "The provider stopped returning this resource."}
            </Text>
          )}
          <Text style={styles.resourceId} numberOfLines={2}>
            {entry.resourceId}
          </Text>
          <Button label="Open resource" variant="secondary" onPress={onOpenResource} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  summary: { color: colors.textFaint, fontSize: 11 },
  detail: { gap: spacing.sm, paddingBottom: spacing.md },
  hint: { color: colors.textFaint, fontSize: 12 },
  resourceId: { color: colors.textFaint, fontSize: 11, fontFamily: "monospace" },
});
