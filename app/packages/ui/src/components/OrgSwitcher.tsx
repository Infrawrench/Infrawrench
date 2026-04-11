import { useState, useRef, useEffect } from "react";

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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  const label =
    activeOrgId === null && showLocalOption
      ? "Local"
      : (activeOrg?.displayName ?? (loading ? "Loading..." : "Select organization"));

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold text-gray-300 hover:bg-gray-800 transition-colors rounded-md"
      >
        <span className="truncate">{label}</span>
        <span className="text-gray-600 text-xs ml-2">{open ? "\u25B2" : "\u25BC"}</span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
          {showLocalOption && (
            <button
              onClick={() => {
                onSwitch(null);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                activeOrgId === null
                  ? "bg-gray-800 text-gray-100"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              {activeOrgId === null && <span className="text-blue-400 text-xs">&#10003;</span>}
              <span className={activeOrgId === null ? "" : "pl-5"}>Local</span>
            </button>
          )}

          {showLocalOption && orgs.length > 0 && <div className="border-t border-gray-800" />}

          {orgs.map((org) => (
            <button
              key={org.id}
              onClick={() => {
                onSwitch(org.id);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                org.id === activeOrgId
                  ? "bg-gray-800 text-gray-100"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              {org.id === activeOrgId && <span className="text-blue-400 text-xs">&#10003;</span>}
              <span className={org.id === activeOrgId ? "" : "pl-5"}>{org.displayName}</span>
              <span className="ml-auto text-xs text-gray-600">{org.role}</span>
            </button>
          ))}

          {onCreateOrg && (
            <>
              <div className="border-t border-gray-800" />
              <button
                onClick={() => {
                  onCreateOrg();
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
              >
                + Create organization
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
