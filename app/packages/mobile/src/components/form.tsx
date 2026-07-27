import type { ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
} from "react-native";
import { Button } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * The form vocabulary shared by every sheet that writes something back to the
 * cloud — the bottom sheet itself, a labelled text input, and the chip pickers
 * that stand in for the `<select>` web uses.
 *
 * A phone has no room for a dropdown that lists eight range presets, and the
 * platform picker is a modal of its own, which nests badly inside a sheet that
 * is already one. Chips show every option at once and cost a single tap, which
 * is why the editors here read as rows of chips where web reads as selects.
 */

export function Sheet({
  visible,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  visible: boolean;
  title: string;
  description?: string | undefined;
  onClose: () => void;
  children: ReactNode;
  /** Action row pinned below the scrolling body. */
  footer?: ReactNode;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{title}</Text>
          {description ? <Text style={styles.hint}>{description}</Text> : null}
          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={styles.actions}>{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}

/** Cancel + submit, the action row every sheet in this app ends with. */
export function SheetActions({
  onCancel,
  onSubmit,
  submitLabel,
  submitting = false,
  disabled = false,
  cancelLabel = "Cancel",
}: {
  onCancel: () => void;
  onSubmit: () => void;
  submitLabel: string;
  submitting?: boolean;
  disabled?: boolean;
  cancelLabel?: string;
}) {
  return (
    <>
      <Button label={cancelLabel} variant="secondary" onPress={onCancel} />
      <Button
        label={submitting ? "Saving…" : submitLabel}
        disabled={submitting || disabled}
        onPress={onSubmit}
      />
    </>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize = "none",
  maxLength,
  autoFocus = false,
  onSubmitEditing,
}: {
  label: string;
  hint?: string | undefined;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string | undefined;
  keyboardType?: KeyboardTypeOptions | undefined;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  maxLength?: number | undefined;
  autoFocus?: boolean;
  onSubmitEditing?: (() => void) | undefined;
}) {
  return (
    <Field label={label} hint={hint}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? ""}
        placeholderTextColor={colors.textFaint}
        keyboardType={keyboardType ?? "default"}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        maxLength={maxLength}
        autoFocus={autoFocus}
        onSubmitEditing={onSubmitEditing}
        accessibilityLabel={label}
      />
    </Field>
  );
}

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

export function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={selected ? styles.chipTextSelected : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <View style={styles.chipRow}>{children}</View>;
}

/** One-of picker. */
export function ChipSelect<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  options: ReadonlyArray<ChipOption<T>>;
  /** `null` when nothing in this list is chosen — no chip reads as selected. */
  value: T | null;
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <ChipRow>
        {options.map((o) => (
          <Chip
            key={o.value}
            label={o.label}
            selected={o.value === value}
            onPress={() => onChange(o.value)}
          />
        ))}
      </ChipRow>
    </Field>
  );
}

/** Any-of picker; `value` is the selected subset, in no particular order. */
export function ChipMultiSelect({
  options,
  value,
  onChange,
  emptyMessage = "No values yet",
}: {
  options: ReadonlyArray<ChipOption<string>>;
  value: string[];
  onChange: (value: string[]) => void;
  emptyMessage?: string;
}) {
  if (options.length === 0) return <Text style={styles.hint}>{emptyMessage}</Text>;
  return (
    <ChipRow>
      {options.map((o) => {
        const selected = value.includes(o.value);
        return (
          <Chip
            key={o.value}
            label={o.label}
            selected={selected}
            onPress={() =>
              onChange(selected ? value.filter((v) => v !== o.value) : [...value, o.value])
            }
          />
        );
      })}
    </ChipRow>
  );
}

/** A boolean rendered as a single chip — checkboxes are hard to hit on a phone. */
export function ToggleChip({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return <Chip label={label} selected={value} onPress={() => onChange(!value)} />;
}

/**
 * A field input the caller lays out itself — a threshold percent sitting beside
 * its type chips, or a tag key beside a dimension.
 */
export function BareInput({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  width,
  accessibilityLabel,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string | undefined;
  keyboardType?: KeyboardTypeOptions | undefined;
  width?: number | undefined;
  accessibilityLabel: string;
}) {
  return (
    <TextInput
      style={[styles.input, width === undefined ? { flex: 1 } : { width }]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder ?? ""}
      placeholderTextColor={colors.textFaint}
      keyboardType={keyboardType ?? "default"}
      autoCapitalize="none"
      autoCorrect={false}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

export function FormHint({ children }: { children: ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <Text style={styles.errorText}>{message}</Text>;
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
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  body: { maxHeight: 460 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
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
});
