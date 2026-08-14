import { useState, useRef, useEffect, useId } from "react";
import { useGT } from "gt-react";

export interface OrgEntry {
  id: string;
  displayName: string;
  role: string;
}

export interface OrgSwitcherProps {
  orgs: OrgEntry[];
  activeOrgId: string | null;
  onSwitch: (orgId: string | null) => void;
  showLocalOption?: boolean;
  onCreateOrg?: () => void;
  loading?: boolean;
}

export function OrgSwitcher({
  orgs,
  activeOrgId,
  onSwitch,
  showLocalOption = false,
  onCreateOrg,
  loading = false,
}: OrgSwitcherProps) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusFirstOnOpen = useRef(false);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (open && focusFirstOnOpen.current) {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
    focusFirstOnOpen.current = false;
  }, [open]);

  const closeAndRefocus = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeAndRefocus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
      );
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        index === -1
          ? e.key === "ArrowDown"
            ? 0
            : items.length - 1
          : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  };

  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  const label =
    activeOrgId === null && showLocalOption
      ? gt("Local")
      : (activeOrg?.displayName ?? (loading ? gt("Loading…") : gt("Select organization")));

  return (
    <div ref={ref} className="relative" onKeyDown={handleKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            focusFirstOnOpen.current = true;
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              setOpen(true);
            }
          }
        }}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-on-surface-secondary hover:bg-surface-overlay transition-colors rounded-md"
      >
        <span className="truncate">{label}</span>
        <span aria-hidden="true" className="text-on-surface-faint text-xs ml-2">
          {open ? "\u25B2" : "\u25BC"}
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          className="absolute left-0 right-0 top-full mt-1 z-50 bg-surface-raised border border-border-strong rounded-lg shadow-xl overflow-hidden"
        >
          {showLocalOption && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onSwitch(null);
                closeAndRefocus();
              }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                activeOrgId === null
                  ? "bg-surface-overlay text-on-surface"
                  : "text-on-surface-tertiary hover:bg-surface-overlay hover:text-on-surface-secondary"
              }`}
            >
              {activeOrgId === null && <span className="text-accent text-xs">&#10003;</span>}
              <span className={activeOrgId === null ? "" : "pl-5"}>{gt("Local")}</span>
            </button>
          )}

          {showLocalOption && orgs.length > 0 && <div className="border-t border-border" />}

          {orgs.map((org) => (
            <button
              key={org.id}
              type="button"
              role="menuitem"
              onClick={() => {
                onSwitch(org.id);
                closeAndRefocus();
              }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                org.id === activeOrgId
                  ? "bg-surface-overlay text-on-surface"
                  : "text-on-surface-tertiary hover:bg-surface-overlay hover:text-on-surface-secondary"
              }`}
            >
              {org.id === activeOrgId && <span className="text-accent text-xs">&#10003;</span>}
              <span className={org.id === activeOrgId ? "" : "pl-5"}>{org.displayName}</span>
              <span className="ml-auto text-xs text-on-surface-faint">{org.role}</span>
            </button>
          ))}

          {onCreateOrg && (
            <>
              <div className="border-t border-border" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onCreateOrg();
                  closeAndRefocus();
                }}
                className="w-full text-left px-3 py-2 text-sm text-on-surface-muted hover:bg-surface-overlay hover:text-on-surface-secondary transition-colors"
              >
                + {gt("Create organization")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
