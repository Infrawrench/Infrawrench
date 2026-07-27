import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/**
 * Start / stop / restart for a Docker container, over `POST /docker/command`.
 * Inline on the resource page rather than its own screen — three buttons and a
 * status line don't warrant a navigation step.
 */

type DockerOp = "startContainer" | "stopContainer" | "restartContainer";

const OPS: Array<{ op: DockerOp; label: string }> = [
  { op: "startContainer", label: "Start" },
  { op: "stopContainer", label: "Stop" },
  { op: "restartContainer", label: "Restart" },
];

export function DockerActionsCard({
  accountId,
  containerId,
  onDone,
}: {
  accountId: string;
  containerId: string;
  onDone?: () => void;
}) {
  const { api, orgId } = useOrgApi();
  const [running, setRunning] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(op: DockerOp, label: string) {
    setRunning(label);
    setMessage(null);
    setError(null);
    try {
      await api.org(orgId, "/docker/command", {
        method: "POST",
        body: JSON.stringify({ accountId, op, params: { id: containerId } }),
      });
      setMessage(`${label} succeeded`);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setRunning(null);
    }
  }

  return (
    <Card>
      <SectionTitle>Container actions</SectionTitle>
      <View style={styles.row}>
        {OPS.map(({ op, label }) => (
          <Button
            key={op}
            label={running === label ? `${label}…` : label}
            variant="secondary"
            disabled={running !== null}
            onPress={() => void run(op, label)}
          />
        ))}
      </View>
      {message ? <Text style={styles.success}>{message}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  success: { color: colors.success, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12 },
});
