import { useState, useId } from "react";
import { useGT } from "gt-react";
import { ChevronIcon } from "./icons/ChromeIcons.js";

interface AdvancedFieldsDisclosureProps {
  children: React.ReactNode;
  /**
   * Opens the section while the user hasn't toggled it themselves; credential
   * forms pass "an advanced field already holds a value", so a pre-filled CA
   * certificate is never hidden behind a closed toggle.
   */
  autoOpen?: boolean;
}

/** Collapsed "Advanced options" section for rarely needed credential fields. */
export function AdvancedFieldsDisclosure({
  children,
  autoOpen = false,
}: AdvancedFieldsDisclosureProps) {
  const gt = useGT();
  const contentId = useId();
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? autoOpen;

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setToggled(!open)}
        className="flex items-center gap-1 text-xs text-on-surface-tertiary hover:text-on-surface-secondary"
      >
        <ChevronIcon direction={open ? "down" : "right"} size={12} />
        {gt("Advanced options")}
      </button>
      {open && (
        <div id={contentId} className="space-y-4 mt-3">
          {children}
        </div>
      )}
    </div>
  );
}
