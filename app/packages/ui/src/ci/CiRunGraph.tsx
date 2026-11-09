import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import { CiStatusIcon } from "./CiStatusIcon.js";
import { formatDuration } from "./format.js";
import {
  HEADER_HEIGHT,
  layoutGraph,
  MAX_ROWS,
  ROW_HEIGHT,
  type GraphGroup,
  type GraphJob,
} from "./graph.js";

const MIN_ZOOM = 0.2;
/** Room around a fitted graph, in screen pixels. */
const FIT_PADDING = 16;
const MIN_BOX_HEIGHT = 160;
const MAX_ZOOM = 2;

/** A job's time: what it took, or for one still running how long it has been going. */
function elapsed(job: GraphJob, now: number): string {
  if (job.status === "running" && job.startedAt) return formatDuration(now - job.startedAt);
  return formatDuration(job.durationMs);
}

function JobRow({
  job,
  selected,
  now,
  onSelect,
}: {
  job: GraphJob;
  selected: boolean;
  now: number;
  onSelect: (job: GraphJob) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(job)}
      onPointerDown={(e) => e.stopPropagation()}
      className={`flex w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-surface-sunken ${
        selected ? "bg-accent-muted text-accent-on-muted" : "text-on-surface"
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      <CiStatusIcon status={job.status} />
      <span className="min-w-0 flex-1 truncate font-medium">{job.name}</span>
      <span className="shrink-0 tabular-nums text-on-surface-faint">{elapsed(job, now)}</span>
    </button>
  );
}

function GroupNode({
  group,
  selected,
  now,
  expanded,
  onSelect,
  onToggle,
}: {
  group: GraphGroup;
  selected: string | null;
  now: number;
  expanded: boolean;
  onSelect: (job: GraphJob) => void;
  onToggle: (key: string) => void;
}) {
  const gt = useGT();
  const style = { left: group.x, top: group.y, width: group.width, height: group.height };
  if (group.jobs.length === 1) {
    const job = group.jobs[0]!;
    return (
      <div
        className={`absolute flex items-center rounded-md border bg-surface-raised px-1 shadow-sm ${
          selected === job.id ? "border-accent" : "border-border-strong"
        }`}
        style={style}
      >
        <JobRow job={job} selected={selected === job.id} now={now} onSelect={onSelect} />
      </div>
    );
  }
  const shown = group.jobs.slice(0, group.jobs.length - group.hidden);
  return (
    <div
      className="absolute rounded-md border border-dashed border-border-strong bg-surface-raised/60 p-1"
      style={style}
    >
      <div
        className="flex items-center gap-2 px-2 text-[11px] text-on-surface-faint"
        style={{ height: HEADER_HEIGHT - 4 }}
      >
        <CiStatusIcon status={group.status} size={12} />
        <span className="truncate font-mono">{group.key}</span>
        <span className="ml-auto">{gt("{count} jobs", { count: String(group.jobs.length) })}</span>
      </div>
      {shown.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          selected={selected === job.id}
          now={now}
          onSelect={onSelect}
        />
      ))}
      {group.jobs.length > MAX_ROWS ? (
        <button
          type="button"
          onClick={() => onToggle(group.key)}
          onPointerDown={(e) => e.stopPropagation()}
          className="w-full rounded px-2 text-left text-xs text-accent hover:bg-surface-sunken"
          style={{ height: ROW_HEIGHT }}
        >
          {expanded ? gt("Show fewer") : gt("Show {count} more", { count: String(group.hidden) })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One pipeline's jobs as a graph: a box per job (a matrix's or a
 * `packages:` job's entries share one), each below the jobs it needs, with
 * an edge for each need. Drag to pan; zoom with the buttons or Ctrl and the
 * wheel; Fit shows it whole; Expand fills the window. Clicking a job selects
 * it, which opens its log.
 */
export function CiRunGraph({
  title,
  subtitle,
  jobs,
  selected,
  now,
  onSelect,
}: {
  title: string;
  subtitle: string;
  jobs: readonly GraphJob[];
  selected: string | null;
  now: number;
  onSelect: (job: GraphJob) => void;
}) {
  const gt = useGT();
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const layout = useMemo(() => layoutGraph(jobs, expandedGroups), [jobs, expandedGroups]);
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // The box's height when not full screen: as tall as the graph at the
  // zoom that fits its width, so a small pipeline takes a small box, up to
  // three quarters of the window.
  const [boxHeight, setBoxHeight] = useState(MIN_BOX_HEIGHT);
  // Once someone pans or zooms, resizing the view leaves their view alone.
  const touched = useRef(false);

  const fit = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    touched.current = false;
    const width = el.clientWidth;
    const byWidth = Math.min(1, (width - FIT_PADDING * 2) / layout.width);
    let z: number;
    let height: number;
    if (fullscreen) {
      height = el.clientHeight;
      z = Math.min(byWidth, (height - FIT_PADDING * 2) / layout.height);
    } else {
      const most = Math.max(MIN_BOX_HEIGHT, window.innerHeight * 0.75);
      const natural = layout.height * byWidth + FIT_PADDING * 2;
      height = Math.min(most, Math.max(MIN_BOX_HEIGHT, natural));
      z = Math.min(byWidth, (height - FIT_PADDING * 2) / layout.height);
      setBoxHeight(height);
    }
    z = Math.max(MIN_ZOOM, z);
    setZoom(z);
    // Centred across, from the top down.
    setPan({ x: (width - layout.width * z) / 2, y: FIT_PADDING });
  }, [layout.width, layout.height, fullscreen]);

  // Fit when the graph first has a shape, when going in or out of full
  // screen, and when the view changes width, unless someone has moved it
  // since. Not on every change of shape, which expanding a group is.
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (!fitted.current && layout.groups.length > 0) {
      fitted.current = true;
      fit();
    }
  }, [fit, layout.groups.length]);
  useLayoutEffect(() => {
    fitRef.current();
  }, [fullscreen]);
  useEffect(() => {
    const el = viewport.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      if (!touched.current) fitRef.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = viewport.current;
    touched.current = true;
    setZoom((z) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      const px = cx ?? (el ? el.clientWidth / 2 : 0);
      const py = cy ?? (el ? el.clientHeight / 2 : 0);
      setPan((p) => ({
        x: px - ((px - p.x) / z) * next,
        y: py - ((py - p.y) / z) * next,
      }));
      return next;
    });
  }, []);

  // The wheel pans, and zooms with Ctrl or Cmd (a pinch on a trackpad). Not
  // a React handler: preventing the page's own scroll needs a listener that
  // is not passive.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY / 300), e.clientX - rect.left, e.clientY - rect.top);
      } else {
        touched.current = true;
        setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const button =
    "rounded border border-border bg-surface px-2 py-1 text-xs text-on-surface hover:bg-surface-sunken";
  return (
    <section
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-surface"
          : "flex flex-col rounded-md border border-border bg-surface"
      }
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-on-surface">{title}</h3>
          <p className="text-xs text-on-surface-faint">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={button}
            onClick={() => zoomAt(1 / 1.2)}
            aria-label={gt("Zoom out")}
          >
            −
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-on-surface-muted">
            {`${Math.round(zoom * 100)}%`}
          </span>
          <button
            type="button"
            className={button}
            onClick={() => zoomAt(1.2)}
            aria-label={gt("Zoom in")}
          >
            +
          </button>
          <button type="button" className={button} onClick={fit}>
            {gt("Fit")}
          </button>
          <button type="button" className={button} onClick={() => setFullscreen((f) => !f)}>
            {fullscreen ? gt("Close") : gt("Expand")}
          </button>
        </div>
      </header>
      <div
        ref={viewport}
        className={`relative cursor-grab touch-none select-none overflow-hidden bg-surface-sunken active:cursor-grabbing ${
          fullscreen ? "flex-1" : ""
        }`}
        style={fullscreen ? undefined : { height: boxHeight }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          touched.current = true;
          setPan({ x: d.panX + e.clientX - d.x, y: d.panY + e.clientY - d.y });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          <svg
            width={layout.width}
            height={layout.height}
            className="pointer-events-none absolute left-0 top-0 text-on-surface-faint"
            aria-hidden="true"
          >
            {layout.edges.map((edge) => (
              <path
                key={`${edge.from}->${edge.to}`}
                d={edge.d}
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.55"
                strokeWidth="1.25"
              />
            ))}
          </svg>
          {layout.groups.map((group) => (
            <GroupNode
              key={group.key}
              group={group}
              selected={selected}
              now={now}
              expanded={expandedGroups.has(group.key)}
              onSelect={onSelect}
              onToggle={toggleGroup}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
