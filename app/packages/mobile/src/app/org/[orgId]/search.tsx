import { useEffect, useState } from "react";
import { StyleSheet, TextInput } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, LoadingView, Row, Screen } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

interface SearchResult {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  accountName?: string;
  resourceTypeLabel?: string;
}

export default function SearchScreen() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const [query, setQuery] = useState("");
  // Debounced so typing doesn't fire a request per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  const results = useQuery({
    queryKey: ["search", orgId, debouncedQuery],
    queryFn: () =>
      api.org<{ results: SearchResult[] } | SearchResult[]>(
        orgId,
        `/search?q=${encodeURIComponent(debouncedQuery)}`,
      ),
    enabled: debouncedQuery.trim().length >= 2,
  });

  const list: SearchResult[] = Array.isArray(results.data)
    ? results.data
    : (results.data?.results ?? []);

  return (
    <Screen>
      <TextInput
        style={styles.input}
        placeholder="Search resources…"
        placeholderTextColor={colors.textFaint}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Search resources"
      />
      {results.isLoading && debouncedQuery.trim().length >= 2 ? (
        <LoadingView />
      ) : list.length === 0 && debouncedQuery.trim().length >= 2 ? (
        <EmptyView message="No matches." />
      ) : (
        list.length > 0 && (
          <Card list>
            {list.map((r) => (
              <Row
                key={r.id}
                title={r.displayName}
                subtitle={[r.resourceTypeLabel ?? r.resourceTypeId, r.accountName]
                  .filter(Boolean)
                  .join(" · ")}
                onPress={() =>
                  router.push(
                    `/org/${orgId}/resources/${encodeURIComponent(r.pluginId)}/${encodeURIComponent(r.resourceTypeId)}/${encodeURIComponent(r.id)}`,
                  )
                }
              />
            ))}
          </Card>
        )
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 15,
  },
});
