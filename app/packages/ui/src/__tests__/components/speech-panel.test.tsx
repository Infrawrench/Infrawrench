import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SpeechPanelCapability } from "@infrawrench/plugin-base";
import { SpeechPanel } from "../../components/detail/SpeechPanel.js";

/**
 * jsdom implements neither object URLs nor MediaRecorder, and the panel leans
 * on both. Stub them per-test rather than in the shared setup file so the
 * absence of MediaRecorder stays testable (it drives the "upload instead"
 * fallback copy).
 */
const objectUrls = new Map<string, Blob>();

beforeEach(() => {
  let counter = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:mock/${++counter}`;
    objectUrls.set(url, blob);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => void objectUrls.delete(url));
});

afterEach(() => {
  objectUrls.clear();
  vi.unstubAllGlobals();
});

const TTS_ONLY: SpeechPanelCapability = {
  modes: ["tts"],
  voices: [
    { id: "voice-a", label: "Aria" },
    { id: "voice-b", label: "Brook" },
  ],
  models: [{ id: "model-x", label: "Model X" }],
  maxCharacters: 20,
};

const STT_ONLY: SpeechPanelCapability = {
  modes: ["stt"],
  maxAudioBytes: 64,
};

/** Give jsdom just enough MediaRecorder for the panel to offer the recorder. */
function stubMediaRecorder() {
  vi.stubGlobal(
    "MediaRecorder",
    class {
      start() {}
      stop() {}
    },
  );
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: vi.fn() } });
}

describe("SpeechPanel — text to speech", () => {
  it("passes the selected voice and model to the plugin and plays the result", async () => {
    const onSynthesize = vi.fn().mockResolvedValue({
      // "ID3" — three bytes is enough to prove the base64 round-trip.
      audioBase64: "SUQz",
      mimeType: "audio/mpeg",
      summary: "42 characters billed",
    });

    render(<SpeechPanel capability={TTS_ONLY} onSynthesize={onSynthesize} />);

    fireEvent.change(screen.getByLabelText("Text to synthesize"), { target: { value: "hello" } });
    fireEvent.change(screen.getByLabelText(/Voice/), { target: { value: "voice-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));

    await waitFor(() => expect(onSynthesize).toHaveBeenCalledTimes(1));
    expect(onSynthesize).toHaveBeenCalledWith({
      text: "hello",
      voiceId: "voice-b",
      modelId: "model-x",
    });

    // The decoded clip is what gets handed to the player, not the base64.
    await screen.findByText("42 characters billed");
    const blob = [...objectUrls.values()][0];
    expect(blob?.type).toBe("audio/mpeg");
    expect(blob?.size).toBe(3);
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "download",
      "speech.mp3",
    );
  });

  it("refuses to call the plugin when the text is over the character limit", async () => {
    const onSynthesize = vi.fn();

    render(<SpeechPanel capability={TTS_ONLY} onSynthesize={onSynthesize} />);

    fireEvent.change(screen.getByLabelText("Text to synthesize"), {
      target: { value: "x".repeat(21) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));

    expect(await screen.findByText(/the limit is 20/)).toBeInTheDocument();
    expect(onSynthesize).not.toHaveBeenCalled();
  });

  it("surfaces a provider error without clearing the typed text", async () => {
    const onSynthesize = vi.fn().mockRejectedValue(new Error("401 invalid api key"));

    render(<SpeechPanel capability={TTS_ONLY} onSynthesize={onSynthesize} />);

    fireEvent.change(screen.getByLabelText("Text to synthesize"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Synthesize" }));

    expect(await screen.findByText("401 invalid api key")).toBeInTheDocument();
    expect(screen.getByLabelText("Text to synthesize")).toHaveValue("hi");
  });
});

describe("SpeechPanel — speech to text", () => {
  it("rejects a clip larger than maxAudioBytes before encoding it", async () => {
    const onTranscribe = vi.fn();

    render(<SpeechPanel capability={STT_ONLY} onTranscribe={onTranscribe} />);

    const file = new File([new Uint8Array(128)], "big.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("Audio file to transcribe"), {
      target: { files: [file] },
    });

    expect(await screen.findByText(/the limit is 64 B/)).toBeInTheDocument();
    expect(onTranscribe).not.toHaveBeenCalled();
  });

  it("base64-encodes an accepted clip and renders the transcript", async () => {
    const onTranscribe = vi.fn().mockResolvedValue({
      text: "the transcript",
      summary: "1.2s of audio",
    });

    render(<SpeechPanel capability={STT_ONLY} onTranscribe={onTranscribe} />);

    // "hi" → "aGk=" once base64-encoded.
    const file = new File(["hi"], "clip.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("Audio file to transcribe"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Transcribe" }));

    await waitFor(() => expect(onTranscribe).toHaveBeenCalledTimes(1));
    expect(onTranscribe).toHaveBeenCalledWith({
      audioBase64: "aGk=",
      mimeType: "audio/wav",
      fileName: "clip.wav",
    });
    expect(await screen.findByText("the transcript")).toBeInTheDocument();
  });

  it("tells the user to upload when the browser has no MediaRecorder", () => {
    render(<SpeechPanel capability={STT_ONLY} onTranscribe={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /Record/ })).not.toBeInTheDocument();
    expect(screen.getByText(/needs a browser with MediaRecorder/)).toBeInTheDocument();
  });

  it("offers a record button when MediaRecorder is available", () => {
    stubMediaRecorder();

    render(<SpeechPanel capability={STT_ONLY} onTranscribe={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Record/ })).toBeInTheDocument();
  });

  it("hides only the recorder when the plugin sets disableRecording", () => {
    // For providers that reject WebM/MP4 — the containers MediaRecorder emits —
    // so the recorder is a guaranteed failure while uploading still works.
    stubMediaRecorder();

    render(
      <SpeechPanel
        capability={{
          ...STT_ONLY,
          disableRecording: true,
          recordingDisabledReason: "Cohere takes FLAC, MP3, OGG and WAV only.",
        }}
        onTranscribe={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Record/ })).not.toBeInTheDocument();
    expect(screen.getByText("Cohere takes FLAC, MP3, OGG and WAV only.")).toBeInTheDocument();
    // The other half of the row is untouched.
    expect(screen.getByRole("button", { name: "Upload a clip" })).toBeInTheDocument();
    expect(screen.getByLabelText("Audio file to transcribe")).toBeInTheDocument();
  });

  it("falls back to generic copy when disableRecording carries no reason", () => {
    stubMediaRecorder();

    render(
      <SpeechPanel capability={{ ...STT_ONLY, disableRecording: true }} onTranscribe={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: /Record/ })).not.toBeInTheDocument();
    expect(screen.getByText(/does not accept browser recordings/)).toBeInTheDocument();
    // Not the MediaRecorder-missing message — MediaRecorder is present here.
    expect(screen.queryByText(/needs a browser with MediaRecorder/)).not.toBeInTheDocument();
  });

  it("leaves the recorder alone when disableRecording is absent or false", () => {
    stubMediaRecorder();

    const { rerender } = render(
      <SpeechPanel capability={{ ...STT_ONLY, disableRecording: false }} onTranscribe={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Record/ })).toBeInTheDocument();

    // A capability that never heard of the flag behaves exactly as before.
    rerender(<SpeechPanel capability={STT_ONLY} onTranscribe={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Record/ })).toBeInTheDocument();
  });
});

describe("SpeechPanel — mode gating", () => {
  it("renders only the half the host wired a handler for", () => {
    render(<SpeechPanel capability={{ modes: ["tts", "stt"] }} onTranscribe={vi.fn()} />);

    expect(screen.queryByText("Text to speech")).not.toBeInTheDocument();
    expect(screen.getByText("Speech to text")).toBeInTheDocument();
  });

  it("renders disabledReason instead of any controls", () => {
    render(
      <SpeechPanel
        capability={{ modes: ["tts"], disabledReason: "Still provisioning." }}
        onSynthesize={vi.fn()}
      />,
    );

    expect(screen.getByText("Still provisioning.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Synthesize" })).not.toBeInTheDocument();
  });
});
