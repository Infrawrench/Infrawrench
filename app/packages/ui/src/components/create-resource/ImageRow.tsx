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
        selected ? "bg-blue-600/20 text-blue-300" : "text-gray-300 hover:bg-gray-800"
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-gray-700"}`}
      />
      <span className="truncate">{img.label}</span>
      {img.isOwned && (
        <span className="text-[10px] text-gray-600 ml-auto flex-shrink-0">owned</span>
      )}
    </button>
  );
}
