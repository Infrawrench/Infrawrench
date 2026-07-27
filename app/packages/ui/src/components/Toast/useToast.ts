import { create } from "zustand";
import type { Toast, ToastOptions, ToastVariant } from "./types.js";

interface ToastStore {
  toasts: Toast[];
  add: (variant: ToastVariant, message: string, opts?: ToastOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULT_DURATIONS: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
};

let counter = 0;
const nextId = (): string => `t-${Date.now()}-${++counter}`;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  add(variant, message, opts) {
    const id = opts?.id ?? nextId();
    const duration = opts?.duration ?? DEFAULT_DURATIONS[variant];
    set((state) => ({
      toasts: [
        ...state.toasts,
        {
          id,
          variant,
          message,
          ...(opts?.description !== undefined ? { description: opts.description } : {}),
          duration,
          ...(opts?.action !== undefined ? { action: opts.action } : {}),
          createdAt: Date.now(),
        },
      ],
    }));
    return id;
  },
  dismiss(id) {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
  clear() {
    set({ toasts: [] });
  },
}));

export const toast = {
  success: (message: string, opts?: ToastOptions) =>
    useToastStore.getState().add("success", message, opts),
  error: (message: string, opts?: ToastOptions) =>
    useToastStore.getState().add("error", message, opts),
  warning: (message: string, opts?: ToastOptions) =>
    useToastStore.getState().add("warning", message, opts),
  info: (message: string, opts?: ToastOptions) =>
    useToastStore.getState().add("info", message, opts),
  dismiss: (id: string) => useToastStore.getState().dismiss(id),
  clear: () => useToastStore.getState().clear(),
  promise: async <T>(
    promise: Promise<T>,
    msgs: {
      loading: string;
      success: string | ((value: T) => string);
      error: string | ((err: unknown) => string);
    },
  ): Promise<T> => {
    const id = useToastStore
      .getState()
      .add("info", msgs.loading, { duration: Number.POSITIVE_INFINITY });
    try {
      const value = await promise;
      useToastStore.getState().dismiss(id);
      const msg = typeof msgs.success === "function" ? msgs.success(value) : msgs.success;
      useToastStore.getState().add("success", msg);
      return value;
    } catch (err) {
      useToastStore.getState().dismiss(id);
      const msg = typeof msgs.error === "function" ? msgs.error(err) : msgs.error;
      useToastStore.getState().add("error", msg);
      throw err;
    }
  },
};

export function useToast() {
  return toast;
}
