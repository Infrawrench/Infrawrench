import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SelectPicker } from "../../components/create-resource/SelectPicker.js";
import {
  selectRendersAsChips,
  selectPickerColumns,
  selectOptionSecondaryLines,
  SELECT_NARROW_LABEL_LIMIT,
} from "../../components/create-resource/select-layout.js";
import { RegionPicker } from "../../components/create-resource/RegionPicker.js";
import { DiskPicker } from "../../components/create-resource/DiskPicker.js";
import { DiskSlider } from "../../components/create-resource/DiskSlider.js";
import { SizeCard } from "../../components/create-resource/SizeCard.js";
import { SizePicker } from "../../components/create-resource/SizePicker.js";
import { ImageRow } from "../../components/create-resource/ImageRow.js";
import { ImagePicker } from "../../components/create-resource/ImagePicker.js";
import { DatetimePicker } from "../../components/create-resource/DatetimePicker.js";
import { KeyValueListPicker } from "../../components/create-resource/KeyValueListPicker.js";
import { StringListPicker } from "../../components/create-resource/StringListPicker.js";
import { ResourcePicker } from "../../components/create-resource/ResourcePicker.js";
import type { SizeOption, ImageOption, DiskOption } from "@infrawrench/plugin-base";
import type { ResourcePickerOption } from "../../components/create-resource/ResourcePicker.js";

describe("SelectPicker", () => {
  const options = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
  ];

  it("renders all options and selects on click", () => {
    const onChange = vi.fn();
    render(<SelectPicker options={options} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole("option", { name: /Beta/ }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("filters options by search", () => {
    render(<SelectPicker options={options} value="a" onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search options"), { target: { value: "bet" } });
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("shows No matches when search excludes everything", () => {
    render(<SelectPicker options={options} value="a" onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search options"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("renders an option description as a second line", () => {
    render(
      <SelectPicker
        options={[
          { id: "gpu-h100x1-80gb", label: "gpu-h100x1-80gb", description: "1× GPU · $3219/mo" },
        ]}
        value=""
        onChange={vi.fn()}
      />,
    );
    // The price is its own element, so nothing clips it out of the label line.
    expect(screen.getByText("1× GPU · $3219/mo")).toBeInTheDocument();
  });

  it("matches a search against the description", () => {
    render(
      <SelectPicker
        options={[
          { id: "gpu-h100x1-80gb", label: "gpu-h100x1-80gb", description: "1× GPU · $3219/mo" },
          { id: "gpu-l40sx1-48gb", label: "gpu-l40sx1-48gb", description: "1× GPU · $1099/mo" },
        ]}
        value=""
        onChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search options"), { target: { value: "3219" } });
    expect(screen.getByText("gpu-h100x1-80gb")).toBeInTheDocument();
    expect(screen.queryByText("gpu-l40sx1-48gb")).not.toBeInTheDocument();
  });

  it("gives long labels the full width instead of a half-width column", () => {
    const { rerender } = render(<SelectPicker options={options} value="a" onChange={vi.fn()} />);
    const grid = () => screen.getByRole("listbox").firstElementChild!;
    expect(grid().className).toContain("grid-cols-2");

    rerender(
      <SelectPicker
        options={[...options, { id: "c", label: "External Managed (Global Application LB)" }]}
        value="a"
        onChange={vi.fn()}
      />,
    );
    expect(grid().className).toContain("grid-cols-1");
  });

  it("shows the id under the label only when they differ", () => {
    render(
      <SelectPicker
        options={[
          { id: "same", label: "same" },
          { id: "id-b", label: "Beta" },
        ]}
        value=""
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("id-b")).toBeInTheDocument();
    expect(screen.getAllByText("same")).toHaveLength(1);
  });
});

describe("select-layout", () => {
  it("keeps short option sets on the chip row", () => {
    expect(
      selectRendersAsChips([
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ]),
    ).toBe(true);
  });

  it("routes options with a description to the picker, which has room for one", () => {
    expect(
      selectRendersAsChips([
        { id: "a", label: "Alpha", description: "1× GPU · $3219/mo" },
        { id: "b", label: "Beta" },
      ]),
    ).toBe(false);
  });

  it("routes long or numerous options to the picker", () => {
    expect(selectRendersAsChips([{ id: "a", label: "a".repeat(40) }])).toBe(false);
    expect(
      selectRendersAsChips(
        Array.from({ length: 5 }, (_, i) => ({ id: String(i), label: `Option ${i}` })),
      ),
    ).toBe(false);
  });

  it("leaves an empty option list on the chip branch so nothing renders", () => {
    expect(selectRendersAsChips([])).toBe(true);
  });

  it("picks one column as soon as any label outgrows a narrow cell", () => {
    expect(selectPickerColumns([{ id: "a", label: "Alpha" }])).toBe(2);
    expect(
      selectPickerColumns([
        { id: "a", label: "Alpha" },
        { id: "b", label: "b".repeat(SELECT_NARROW_LABEL_LIMIT + 1) },
      ]),
    ).toBe(1);
  });

  it("does not widen the grid for a long description alone", () => {
    // Descriptions render at 11px on their own line, so they fit a narrow cell.
    expect(selectPickerColumns([{ id: "a", label: "Alpha", description: "d".repeat(40) }])).toBe(2);
  });

  it("suppresses the id line when it duplicates the label", () => {
    expect(selectOptionSecondaryLines({ id: "x", label: "x" })).toEqual({
      description: null,
      id: null,
    });
    expect(selectOptionSecondaryLines({ id: "x", label: "Ex", description: "d" })).toEqual({
      description: "d",
      id: "x",
    });
  });
});

describe("RegionPicker", () => {
  const regions = [
    { id: "nyc1", label: "NYC", location: "New York", flag: "🇺🇸", availableFor: ["pg"] },
    { id: "ams3", label: "AMS", location: "Amsterdam", flag: "🇳🇱", availableFor: ["mysql"] },
  ];

  it("renders regions and selects on click", () => {
    const onChange = vi.fn();
    render(<RegionPicker regions={regions} value="nyc1" onChange={onChange} />);
    fireEvent.click(screen.getByRole("option", { name: /Amsterdam/ }));
    expect(onChange).toHaveBeenCalledWith("ams3");
  });

  it("filters by location search", () => {
    render(<RegionPicker regions={regions} value="nyc1" onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search regions"), { target: { value: "amsterdam" } });
    expect(screen.getByText("Amsterdam")).toBeInTheDocument();
    expect(screen.queryByText("New York")).not.toBeInTheDocument();
  });

  it("scopes regions by filterValue", () => {
    render(<RegionPicker regions={regions} value="nyc1" onChange={vi.fn()} filterValue="pg" />);
    const listbox = screen.getByRole("listbox", { name: "Regions" });
    expect(within(listbox).getByText("New York")).toBeInTheDocument();
    expect(within(listbox).queryByText("Amsterdam")).not.toBeInTheDocument();
  });

  it("resets to the first scoped option when value is out of scope", () => {
    const onChange = vi.fn();
    render(<RegionPicker regions={regions} value="ams3" onChange={onChange} filterValue="pg" />);
    expect(onChange).toHaveBeenCalledWith("nyc1");
  });
});

describe("DiskPicker", () => {
  const disks: DiskOption[] = [
    { id: "d1", label: "data-disk", sizeGb: 100, zone: "nyc1", diskType: "ssd" },
  ] as DiskOption[];

  it("renders a message when there are no disks", () => {
    render(<DiskPicker disks={[]} value="" onChange={vi.fn()} />);
    expect(screen.getByText(/No existing disks/)).toBeInTheDocument();
  });

  it("selects a disk on click", () => {
    const onChange = vi.fn();
    render(<DiskPicker disks={disks} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("option", { name: /data-disk/ }));
    expect(onChange).toHaveBeenCalledWith("d1");
  });

  it("filters disks by search", () => {
    render(<DiskPicker disks={disks} value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search disks"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});

describe("DiskSlider", () => {
  it("renders the current value and bounds, and emits changes", () => {
    const onChange = vi.fn();
    render(<DiskSlider value={50} min={10} max={100} step={10} onChange={onChange} />);
    expect(screen.getByText("50 GB")).toBeInTheDocument();
    expect(screen.getByText("10 GB")).toBeInTheDocument();
    expect(screen.getByText("100 GB")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Disk size in GB"), { target: { value: "70" } });
    expect(onChange).toHaveBeenCalledWith(70);
  });
});

describe("SizeCard", () => {
  const size: SizeOption = {
    id: "s-1",
    label: "s-1vcpu-2gb",
    vcpus: 1,
    memoryMb: 2048,
    diskGb: 50,
    priceMonthly: 12,
  } as SizeOption;

  it("renders label, specs and price and emits select", () => {
    const onSelect = vi.fn();
    render(
      <SizeCard size={size} selected={false} maxMemory={4096} maxCpu={4} onSelect={onSelect} />,
    );
    expect(screen.getByText("s-1vcpu-2gb")).toBeInTheDocument();
    expect(screen.getByText("2 GB")).toBeInTheDocument();
    expect(screen.getByText("$12/mo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("renders MB label for sub-GB memory", () => {
    const small = { ...size, memoryMb: 512, priceMonthly: 0 } as SizeOption;
    render(<SizeCard size={small} selected maxMemory={2048} maxCpu={4} onSelect={vi.fn()} />);
    expect(screen.getByText("512 MB")).toBeInTheDocument();
  });
});

describe("SizePicker", () => {
  const sizes: SizeOption[] = [
    { id: "s1", label: "small", vcpus: 1, memoryMb: 1024, category: "Basic" },
    { id: "s2", label: "large", vcpus: 4, memoryMb: 8192, category: "CPU-Optimized" },
  ] as SizeOption[];

  it("renders categories and toggles them open", () => {
    render(<SizePicker sizes={sizes} value="s1" onChange={vi.fn()} />);
    expect(screen.getByText("Basic")).toBeInTheDocument();
    expect(screen.getByText("CPU-Optimized")).toBeInTheDocument();
    // Selected category (Basic) is open by default, so its card is visible.
    expect(screen.getByText("small")).toBeInTheDocument();
  });

  it("selects a size on card click", () => {
    const onChange = vi.fn();
    render(<SizePicker sizes={sizes} value="s1" onChange={onChange} />);
    fireEvent.click(screen.getByText("small").closest("button")!);
    expect(onChange).toHaveBeenCalledWith("s1");
  });

  it("opens a collapsed category when its header is clicked", () => {
    render(<SizePicker sizes={sizes} value="s1" onChange={vi.fn()} />);
    expect(screen.queryByText("large")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("CPU-Optimized").closest("button")!);
    expect(screen.getByText("large")).toBeInTheDocument();
  });
});

describe("ImageRow", () => {
  const img: ImageOption = { id: "ubuntu-22", label: "Ubuntu 22.04", isOwned: true } as ImageOption;

  it("renders label and owned tag, fires select", () => {
    const onSelect = vi.fn();
    render(<ImageRow img={img} selected={false} onSelect={onSelect} />);
    expect(screen.getByText("Ubuntu 22.04")).toBeInTheDocument();
    expect(screen.getByText("owned")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

describe("ImagePicker", () => {
  const images: ImageOption[] = [
    { id: "ubuntu-22", label: "Ubuntu 22.04", category: "Linux" },
    { id: "win", label: "Windows Server 2022", category: "Windows" },
  ] as ImageOption[];

  it("renders categorised images by default", () => {
    render(<ImagePicker images={images} value="ubuntu-22" onChange={vi.fn()} />);
    expect(screen.getByText("Linux")).toBeInTheDocument();
    expect(screen.getByText("Windows")).toBeInTheDocument();
    const listbox = screen.getByRole("listbox", { name: "Images" });
    expect(within(listbox).getByText("Ubuntu 22.04")).toBeInTheDocument();
  });

  it("flattens to search results and selects", () => {
    const onChange = vi.fn();
    render(<ImagePicker images={images} value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Search images"), { target: { value: "ubuntu" } });
    expect(screen.queryByText("Windows Server 2022")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Ubuntu 22.04").closest("button")!);
    expect(onChange).toHaveBeenCalledWith("ubuntu-22");
  });

  it("shows No matches when search is empty of results", () => {
    render(<ImagePicker images={images} value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search images"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});

describe("DatetimePicker", () => {
  it("renders a date input in date mode and stores the raw value", () => {
    const onChange = vi.fn();
    render(<DatetimePicker value="" onChange={onChange} mode="date" />);
    const input = screen.getByLabelText("Date") as HTMLInputElement;
    expect(input.type).toBe("date");
    fireEvent.change(input, { target: { value: "2025-01-15" } });
    expect(onChange).toHaveBeenCalledWith("2025-01-15");
  });

  it("converts datetime-local input to epoch-ms when mode is epoch-ms", () => {
    const onChange = vi.fn();
    render(<DatetimePicker value="" onChange={onChange} mode="epoch-ms" />);
    const input = screen.getByLabelText("Date and time") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2025-01-15T12:00" } });
    const arg = onChange.mock.calls[0]![0];
    expect(Number(arg)).toBe(Date.UTC(2025, 0, 15, 12, 0, 0));
  });

  it("prefills an existing epoch-ms value", () => {
    const ms = Date.UTC(2025, 5, 1, 8, 30, 0);
    render(<DatetimePicker value={String(ms)} onChange={vi.fn()} mode="epoch-ms" />);
    const input = screen.getByLabelText("Date and time") as HTMLInputElement;
    expect(input.value).toBe("2025-06-01T08:30");
  });
});

describe("KeyValueListPicker", () => {
  const options = [
    { id: "asc", label: "Asc" },
    { id: "desc", label: "Desc" },
  ];

  it("emits serialized JSON when a key is typed", () => {
    const onChange = vi.fn();
    render(
      <KeyValueListPicker
        value=""
        onChange={onChange}
        options={options}
        keyName="fieldPath"
        valueName="order"
        keyPlaceholder="field"
      />,
    );
    fireEvent.change(screen.getByLabelText("field"), { target: { value: "name" } });
    const lastCall = onChange.mock.calls.at(-1)![0];
    expect(JSON.parse(lastCall)).toEqual([{ fieldPath: "name", order: "asc" }]);
  });

  it("adds and removes rows", () => {
    const onChange = vi.fn();
    render(
      <KeyValueListPicker value="" onChange={onChange} options={options} addLabel="+ Add field" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ Add field" }));
    // Two rows now -> two remove buttons.
    expect(screen.getAllByRole("button", { name: "Remove row" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove row" })[0]!);
    expect(screen.getAllByRole("button", { name: "Remove row" })).toHaveLength(1);
  });

  it("parses an existing serialized value", () => {
    const value = JSON.stringify([{ key: "a", value: "desc" }]);
    render(<KeyValueListPicker value={value} onChange={vi.fn()} options={options} />);
    const input = screen.getByDisplayValue("a");
    expect(input).toBeInTheDocument();
  });
});

describe("StringListPicker", () => {
  it("emits a comma-joined value when a row is typed", () => {
    const onChange = vi.fn();
    render(<StringListPicker value="" onChange={onChange} placeholder="email" />);
    fireEvent.change(screen.getByLabelText("email"), { target: { value: "me@a.com" } });
    expect(onChange.mock.calls.at(-1)![0]).toBe("me@a.com");
  });

  it("renders one row per entry from an existing comma-separated value", () => {
    render(<StringListPicker value="me@a.com, @b.com" onChange={vi.fn()} placeholder="email" />);
    expect(screen.getByDisplayValue("me@a.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("@b.com")).toBeInTheDocument();
  });

  it("adds and removes rows, joining non-empty entries", () => {
    const onChange = vi.fn();
    render(<StringListPicker value="a@x.com" onChange={onChange} addLabel="+ Add email" />);
    fireEvent.click(screen.getByRole("button", { name: "+ Add email" }));
    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[1]!, { target: { value: "b@x.com" } });
    expect(onChange.mock.calls.at(-1)![0]).toBe("a@x.com, b@x.com");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(onChange.mock.calls.at(-1)![0]).toBe("b@x.com");
  });

  it("expands a pasted comma-separated blob into multiple rows", () => {
    const onChange = vi.fn();
    render(<StringListPicker value="" onChange={onChange} placeholder="tag" />);
    fireEvent.paste(screen.getByLabelText("tag"), {
      clipboardData: { getData: () => "one, two, three" },
    });
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
    expect(onChange.mock.calls.at(-1)![0]).toBe("one, two, three");
  });
});

describe("ResourcePicker", () => {
  const resources: ResourcePickerOption[] = [
    {
      id: "r1",
      label: "my-db",
      pluginId: "do",
      resourceTypeId: "db",
      accountId: "a1",
      outputKey: "host",
      outputValue: "db.example.com",
    },
  ];

  it("shows an empty message with no resources", () => {
    render(<ResourcePicker resources={[]} value="" onChange={vi.fn()} />);
    expect(screen.getByText(/No compatible resources/)).toBeInTheDocument();
  });

  it("emits the literal output value when selected (non-reference mode)", () => {
    const onChange = vi.fn();
    render(<ResourcePicker resources={resources} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("option", { name: /my-db/ }));
    expect(onChange).toHaveBeenCalledWith("db.example.com");
  });

  it("emits an encoded ref in reference mode", () => {
    const onChange = vi.fn();
    render(<ResourcePicker resources={resources} value="" onChange={onChange} referenceMode />);
    fireEvent.click(screen.getByRole("option", { name: /my-db/ }));
    expect(typeof onChange.mock.calls[0]![0]).toBe("string");
    expect(onChange.mock.calls[0]![0]).not.toBe("db.example.com");
  });

  it("filters resources by search", () => {
    render(<ResourcePicker resources={resources} value="" onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search resources"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});
