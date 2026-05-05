import type { ImageOption } from "@infrawrench/plugin-base";

export function ImageRow({
  img,
  selected,
  onSelect,
}: {
  img: ImageOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
        selected
          ? "bg-accent-muted text-accent-on-muted"
          : "text-on-surface-secondary hover:bg-surface-overlay"
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-surface-sunken"}`}
      />
      <span className="truncate">{img.label}</span>
      {img.isOwned && (
        <span className="text-[10px] text-on-surface-faint ml-auto flex-shrink-0">owned</span>
      )}
    </button>
  );
}
