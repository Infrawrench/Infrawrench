import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { CreateFieldConfig } from "@infrawrench/plugin-base";
import { buildDefaultFields, evaluateShowWhen } from "@infrawrench/client-core";
import { Button } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Mobile counterpart of the web PromptNoSqlCommandModal: renders a
 * `CreateFieldConfig[]` form and hands back the values keyed by field key.
 *
 * Only the field kinds a phone can honestly render are interactive — text,
 * password, number, multiline, and `select` (rendered as chips). Anything
 * richer (region/size/image pickers, the code editor) falls back to a plain
 * text input rather than silently dropping the field, and the description
 * tells the operator what the value should look like.
 */
export function PromptCommandSheet({
  visible,
  title,
  description,
  descriptionVariant = "info",
  blocked = false,
  fields,
  submitLabel = "Submit",
  onSubmit,
  onCancel,
}: {
  visible: boolean;
  title: string;
  description?: string | undefined;
  descriptionVariant?: "info" | "error";
  blocked?: boolean;
  fields: CreateFieldConfig[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => buildDefaultFields(fields));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hidden fields still ride along in the payload — they carry context the
  // plugin pre-filled (the resource name to delete, and so on).
  const visibleFields = fields.filter((f) => evaluateShowWhen(f, values) && !f.hidden);
  const submittedFields = fields.filter((f) => evaluateShowWhen(f, values));

  async function handleSubmit() {
    setError(null);
    for (const f of visibleFields) {
      if (f.required && !(values[f.key] ?? "").trim()) {
        setError(`${f.label} is required`);
        return;
      }
    }
    setSubmitting(true);
    try {
      const payload: Record<string, string> = {};
      for (const f of submittedFields) payload[f.key] = values[f.key] ?? "";
      await onSubmit(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          {description ? (
            <Text style={descriptionVariant === "error" ? styles.errorText : styles.description}>
              {description}
            </Text>
          ) : null}

          {!blocked && (
            <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
              {visibleFields.map((field) => (
                <FieldInput
                  key={field.key}
                  field={field}
                  value={values[field.key] ?? ""}
                  onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))}
                />
              ))}
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </ScrollView>
          )}

          <View style={styles.actions}>
            <Button label={blocked ? "Close" : "Cancel"} variant="secondary" onPress={onCancel} />
            {!blocked && (
              <Button
                label={submitting ? "Working…" : submitLabel}
                disabled={submitting}
                onPress={() => void handleSubmit()}
              />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: CreateFieldConfig;
  value: string;
  onChange: (value: string) => void;
}) {
  const options = field.options ?? [];

  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {field.label}
        {field.required ? " *" : ""}
      </Text>
      {field.description ? <Text style={styles.hint}>{field.description}</Text> : null}

      {field.kind === "select" && options.length > 0 ? (
        <View style={styles.chipRow}>
          {options.map((opt) => {
            const selected = opt.id === value;
            return (
              <Pressable
                key={opt.id}
                onPress={() => onChange(opt.id)}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={selected ? styles.chipTextSelected : styles.chipText}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={field.placeholder ?? ""}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={field.kind === "password"}
          keyboardType={field.kind === "number" ? "numeric" : "default"}
          multiline={field.multiline === true || field.kind === "code"}
          style={[styles.input, (field.multiline || field.kind === "code") && styles.inputTall]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
    maxHeight: "88%",
  },
  title: { color: colors.text, fontSize: 16, fontWeight: "700" },
  description: { color: colors.textMuted, fontSize: 12 },
  body: { maxHeight: 420 },
  field: { gap: spacing.xs, marginBottom: spacing.md },
  label: { color: colors.textSecondary, fontSize: 13 },
  hint: { color: colors.textFaint, fontSize: 11 },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    color: colors.text,
    fontSize: 14,
    padding: spacing.sm,
  },
  inputTall: { minHeight: 96, textAlignVertical: "top", fontFamily: "monospace", fontSize: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  chip: {
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceOverlay },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextSelected: { color: colors.text, fontSize: 12, fontWeight: "600" },
  errorText: { color: colors.danger, fontSize: 12 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});
