import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastRow } from "../../components/Toast/Toast.js";
import { Toaster } from "../../components/Toast/Toaster.js";
import { useToastStore, toast } from "../../components/Toast/useToast.js";
import type { Toast as ToastT } from "../../components/Toast/types.js";

function makeToast(partial: Partial<ToastT> = {}): ToastT {
  return {
    id: "t1",
    variant: "info",
    message: "Hello",
    duration: Number.POSITIVE_INFINITY,
    createdAt: Date.now(),
    ...partial,
  };
}

afterEach(() => {
  act(() => useToastStore.getState().clear());
  vi.useRealTimers();
});

describe("ToastRow", () => {
  it("renders the message and description", () => {
    render(<ToastRow toast={makeToast({ description: "more detail" })} />);
    expect(screen.getByText("Hello")).toBeInTheDocument();
    expect(screen.getByText("more detail")).toBeInTheDocument();
  });

  it("uses assertive aria-live for error variant", () => {
    render(<ToastRow toast={makeToast({ variant: "error" })} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "assertive");
  });

  it("uses polite aria-live for non-error variants", () => {
    render(<ToastRow toast={makeToast({ variant: "success" })} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("dismisses from the store when the dismiss button is clicked", () => {
    act(() => {
      useToastStore.setState({ toasts: [makeToast({ id: "abc" })] });
    });
    render(<ToastRow toast={makeToast({ id: "abc" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("renders and fires an action then dismisses", () => {
    const onClick = vi.fn();
    act(() => {
      useToastStore.setState({ toasts: [makeToast({ id: "act" })] });
    });
    render(<ToastRow toast={makeToast({ id: "act", action: { label: "Undo", onClick } })} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("auto-dismisses after its duration", () => {
    vi.useFakeTimers();
    act(() => {
      useToastStore.setState({ toasts: [makeToast({ id: "auto", duration: 1000 })] });
    });
    render(<ToastRow toast={makeToast({ id: "auto", duration: 1000 })} />);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("pauses the auto-dismiss timer on hover", () => {
    vi.useFakeTimers();
    act(() => {
      useToastStore.setState({ toasts: [makeToast({ id: "h", duration: 1000 })] });
    });
    render(<ToastRow toast={makeToast({ id: "h", duration: 1000 })} />);
    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // Still present because hover paused the timer.
    expect(useToastStore.getState().toasts).toHaveLength(1);
    fireEvent.mouseLeave(screen.getByRole("status"));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe("Toaster", () => {
  it("renders nothing when there are no toasts", () => {
    const { container } = render(<Toaster />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders all queued toasts", () => {
    act(() => {
      useToastStore.setState({
        toasts: [makeToast({ id: "1", message: "One" }), makeToast({ id: "2", message: "Two" })],
      });
    });
    render(<Toaster />);
    expect(screen.getByText("One")).toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
  });
});

describe("toast store helpers", () => {
  it("adds variants with default durations and returns an id", () => {
    let id = "";
    act(() => {
      id = toast.success("done");
    });
    expect(typeof id).toBe("string");
    const t = useToastStore.getState().toasts.find((x) => x.id === id)!;
    expect(t.variant).toBe("success");
    expect(t.duration).toBe(4000);
  });

  it("honours a custom id and duration", () => {
    act(() => {
      toast.error("bad", { id: "custom", duration: 100 });
    });
    const t = useToastStore.getState().toasts.find((x) => x.id === "custom")!;
    expect(t.duration).toBe(100);
    expect(t.variant).toBe("error");
  });

  it("warning and info helpers add toasts", () => {
    act(() => {
      toast.warning("w");
      toast.info("i");
    });
    const variants = useToastStore.getState().toasts.map((t) => t.variant);
    expect(variants).toContain("warning");
    expect(variants).toContain("info");
  });

  it("dismiss removes a specific toast", () => {
    let id = "";
    act(() => {
      id = toast.info("x");
    });
    act(() => toast.dismiss(id));
    expect(useToastStore.getState().toasts.find((t) => t.id === id)).toBeUndefined();
  });

  it("promise resolves and emits a success toast", async () => {
    const value = await toast.promise(Promise.resolve(42), {
      loading: "loading",
      success: (v) => `got ${v}`,
      error: "err",
    });
    expect(value).toBe(42);
    expect(useToastStore.getState().toasts.some((t) => t.message === "got 42")).toBe(true);
  });

  it("promise rejects and emits an error toast", async () => {
    await expect(
      toast.promise(Promise.reject(new Error("nope")), {
        loading: "loading",
        success: "ok",
        error: (e) => `failed: ${(e as Error).message}`,
      }),
    ).rejects.toThrow("nope");
    expect(useToastStore.getState().toasts.some((t) => t.message === "failed: nope")).toBe(true);
  });
});
