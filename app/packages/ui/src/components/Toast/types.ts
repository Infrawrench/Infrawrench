export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  id?: string;
  description?: string;
  duration?: number;
  action?: ToastAction;
}

export interface Toast {
  id: string;
  variant: ToastVariant;
  message: string;
  description?: string;
  duration: number;
  action?: ToastAction;
  createdAt: number;
}
