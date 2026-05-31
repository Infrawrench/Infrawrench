import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useToastStore, toast } from "../components/Toast/useToast";

beforeEach(() => useToastStore.getState().clear());
afterEach(() => useToastStore.getState().clear());

describe("useToastStore", () => {
  it("adds a toast with a generated id and default duration", () => {
    const id = useToastStore.getState().add("success", "Saved");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.id).toBe(id);
    expect(toasts[0]!.message).toBe("Saved");
    expect(toasts[0]!.duration).toBe(4000);
  });

  it("respects a custom id, duration, description, and action", () => {
    const action = { label: "Undo", onClick: () => {} };
    useToastStore.getState().add("error", "Oops", {
      id: "custom",
      duration: 100,
      description: "details",
      action,
    });
    const t = useToastStore.getState().toasts[0]!;
    expect(t.id).toBe("custom");
    expect(t.duration).toBe(100);
    expect(t.description).toBe("details");
    expect(t.action).toBe(action);
  });

  it("uses variant-specific default durations", () => {
    useToastStore.getState().add("warning", "w");
    useToastStore.getState().add("error", "e");
    const [w, e] = useToastStore.getState().toasts;
    expect(w!.duration).toBe(6000);
    expect(e!.duration).toBe(8000);
  });

  it("dismiss removes a single toast", () => {
    const id = useToastStore.getState().add("info", "hi");
    useToastStore.getState().dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("clear removes all toasts", () => {
    useToastStore.getState().add("info", "a");
    useToastStore.getState().add("info", "b");
    useToastStore.getState().clear();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe("toast helper", () => {
  it("exposes variant shortcuts", () => {
    toast.success("s");
    toast.error("e");
    toast.warning("w");
    toast.info("i");
    expect(useToastStore.getState().toasts.map((t) => t.variant)).toEqual([
      "success",
      "error",
      "warning",
      "info",
    ]);
  });

  it("dismiss and clear delegate to the store", () => {
    const id = toast.info("x");
    toast.dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    toast.info("y");
    toast.clear();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("promise resolves: shows loading then success and returns value", async () => {
    const value = await toast.promise(Promise.resolve(7), {
      loading: "loading",
      success: (v) => `got ${v}`,
      error: "err",
    });
    expect(value).toBe(7);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.variant).toBe("success");
    expect(toasts[0]!.message).toBe("got 7");
  });

  it("promise rejects: shows error and rethrows", async () => {
    await expect(
      toast.promise(Promise.reject(new Error("boom")), {
        loading: "loading",
        success: "ok",
        error: (e) => `failed: ${(e as Error).message}`,
      }),
    ).rejects.toThrow("boom");
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.variant).toBe("error");
    expect(toasts[0]!.message).toBe("failed: boom");
  });
});
