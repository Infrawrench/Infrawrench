import { useId, type ReactNode } from "react";

export interface SshKeyRadioOption {
  id: string;
  label: string;
  sublabel?: string;
  meta?: ReactNode;
}

export interface SshKeyRadioGroupProps {
  keys: SshKeyRadioOption[];
  selectedId: string | null;
  onChange: (id: string, option: SshKeyRadioOption) => void;
  name?: string;
  ariaLabel?: string;
}

const ITEM_BASE_CLASSES =
  "group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors border";
const ITEM_SELECTED_CLASSES = "bg-accent-muted border-accent-muted-border text-accent-on-muted";
const ITEM_UNSELECTED_CLASSES =
  "border-transparent hover:bg-surface-overlay text-on-surface-tertiary";

export function SshKeyRadioGroup({
  keys,
  selectedId,
  onChange,
  name,
  ariaLabel,
}: SshKeyRadioGroupProps) {
  const autoName = useId();
  const groupName = name ?? autoName;
  return (
    <fieldset className="space-y-1 m-0 p-0 border-0">
      {ariaLabel && <legend className="sr-only">{ariaLabel}</legend>}
      {keys.map((k) => (
        <SshKeyRadioItem
          key={k.id}
          name={groupName}
          value={k.id}
          label={k.label}
          sublabel={k.sublabel}
          meta={k.meta}
          selected={selectedId === k.id}
          onSelect={() => onChange(k.id, k)}
        />
      ))}
    </fieldset>
  );
}

export interface SshKeyRadioItemProps {
  name: string;
  value: string;
  label: string;
  sublabel?: string;
  meta?: ReactNode;
  selected: boolean;
  onSelect: () => void;
  trailing?: ReactNode;
}

export function SshKeyRadioItem({
  name,
  value,
  label,
  sublabel,
  meta,
  selected,
  onSelect,
  trailing,
}: SshKeyRadioItemProps) {
  return (
    <label
      className={`${ITEM_BASE_CLASSES} ${
        selected ? ITEM_SELECTED_CLASSES : ITEM_UNSELECTED_CLASSES
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        onChange={() => onSelect()}
        aria-label={label}
        className="sr-only peer"
      />
      <span aria-hidden="true" className="text-xs shrink-0">
        {selected ? "◉" : "○"}
      </span>
      <span className="text-xs font-mono flex-1 truncate">
        {sublabel && <span className="text-on-surface-faint">{sublabel}</span>}
        {label}
      </span>
      {meta != null && <span className="text-xs text-on-surface-faint">{meta}</span>}
      {trailing}
    </label>
  );
}
