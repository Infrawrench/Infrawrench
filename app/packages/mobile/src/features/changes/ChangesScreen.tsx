import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import {
  chunkChangeImpactIds,
  collectChangeImpactResults,
  fetchChangeCostImpacts,
  fetchOrgChanges,
  formatChangeCostImpact,
  summarizeChange,
  type Account,
  type ChangeCostImpact,
  type ResourceChangeEntry,
  type ResourceChangeKind,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, ErrorView, LoadingView, Screen } from "@/components/ui";
import { ProviderIncidentNotice } from "@/components/ProviderIncidentNotice";
import { Chip, ChipRow } from "@/components/form";
import { colors, spacing } from "@/lib/theme";
import { ChangeDiffList, ChangeKindBadge } from "./ChangeParts";
import { RevertChangeSection } from "./RevertChangeSection";

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

  /**
   * Cost impact for the rows on screen — "what did this change do to the run
   * rate?". Deliberately its own query rather than part of the feed: a member
   * without `costs:read` still gets the feed, they just get no cost line.
   *
   * **Every loaded row is covered, not just the first request's worth.** The
   * endpoint caps a batch at `MAX_CHANGE_IMPACT_BATCH`, and this screen scrolls
   * infinitely, so the ids are chunked (`chunkChangeImpactIds`) and one query is
   * keyed per chunk. Truncating instead would leave every row past the cap with
   * no cost line — which reads as "no cost data for this resource" and is the
   * silent omission the whole feature exists to avoid.
   *
   * Chunks are cut from the start of the list, so loading another page leaves
   * the earlier chunks' keys unchanged and only the new chunk is fetched.
   * Nothing is cached server-side (the answer is recomputed as provider cost
   * arrives), so a refetch is always the current answer.
   *
   * **A failed chunk is unresolved, not blank.** The stable keys that make
   * appending cheap are also what would make a failure stick, and blank already
   * means "no measurable impact" here — so a transient error would quietly
   * become a confident, wrong claim about the bill. Three things prevent that:
   * these queries take the app-wide `retry` from `_layout.tsx` rather than
   * opting out of it, pull-to-refresh refetches them alongside the feed, and
   * whatever is still unanswered renders as unavailable
   * (`collectChangeImpactResults`).
   */
  const impactChunks = useMemo(
    () => chunkChangeImpactIds(entries.map((e) => e.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `entries` is a
    // fresh array each render; the ids are what actually change.
    [entries.map((e) => e.id).join(",")],
  );
  const impactQueries = useQueries({
    queries: impactChunks.map((changeIds) => ({
      queryKey: ["change-cost-impacts", orgId, changeIds],
      queryFn: () => fetchChangeCostImpacts(api, orgId, { changeIds }),
      // No `retry: false` here on purpose. The cards that do opt out are whole
      // optional sections, and a section that quietly does not appear costs the
      // reader nothing; a blank *inside* a row that is on screen is a claim.
    })),
  });
  const { impacts, unresolved: unresolvedImpacts } = useMemo(
    () => collectChangeImpactResults(impactChunks, impactQueries),
    [impactChunks, impactQueries],
  );

  const refresh = async () => {
    // The impact queries have their own stable keys, so refetching the feed
    // alone would leave a failed chunk failed forever. This is the user's
    // recovery path and it has to cover both.
    await Promise.all([feed.refetch(), ...impactQueries.map((q) => q.refetch())]);
  };

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
    <Screen onRefresh={() => void refresh()} refreshing={feed.isRefetching}>
      <ProviderIncidentNotice showResolvedCorrelation />

      <Button
        label="Investigate a moment"
        variant="secondary"
        onPress={() => router.push(`/org/${orgId}/moment`)}
      />

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
              impact={impacts[entry.id]}
              impactUnavailable={unresolvedImpacts.has(entry.id)}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              onReverted={() => void feed.refetch()}
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
  impact,
  impactUnavailable,
  expanded,
  onToggle,
  onOpenResource,
  onReverted,
}: {
  entry: ResourceChangeEntry;
  impact?: ChangeCostImpact | undefined;
  /**
   * The cost lookup for this row **failed**. Distinct from having no impact:
   * blank means "we looked and there is nothing measurable to say", so a failed
   * lookup has to say something else or it becomes a claim we never made.
   */
  impactUnavailable?: boolean | undefined;
  expanded: boolean;
  onToggle: () => void;
  onOpenResource: () => void;
  onReverted: () => void;
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
          {/* Null when there is nothing measured to say — never a "$0" line
              beside a resource that was never billable in the first place. */}
          {impact && formatChangeCostImpact(impact) && (
            <Text style={styles.costImpact} numberOfLines={1}>
              {formatChangeCostImpact(impact)}
            </Text>
          )}
          {/* Said out loud rather than left blank: blank is already an answer
              here, and a network blip must not borrow it. Pull to refresh. */}
          {!impact && impactUnavailable && (
            <Text style={styles.costUnavailable} numberOfLines={1}>
              Cost impact unavailable — pull to refresh
            </Text>
          )}
        </View>
        <ChangeKindBadge kind={entry.changeKind} />
      </Pressable>
      {expanded && (
        <View style={styles.detail}>
          <ChangeDiffList entry={entry} />
          {impact && (
            <Text style={styles.hint}>{formatChangeCostImpact(impact, { verbose: true })}</Text>
          )}
          {!impact && impactUnavailable && (
            <Text style={styles.hint}>
              The cost impact for this change could not be loaded. Pull down to try again — this is
              a failed lookup, not a finding that it cost nothing.
            </Text>
          )}
          {entry.origin === "schedule" && (
            <Text style={styles.hint}>Executed by a sleep/wake schedule.</Text>
          )}
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
          {/* Only on `updated` rows: the two hints above already say why a
              creation or a disappearance has no undo, and repeating it under a
              dead button would be the same sentence twice. */}
          {entry.changeKind === "updated" && (
            <RevertChangeSection entry={entry} onReverted={onReverted} />
          )}
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
  costImpact: { color: colors.textMuted, fontSize: 11 },
  costUnavailable: { color: colors.textFaint, fontSize: 11, fontStyle: "italic" },
  detail: { gap: spacing.sm, paddingBottom: spacing.md },
  hint: { color: colors.textFaint, fontSize: 12 },
  resourceId: { color: colors.textFaint, fontSize: 11, fontFamily: "monospace" },
});
