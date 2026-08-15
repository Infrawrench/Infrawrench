import { useMemo } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CreateResourceConfig } from "@infrawrench/plugin-base";
import type { RequiredTag } from "@infrawrench/client-core";
import { CreateResourceModal } from "../components/CreateResourceModal.js";
import { FieldRenderer } from "../components/create-resource/FieldRenderer.js";
import { KeyValueListPicker } from "../components/create-resource/KeyValueListPicker.js";
import { StringListPicker } from "../components/create-resource/StringListPicker.js";
import { useCreateResourceForm } from "../hooks/useCreateResourceForm.js";

beforeAll(() => {
  // jsdom doesn't implement <dialog> showModal/close — stub them, the way the
  // other Modal-rendering suites do.
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }
});

const CONFIG: CreateResourceConfig = {
  fields: [
    { key: "name", label: "Name", kind: "text", required: true },
    { key: "tags", label: "Tags", kind: "string-list", required: false, placeholder: "key=value" },
  ],
};

/**
 * The real thing: the shared modal driving the real form hook, the way both
 * web and desktop wire it. The prefill runs in the modal's effect, which React
 * runs *after* the picker's — so this only passes if the picker adopts a value
 * that arrives after it mounted.
 */
function Harness({
  requiredTags,
  onFields,
}: {
  requiredTags: RequiredTag[];
  onFields?: (fields: Record<string, string>) => void;
}) {
  const callbacks = useMemo(
    () => ({
      loadConfig: async () => CONFIG,
      create: async () => {},
    }),
    [],
  );
  const form = useCreateResourceForm(callbacks, []);
  onFields?.(form.fields);
  return (
    <CreateResourceModal
      displayName="Droplet"
      form={form}
      onClose={() => {}}
      requiredTags={requiredTags}
      renderField={(field, value, onChange) => (
        <FieldRenderer key={field.key} field={field} value={value} onChange={onChange} />
      )}
    />
  );
}

describe("create-resource tag policy prefill", () => {
  it("shows one row per required tag key", async () => {
    render(<Harness requiredTags={[{ key: "owner" }, { key: "env", allowedValues: ["prod"] }]} />);

    expect(await screen.findByDisplayValue("owner=")).toBeInTheDocument();
    expect(screen.getByDisplayValue("env=")).toBeInTheDocument();
  });

  it("keeps the prefill in form state, so an untouched form still submits it", async () => {
    let latest: Record<string, string> = {};
    render(
      <Harness
        requiredTags={[{ key: "owner" }, { key: "env" }]}
        onFields={(fields) => {
          latest = fields;
        }}
      />,
    );

    await screen.findByDisplayValue("owner=");
    await waitFor(() => expect(latest["tags"]).toBe("owner=, env="));
  });

  it("does not prefill over a value the field already has", async () => {
    // A plugin default wins: the user's own tags are not a compliance stub.
    const config: CreateResourceConfig = {
      fields: [
        {
          key: "tags",
          label: "Tags",
          kind: "string-list",
          required: false,
          defaultValue: "team=infra",
        },
      ],
    };
    function WithDefault() {
      const callbacks = useMemo(
        () => ({ loadConfig: async () => config, create: async () => {} }),
        [],
      );
      const form = useCreateResourceForm(callbacks, []);
      return (
        <CreateResourceModal
          displayName="Droplet"
          form={form}
          onClose={() => {}}
          requiredTags={[{ key: "owner" }]}
          renderField={(field, value, onChange) => (
            <FieldRenderer key={field.key} field={field} value={value} onChange={onChange} />
          )}
        />
      );
    }
    render(<WithDefault />);

    expect(await screen.findByDisplayValue("team=infra")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("owner=")).not.toBeInTheDocument();
  });
});

describe("StringListPicker value sync", () => {
  it("adopts a value that arrives after mount", () => {
    const onChange = vi.fn();
    const { rerender } = render(<StringListPicker value="" onChange={onChange} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    rerender(<StringListPicker value="owner=, env=" onChange={onChange} />);

    expect(screen.getByDisplayValue("owner=")).toBeInTheDocument();
    expect(screen.getByDisplayValue("env=")).toBeInTheDocument();
  });

  it("does not echo the parent's value back at it", () => {
    const onChange = vi.fn();
    const { rerender } = render(<StringListPicker value="a, b" onChange={onChange} />);
    rerender(<StringListPicker value="a, b" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps an in-progress edit when the parent echoes the same value back", () => {
    // The blank row a user just added serializes away, so the echoed value is
    // unchanged — adopting it here would delete the row under their cursor.
    const onChange = vi.fn();
    const { rerender } = render(<StringListPicker value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText("+ Add"));
    expect(screen.getAllByRole("textbox")).toHaveLength(2);

    rerender(<StringListPicker value="a" onChange={onChange} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  it("settles when the parent stores an unnormalized spelling of the same list", () => {
    // "a,b" and the picker's "a, b" are the same rows. The picker publishes
    // its normalized form once; a parent that keeps the original must not
    // start a re-adopt/re-publish ping-pong.
    const onChange = vi.fn();
    const { rerender } = render(<StringListPicker value="a,b" onChange={onChange} />);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("a, b");
    rerender(<StringListPicker value="a,b" onChange={onChange} />);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });
});

describe("KeyValueListPicker value sync", () => {
  const OPTIONS = [
    { id: "tcp", label: "TCP" },
    { id: "udp", label: "UDP" },
  ];

  it("adopts a value that arrives after mount", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <KeyValueListPicker value="" onChange={onChange} options={OPTIONS} />,
    );
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    rerender(
      <KeyValueListPicker
        value={JSON.stringify([
          { key: "80", value: "tcp" },
          { key: "53", value: "udp" },
        ])}
        onChange={onChange}
        options={OPTIONS}
      />,
    );

    expect(screen.getByDisplayValue("80")).toBeInTheDocument();
    expect(screen.getByDisplayValue("53")).toBeInTheDocument();
  });

  it("does not echo the parent's value back at it", () => {
    const value = JSON.stringify([{ key: "80", value: "tcp" }]);
    const onChange = vi.fn();
    const { rerender } = render(
      <KeyValueListPicker value={value} onChange={onChange} options={OPTIONS} />,
    );
    rerender(<KeyValueListPicker value={value} onChange={onChange} options={OPTIONS} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
