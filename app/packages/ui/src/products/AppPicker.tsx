import { ALWAYS_ON_PRODUCTS, type ProductId } from "@infrawrench/client-core";
import { ProductIcon } from "./ProductIcon.js";
import { useProductCopy } from "./copy.js";
import { PRODUCTS } from "./registry.js";

export interface AppPickerProps {
  /** The apps picked so far. */
  selected: readonly ProductId[];
  onChange: (selected: ProductId[]) => void;
  disabled?: boolean | undefined;
}

/**
 * A grid of the apps an organization can turn on or off, each a toggle.
 * Infrastructure is not offered: it is always on. Used where the choice is
 * made in one go (onboarding); Settings > Apps saves each switch on its own.
 */
export function AppPicker({ selected, onChange, disabled }: AppPickerProps) {
  const copy = useProductCopy();
  const choices = PRODUCTS.filter((product) => !ALWAYS_ON_PRODUCTS.includes(product.id));

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {choices.map((product) => {
        const on = selected.includes(product.id);
        return (
          <li key={product.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              disabled={disabled}
              onClick={() =>
                onChange(
                  on ? selected.filter((id) => id !== product.id) : [...selected, product.id],
                )
              }
              className={`flex h-full w-full items-start gap-3 rounded-xl border-2 p-4 text-left transition-colors disabled:opacity-50 ${
                on
                  ? "border-accent bg-surface-raised"
                  : "border-border bg-transparent hover:border-border-strong"
              }`}
            >
              <ProductIcon product={product.id} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-on-surface">
                  {copy[product.id].name}
                </span>
                <span className="mt-0.5 block text-xs text-on-surface-muted">
                  {copy[product.id].tagline}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
                  on ? "border-accent bg-accent text-on-accent" : "border-border-strong"
                }`}
              >
                {on && (
                  <svg
                    width={10}
                    height={10}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    {/* lucide: check */}
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
