import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { ServiceRef } from "@infrawrench/client-core";
import { useTierLabel } from "./shared.js";

export interface ServiceAnnotationProps {
  /** The services this resource belongs to (`GET /services/for-resources`). */
  load: () => Promise<ServiceRef[]>;
  onOpenService: (serviceId: string) => void;
}

/**
 * "Part of: Checkout API (Tier 1)" on a resource's Ownership tab: which
 * services count the resource as a member, each a link to the service.
 * Renders nothing when the resource is in no service or the lookup fails,
 * since its absence is not something to warn about.
 */
export function ServiceAnnotation({ load, onOpenService }: ServiceAnnotationProps) {
  const gt = useGT();
  const tierLabel = useTierLabel();
  const [services, setServices] = useState<ServiceRef[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (list) => {
        if (!cancelled) setServices(list);
      },
      () => {
        if (!cancelled) setServices([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` is usually an inline arrow; loading once per mount is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!services || services.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-on-surface-secondary">
        {services.length === 1 ? gt("Service:") : gt("Services:")}
      </span>
      {services.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onOpenService(s.id)}
          className="text-info hover:underline"
        >
          {s.tier === null
            ? s.name
            : gt("{name} ({tier})", { name: s.name, tier: tierLabel(s.tier) })}
        </button>
      ))}
    </div>
  );
}
