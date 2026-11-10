import { useMemo, useState } from "react";
import { useGT } from "gt-react";
import type { SidebarToolDef } from "../components/sidebar/SidebarTools.js";
import { ProductIcon, SettingsGlyph } from "./ProductIcon.js";
import { useProductCopy, useToolDescriptions, type ProductCopy } from "./copy.js";
import {
  PRODUCTS,
  findProduct,
  groupToolsByProduct,
  type ProductDef,
  type ProductId,
} from "./registry.js";

const NO_PRODUCTS: readonly ProductId[] = [];

export interface ProductsHomePanelProps {
  /** The open product's page, or Home (the grid of products) when unset. */
  productId?: string | undefined;
  /** This platform's org tools; products are built from them by `key`. */
  tools: SidebarToolDef[];
  /** Opens a product's page, or Home when called without an id. */
  onOpenProduct: (productId?: ProductId) => void;
  /** Opens the caller's home dashboard. */
  onOpenDashboards: () => void;
  /** Opens chat. Absent where there is no chat (desktop without an org). */
  onOpenChat?: (() => void) | undefined;
  /**
   * Apps the organization has turned off (the host's `useDisabledProducts`).
   * They are left out of the grid, and their page says so instead of listing
   * tools.
   */
  disabledProducts?: readonly ProductId[] | undefined;
  /** Opens an app's settings, or undefined when it has none to open. */
  settingsFor?: ((product: ProductId) => (() => void) | undefined) | undefined;
}

/**
 * Home: every product as a card, plus what sits across all of them
 * (dashboards, chat). With a `productId` it is that product's page: its
 * name and its tools, nothing else. What a product is for is the docs' job.
 *
 * It holds no data of its own. The host passes its tool list, so a tool a
 * platform cannot offer is never drawn here, and navigation stays the
 * host's.
 */
export function ProductsHomePanel({
  productId,
  tools,
  onOpenProduct,
  onOpenDashboards,
  onOpenChat,
  disabledProducts = NO_PRODUCTS,
  settingsFor,
}: ProductsHomePanelProps) {
  const copy = useProductCopy();
  const grouped = useMemo(() => groupToolsByProduct(tools), [tools]);
  const product = findProduct(productId);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        {product ? (
          <ProductPage
            productId={product.id}
            copy={copy}
            tools={grouped.byProduct[product.id]}
            turnedOff={disabledProducts.includes(product.id)}
            openSettings={settingsFor?.(product.id)}
            onOpenProduct={onOpenProduct}
          />
        ) : (
          <ProductGrid
            copy={copy}
            products={PRODUCTS.filter((p) => !disabledProducts.includes(p.id))}
            byProduct={grouped.byProduct}
            unclaimed={grouped.unclaimed}
            onOpenProduct={onOpenProduct}
            onOpenDashboards={onOpenDashboards}
            onOpenChat={onOpenChat}
          />
        )}
      </div>
    </div>
  );
}

const CARD =
  "flex w-full items-start gap-3 rounded-xl border border-border bg-surface-raised p-4 text-left transition-colors hover:border-border-strong hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-subtle";

function ProductGrid({
  copy,
  products,
  byProduct,
  unclaimed,
  onOpenProduct,
  onOpenDashboards,
  onOpenChat,
}: {
  copy: Record<ProductId, ProductCopy>;
  /** The apps to show: every app the organization has not turned off. */
  products: readonly ProductDef[];
  byProduct: Record<ProductId, SidebarToolDef[]>;
  unclaimed: SidebarToolDef[];
  onOpenProduct: (productId?: ProductId) => void;
  onOpenDashboards: () => void;
  onOpenChat?: (() => void) | undefined;
}) {
  const gt = useGT();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  // A product matches on its own name and tagline or on any of its tools, so
  // "probes" finds Observability without anyone learning where things live.
  const visible = products.filter((product) => {
    if (!needle) return true;
    const text = copy[product.id];
    return (
      text.name.toLowerCase().includes(needle) ||
      byProduct[product.id].some((tool) => tool.label.toLowerCase().includes(needle))
    );
  });
  const matchingTools = needle
    ? products
        .flatMap((product) => byProduct[product.id])
        .concat(unclaimed)
        .filter((tool) => tool.label.toLowerCase().includes(needle))
    : [];

  return (
    <>
      <header className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Home")}</h1>
      </header>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={gt("Search apps and tools…")}
        aria-label={gt("Search apps and tools")}
        className="mb-6 w-full max-w-sm rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface placeholder:text-on-surface-faint focus:border-border-strong focus:outline-none"
      />

      {matchingTools.length > 0 && (
        <section className="mb-8" aria-label={gt("Matching tools")}>
          <ToolList tools={matchingTools} />
        </section>
      )}

      {visible.length === 0 && matchingTools.length === 0 ? (
        <p className="py-12 text-center text-sm text-on-surface-faint">
          {gt("Nothing matches “{query}”", { query })}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((product) => {
            const text = copy[product.id];
            const mine = byProduct[product.id];
            return (
              <li key={product.id}>
                <button
                  type="button"
                  onClick={() => onOpenProduct(product.id)}
                  className={`${CARD} h-full`}
                >
                  <ProductIcon product={product.id} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-on-surface">{text.name}</span>
                    <span className="mt-1 block text-xs text-on-surface-muted">
                      {mine.length > 0
                        ? mine.map((tool) => tool.label).join(" · ")
                        : gt("Needs a cloud organization")}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!needle && (
        <>
          <section className="mt-10">
            <h2 className="mb-3 text-sm font-medium text-on-surface">{gt("Across every app")}</h2>
            <SharedCards onOpenDashboards={onOpenDashboards} onOpenChat={onOpenChat} />
          </section>

          {unclaimed.length > 0 && (
            <section className="mt-10">
              <h2 className="mb-3 text-sm font-medium text-on-surface">{gt("More tools")}</h2>
              <ToolList tools={unclaimed} />
            </section>
          )}
        </>
      )}
    </>
  );
}

function SharedCards({
  onOpenDashboards,
  onOpenChat,
}: {
  onOpenDashboards: () => void;
  onOpenChat?: (() => void) | undefined;
}) {
  const gt = useGT();
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <li>
        <button type="button" onClick={onOpenDashboards} className={`${CARD} h-full`}>
          <ProductIcon product="dashboards" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-on-surface">{gt("Dashboards")}</span>
            <span className="mt-0.5 block text-xs text-on-surface-muted">
              {gt("Pin resources, cost graphs, budgets and notes from any app to one grid.")}
            </span>
          </span>
        </button>
      </li>
      {onOpenChat && (
        <li>
          <button type="button" onClick={onOpenChat} className={`${CARD} h-full`}>
            <ProductIcon product="chat" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-on-surface">{gt("Chat")}</span>
              <span className="mt-0.5 block text-xs text-on-surface-muted">
                {gt("Ask one assistant that can use the tools of every app.")}
              </span>
            </span>
          </button>
        </li>
      )}
    </ul>
  );
}

function ToolList({ tools }: { tools: SidebarToolDef[] }) {
  const descriptions = useToolDescriptions();
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {tools.map((tool) => (
        <li key={tool.key}>
          <button
            type="button"
            onClick={tool.onClick}
            className="flex w-full items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-overlay focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-subtle"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center text-on-surface-secondary [&_svg]:h-4 [&_svg]:w-4"
            >
              {tool.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-on-surface">{tool.label}</span>
              {descriptions[tool.key] && (
                <span className="mt-0.5 block text-xs text-on-surface-muted">
                  {descriptions[tool.key]}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ProductPage({
  productId,
  copy,
  tools,
  turnedOff,
  openSettings,
  onOpenProduct,
}: {
  productId: ProductId;
  copy: Record<ProductId, ProductCopy>;
  tools: SidebarToolDef[];
  /** The organization turned this app off: say so instead of listing tools. */
  turnedOff: boolean;
  openSettings: (() => void) | undefined;
  onOpenProduct: (productId?: ProductId) => void;
}) {
  const gt = useGT();
  const text = copy[productId];

  return (
    <>
      <nav aria-label={gt("Breadcrumb")} className="mb-5 text-xs text-on-surface-muted">
        <button
          type="button"
          onClick={() => onOpenProduct()}
          className="rounded hover:text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-subtle"
        >
          {gt("Home")}
        </button>
        <span aria-hidden="true" className="mx-1.5 text-on-surface-faint">
          /
        </span>
        <span aria-current="page" className="text-on-surface-secondary">
          {text.name}
        </span>
      </nav>

      <header className="mb-6 flex items-center gap-3">
        <ProductIcon product={productId} />
        <h1 className="flex-1 text-xl font-semibold">{text.name}</h1>
        {openSettings && !turnedOff && (
          <button
            type="button"
            onClick={openSettings}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-on-surface-secondary transition-colors hover:border-border-strong hover:bg-surface-overlay"
          >
            <SettingsGlyph />
            {gt("Settings")}
          </button>
        )}
      </header>

      {turnedOff ? (
        <p className="rounded-lg border border-border px-3 py-2.5 text-sm text-on-surface-muted">
          {gt("Your organization has turned this app off.")}
        </p>
      ) : tools.length > 0 ? (
        <ToolList tools={tools} />
      ) : (
        <p className="rounded-lg border border-border px-3 py-2.5 text-sm text-on-surface-muted">
          {gt("Sign in to a cloud organization to use this app.")}
        </p>
      )}
    </>
  );
}
