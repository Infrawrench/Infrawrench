import { useEffect, useState } from "react";
import { ActivityIndicator } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Sheet, TextField } from "@/components/form";
import { Button, Card, EmptyView, LoadingView, Row } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors } from "@/lib/theme";

interface SearchResult {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  accountName?: string;
  resourceTypeLabel?: string;
}

/**
 * Pick a resource to pin — what Spotlight in `mode="pin"` does on web, over the
 * same `/search`. Tapping a result pins it and closes; the sheet stays open
 * while the pin is in flight so a failure has somewhere to report.
 */
export function PinResourceSheet({
  visible,
  onPin,
  onClose,
}: {
  visible: boolean;
  onPin: (resourceId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { api, orgId } = useOrgApi();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [pinning, setPinning] = useState<string | null>(null);

  // Debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  const ready = debouncedQuery.trim().length >= 2;
  const results = useQuery({
    queryKey: ["search", orgId, debouncedQuery],
    queryFn: () =>
      api.org<{ results: SearchResult[] } | SearchResult[]>(
        orgId,
        `/search?q=${encodeURIComponent(debouncedQuery)}`,
      ),
    enabled: ready,
  });

  const list: SearchResult[] = Array.isArray(results.data)
    ? results.data
    : (results.data?.results ?? []);

  async function pin(resourceId: string) {
    setPinning(resourceId);
    try {
      await onPin(resourceId);
      onClose();
    } catch {
      // The mutation already reported it; keep the sheet open so the operator
      // can pick something else or try again.
    } finally {
      setPinning(null);
    }
  }

  return (
    <Sheet
      visible={visible}
      title="Pin a resource"
      onClose={onClose}
      footer={<Button label="Cancel" variant="secondary" onPress={onClose} />}
    >
      <TextField
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder="Search resources…"
        autoFocus
      />
      {!ready ? null : results.isLoading ? (
        <LoadingView />
      ) : list.length === 0 ? (
        <EmptyView message="No matches." />
      ) : (
        <Card list>
          {list.map((r) => (
            <Row
              key={r.id}
              title={r.displayName}
              subtitle={[r.resourceTypeLabel ?? r.resourceTypeId, r.accountName]
                .filter(Boolean)
                .join(" · ")}
              {...(pinning ? {} : { onPress: () => void pin(r.id) })}
              {...(pinning === r.id ? { right: <ActivityIndicator color={colors.accent} /> } : {})}
            />
          ))}
        </Card>
      )}
    </Sheet>
  );
}
