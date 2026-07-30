import { useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CustomGraphControl,
  CustomGraphControlState,
  CustomGraphRenderRequest,
  CustomGraphRenderResult,
  CustomGraphWidgetConfig,
} from "@infrawrench/client-core";
import { BareInput, Chip, ChipRow, ToggleChip } from "@/components/form";
import { Card, LoadingView } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { CustomGraphChart } from "./CustomGraphChart";

/**
 * A custom-graph widget: runs the script server-side (POST /custom-graphs/
 * :id/render) and draws the returned spec natively. Selects render as chip
 * rows and checkboxes as toggle chips — the same "no modal inside a phone
 * screen" rule as the cost editors. The script's refreshSeconds becomes the
 * query's refetch interval.
 *
 * Authoring stays on web/desktop/MCP — a phone is where a graph is read, not
 * where its script is written.
 */
export function CustomGraphCard({
  title,
  config,
}: {
  title: string;
  config: CustomGraphWidgetConfig;
}) {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const [controls, setControls] = useState<CustomGraphControlState | undefined>(undefined);
  // A button press re-runs with the button id exactly once.
  const pressedRef = useRef<string | undefined>(undefined);
  // graph.event.kind for the NEXT run: "manual" for the first, "interaction"
  // set by control changes and presses — and once a run has happened, any run
  // nobody initiated (the refetchInterval tick) reports "refresh".
  const triggerRef = useRef<"manual" | "refresh" | "interaction">("manual");

  const render = useQuery({
    queryKey: ["custom-graph-render", orgId, config.graphId, controls],
    queryFn: async () => {
      const request: CustomGraphRenderRequest = {
        ...(controls ? { controls } : {}),
        ...(pressedRef.current ? { button: pressedRef.current } : {}),
        trigger: triggerRef.current,
      };
      pressedRef.current = undefined;
      triggerRef.current = "refresh";
      const result = await api.org<CustomGraphRenderResult>(
        orgId,
        `/custom-graphs/${encodeURIComponent(config.graphId)}/render`,
        { method: "POST", body: JSON.stringify(request) },
      );
      if (!result) throw new Error("The render endpoint returned no body");
      return result;
    },
    refetchInterval: (query) => {
      const seconds = query.state.data?.spec?.refreshSeconds;
      return seconds ? seconds * 1000 : false;
    },
  });

  const spec = render.data?.spec ?? null;

  const currentState = (): CustomGraphControlState => {
    const state: CustomGraphControlState = {};
    for (const c of spec?.controls ?? []) {
      if (c.kind !== "button") state[c.id] = c.value;
    }
    return { ...state, ...controls };
  };

  const setControl = (id: string, value: string | number | boolean) => {
    triggerRef.current = "interaction";
    setControls({ ...currentState(), [id]: value });
  };

  const press = (control: Extract<CustomGraphControl, { kind: "button" }>) => {
    const fire = () => {
      pressedRef.current = control.id;
      triggerRef.current = "interaction";
      // Same key → invalidate to re-run with the button attached.
      void queryClient.invalidateQueries({
        queryKey: ["custom-graph-render", orgId, config.graphId, controls],
      });
    };
    if (control.danger) {
      Alert.alert(`${control.label}?`, undefined, [
        { text: "Cancel", style: "cancel" },
        { text: control.label, style: "destructive", onPress: fire },
      ]);
    } else {
      fire();
    }
  };

  return (
    <Card>
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>
        {spec?.title || title || "Custom graph"}
      </Text>

      {spec && spec.controls.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          {spec.controls.map((c) => {
            switch (c.kind) {
              case "select":
                return (
                  <View key={c.id} style={{ gap: 4 }}>
                    <Text style={{ color: colors.textFaint, fontSize: 11 }}>{c.label}</Text>
                    <ChipRow>
                      {c.options.map((o) => (
                        <Chip
                          key={o.value}
                          label={o.label}
                          selected={o.value === c.value}
                          onPress={() => setControl(c.id, o.value)}
                        />
                      ))}
                    </ChipRow>
                  </View>
                );
              case "checkbox":
                return (
                  <ChipRow key={c.id}>
                    <ToggleChip
                      label={c.label}
                      value={c.value}
                      onChange={(next) => setControl(c.id, next)}
                    />
                  </ChipRow>
                );
              case "button":
                return (
                  <ChipRow key={c.id}>
                    <Chip label={c.label} selected={false} onPress={() => press(c)} />
                  </ChipRow>
                );
              case "text":
              case "number":
                return (
                  <InputControl
                    key={c.id}
                    label={c.label}
                    value={String(c.value)}
                    numeric={c.kind === "number"}
                    onApply={(text) =>
                      setControl(c.id, c.kind === "number" ? Number(text) || 0 : text)
                    }
                  />
                );
            }
          })}
        </View>
      ) : null}

      {render.isLoading ? (
        <LoadingView />
      ) : render.isError ? (
        <Text style={{ color: colors.danger, fontSize: 12 }}>
          {render.error instanceof Error ? render.error.message : "Failed to render"}
        </Text>
      ) : spec ? (
        <CustomGraphChart spec={spec.chart} />
      ) : (
        <Text style={{ color: colors.danger, fontSize: 12 }}>
          {render.data?.error ?? "The graph produced nothing to draw."}
        </Text>
      )}

      {spec?.notice ? (
        <Text style={{ color: colors.textFaint, fontSize: 11 }}>{spec.notice}</Text>
      ) : null}
    </Card>
  );
}

/**
 * Text/number control with an explicit Apply — a render per keystroke would
 * hammer the sandbox, and `BareInput` is controlled with no submit event.
 */
function InputControl({
  label,
  value,
  numeric,
  onApply,
}: {
  label: string;
  value: string;
  numeric: boolean;
  onApply: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.textFaint, fontSize: 11 }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <BareInput
          value={draft}
          onChangeText={setDraft}
          keyboardType={numeric ? "numeric" : "default"}
          accessibilityLabel={label}
        />
        {draft !== value ? <Chip label="Apply" selected onPress={() => onApply(draft)} /> : null}
      </View>
    </View>
  );
}
