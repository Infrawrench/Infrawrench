import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SpeechPanelCapability,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
} from "@infrawrench/plugin-base";

/** Fallback cap when a plugin doesn't declare one — the smallest limit we ship against. */
const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const DEFAULT_ACCEPTED_AUDIO_TYPES = [
  "audio/*",
  ".mp3",
  ".wav",
  ".m4a",
  ".flac",
  ".ogg",
  ".webm",
  ".mp4",
];

interface Props {
  capability: SpeechPanelCapability;
  /**
   * Synthesize one clip. Host wraps this around an IPC call or a POST to
   * /resources/synthesize-speech. Plugins may throw on provider errors; the
   * panel renders the thrown message in a red banner.
   */
  onSynthesize?: (payload: SynthesizeSpeechPayload) => Promise<SynthesizeSpeechResult>;
  /** Transcribe one clip. Same contract as `onSynthesize`. */
  onTranscribe?: (payload: TranscribeAudioPayload) => Promise<TranscribeAudioResult>;
}

export function SpeechPanel({ capability, onSynthesize, onTranscribe }: Props) {
  const showTts = capability.modes.includes("tts") && !!onSynthesize;
  const showStt = capability.modes.includes("stt") && !!onTranscribe;
  const disabled = !!capability.disabledReason;

  const [model, setModel] = useState(
    () => capability.defaultModel ?? capability.models?.[0]?.id ?? "",
  );

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface shrink-0">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          {capability.tabLabel ?? "Speech"}
        </span>
        {capability.subtitle && (
          <span className="text-xs text-on-surface-tertiary truncate">{capability.subtitle}</span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-6">
        {disabled ? (
          <div className="text-sm text-on-surface-tertiary italic max-w-2xl">
            {capability.disabledReason}
          </div>
        ) : (
          <>
            {capability.helpText && (
              <p className="text-xs text-on-surface-muted max-w-2xl">{capability.helpText}</p>
            )}

            {capability.models && capability.models.length > 0 && (
              <div className="max-w-sm">
                <OptionSelect
                  label={capability.modelLabel ?? "Model"}
                  options={capability.models}
                  value={model}
                  onChange={setModel}
                />
              </div>
            )}

            {showTts && (
              <SynthesizeSection
                capability={capability}
                model={model}
                onSynthesize={onSynthesize!}
              />
            )}

            {showTts && showStt && <hr className="border-border" />}

            {showStt && (
              <TranscribeSection
                capability={capability}
                model={model}
                onTranscribe={onTranscribe!}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Text to speech                                                      */
/* ------------------------------------------------------------------ */

interface SynthesizeSectionProps {
  capability: SpeechPanelCapability;
  model: string;
  onSynthesize: (payload: SynthesizeSpeechPayload) => Promise<SynthesizeSpeechResult>;
}

interface Clip {
  url: string;
  mimeType: string;
  fileName: string;
  summary: string;
  text: string;
}

function SynthesizeSection({ capability, model, onSynthesize }: SynthesizeSectionProps) {
  const [text, setText] = useState(capability.defaultText ?? "");
  const [voice, setVoice] = useState(
    () => capability.defaultVoice ?? capability.voices?.[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);

  // Object URLs are revoked when replaced and on unmount — a blob left
  // attached to a detached <audio> keeps its buffer alive for the session.
  const clipRef = useRef<Clip | null>(null);
  useEffect(() => {
    clipRef.current = clip;
  }, [clip]);
  useEffect(() => {
    return () => {
      if (clipRef.current) URL.revokeObjectURL(clipRef.current.url);
    };
  }, []);

  const maxCharacters = capability.maxCharacters;
  const overLimit = maxCharacters != null && text.length > maxCharacters;

  const run = useCallback(async () => {
    if (busy) return;
    if (!text.trim()) {
      setError("Enter some text to synthesize.");
      return;
    }
    if (overLimit) {
      setError(`Text is ${text.length} characters — the limit is ${maxCharacters}.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await onSynthesize({
        text,
        ...(voice ? { voiceId: voice } : {}),
        ...(model ? { modelId: model } : {}),
      });
      const blob = base64ToBlob(result.audioBase64, result.mimeType);
      const url = URL.createObjectURL(blob);
      setClip((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return {
          url,
          mimeType: result.mimeType,
          fileName: result.fileName ?? `speech${extensionFor(result.mimeType)}`,
          summary:
            result.summary ??
            `${formatBytes(blob.size)}${result.characters != null ? ` · ${result.characters} characters billed` : ""}`,
          text,
        };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, text, overLimit, maxCharacters, onSynthesize, voice, model]);

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
        Text to speech
      </h3>

      {capability.voices && capability.voices.length > 0 && (
        <div className="max-w-sm">
          <OptionSelect
            label={capability.voiceLabel ?? "Voice"}
            options={capability.voices}
            value={voice}
            onChange={setVoice}
          />
        </div>
      )}

      <label className="block">
        <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
          Text
        </span>
        <textarea
          aria-label="Text to synthesize"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type something to hear it spoken…"
          rows={4}
          className="mt-1 w-full resize-y bg-surface-overlay text-on-surface text-sm border border-border-strong rounded-md px-3 py-2 focus:outline-none focus:border-accent-blue placeholder:text-on-surface-faint"
        />
      </label>

      {maxCharacters != null && (
        <p className={`text-[11px] ${overLimit ? "text-red-400" : "text-on-surface-faint"}`}>
          {text.length} / {maxCharacters} characters
        </p>
      )}

      {error && <ErrorBanner message={error} />}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-md hover:bg-accent-blue/90 disabled:bg-surface-overlay disabled:text-on-surface-faint disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Synthesizing…" : (capability.synthesizeLabel ?? "Synthesize")}
        </button>
      </div>

      {clip && (
        <div className="rounded-md border border-border bg-surface-overlay px-3 py-2 space-y-2">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- generated speech of text the user just typed and can still see above; a caption track would duplicate it. */}
          <audio controls src={clip.url} className="w-full">
            Your browser does not support audio playback.
          </audio>
          <div className="flex items-center gap-3 text-[11px] text-on-surface-tertiary">
            <span className="truncate flex-1">{clip.summary}</span>
            <a
              href={clip.url}
              download={clip.fileName}
              className="text-accent-blue hover:underline shrink-0"
            >
              Download
            </a>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Speech to text                                                      */
/* ------------------------------------------------------------------ */

interface TranscribeSectionProps {
  capability: SpeechPanelCapability;
  model: string;
  onTranscribe: (payload: TranscribeAudioPayload) => Promise<TranscribeAudioResult>;
}

interface PendingAudio {
  blob: Blob;
  fileName: string;
  /** Object URL so the user can hear what they're about to send. */
  url: string;
}

function TranscribeSection({ capability, model, onTranscribe }: TranscribeSectionProps) {
  const [language, setLanguage] = useState(
    () => capability.defaultLanguage ?? capability.languages?.[0]?.id ?? "",
  );
  const [audio, setAudio] = useState<PendingAudio | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranscribeAudioResult | null>(null);
  const [showWords, setShowWords] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const audioRef = useRef<PendingAudio | null>(null);
  useEffect(() => {
    audioRef.current = audio;
  }, [audio]);
  useEffect(() => {
    return () => {
      if (audioRef.current) URL.revokeObjectURL(audioRef.current.url);
      // Stopping the recorder also releases the mic indicator, which otherwise
      // stays lit until the tab is closed.
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      for (const track of rec?.stream.getTracks() ?? []) track.stop();
    };
  }, []);

  const maxBytes = capability.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
  const accept = (capability.acceptedAudioTypes ?? DEFAULT_ACCEPTED_AUDIO_TYPES).join(",");

  const canRecord =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";

  const attach = useCallback((blob: Blob, fileName: string) => {
    setResult(null);
    setAudio((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return { blob, fileName, url: URL.createObjectURL(blob) };
    });
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        // The recorder's own mimeType is authoritative — browsers disagree
        // (webm/opus on Chromium, mp4/aac on Safari) and the plugin needs to
        // forward the real one to the provider.
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        for (const track of stream.getTracks()) track.stop();
        setRecording(false);
        if (blob.size > 0) attach(blob, `recording${extensionFor(mimeType)}`);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setRecording(false);
      setError(
        err instanceof Error
          ? `Could not start recording: ${err.message}`
          : "Could not start recording.",
      );
    }
  }, [attach]);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }, []);

  const onPickFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so re-picking the same file fires change again.
      e.target.value = "";
      if (!file) return;
      if (file.size > maxBytes) {
        setError(
          `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(maxBytes)}.`,
        );
        return;
      }
      setError(null);
      attach(file, file.name);
    },
    [attach, maxBytes],
  );

  const run = useCallback(async () => {
    if (busy || !audio) return;
    if (audio.blob.size > maxBytes) {
      setError(`Clip is ${formatBytes(audio.blob.size)} — the limit is ${formatBytes(maxBytes)}.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const audioBase64 = await blobToBase64(audio.blob);
      const transcript = await onTranscribe({
        audioBase64,
        mimeType: audio.blob.type || "application/octet-stream",
        fileName: audio.fileName,
        ...(model ? { modelId: model } : {}),
        ...(language ? { language } : {}),
      });
      setResult(transcript);
      setShowWords(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, audio, maxBytes, onTranscribe, model, language]);

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
        Speech to text
      </h3>

      {capability.languages && capability.languages.length > 0 && (
        <div className="max-w-sm">
          <OptionSelect
            label={capability.languageLabel ?? "Language"}
            options={capability.languages}
            value={language}
            onChange={setLanguage}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canRecord &&
          (recording ? (
            <button
              type="button"
              onClick={stopRecording}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-600/90 transition-colors"
            >
              ■ Stop recording
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startRecording()}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium text-on-surface bg-surface-overlay border border-border-strong rounded-md hover:border-accent-blue disabled:text-on-surface-faint disabled:cursor-not-allowed transition-colors"
            >
              ● Record
            </button>
          ))}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy || recording}
          className="px-4 py-2 text-sm font-medium text-on-surface bg-surface-overlay border border-border-strong rounded-md hover:border-accent-blue disabled:text-on-surface-faint disabled:cursor-not-allowed transition-colors"
        >
          Upload a clip
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={accept}
          onChange={onPickFile}
          className="hidden"
          aria-label="Audio file to transcribe"
        />

        {!canRecord && (
          <span className="text-[11px] text-on-surface-faint">
            Microphone recording needs a browser with MediaRecorder — upload a clip instead.
          </span>
        )}
      </div>

      {recording && (
        <p className="text-xs text-red-400" aria-live="polite">
          Recording… speak now, then press Stop.
        </p>
      )}

      {audio && (
        <div className="rounded-md border border-border bg-surface-overlay px-3 py-2 space-y-2">
          <div className="flex items-center gap-2 text-[11px] text-on-surface-tertiary">
            <span className="truncate flex-1">
              {audio.fileName} · {formatBytes(audio.blob.size)}
            </span>
            <button
              type="button"
              onClick={() => {
                URL.revokeObjectURL(audio.url);
                setAudio(null);
                setResult(null);
              }}
              className="text-on-surface-faint hover:text-red-400 shrink-0"
            >
              Clear
            </button>
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- preview of the user's own clip, played back so they can check it before sending; the transcript below is the text alternative. */}
          <audio controls src={audio.url} className="w-full" />
        </div>
      )}

      {error && <ErrorBanner message={error} />}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !audio || recording}
          className="px-4 py-2 text-sm font-medium text-white bg-accent-blue rounded-md hover:bg-accent-blue/90 disabled:bg-surface-overlay disabled:text-on-surface-faint disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Transcribing…" : (capability.transcribeLabel ?? "Transcribe")}
        </button>
        {!audio && (
          <span className="text-[11px] text-on-surface-faint">Record or upload a clip first.</span>
        )}
      </div>

      {result && (
        <div className="space-y-2">
          <div className="rounded-md border border-border bg-surface-overlay px-3 py-2">
            <p className="text-sm text-on-surface whitespace-pre-wrap">
              {result.text || (
                <span className="italic text-on-surface-faint">(no speech detected)</span>
              )}
            </p>
          </div>
          <p className="text-[11px] text-on-surface-tertiary">
            {result.summary ?? describeTranscript(result)}
          </p>
          {result.words && result.words.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowWords((v) => !v)}
                className="text-[11px] text-on-surface-faint hover:text-accent transition-colors"
              >
                {showWords ? "Hide word timings" : `Show word timings (${result.words.length})`}
              </button>
              {showWords && (
                <div className="mt-1 max-h-56 overflow-auto rounded-md border border-border">
                  <table className="w-full text-[11px] font-mono">
                    <thead className="sticky top-0 bg-surface">
                      <tr className="text-on-surface-muted">
                        <th className="text-left px-2 py-1 font-semibold">Word</th>
                        <th className="text-left px-2 py-1 font-semibold">Start</th>
                        <th className="text-left px-2 py-1 font-semibold">End</th>
                        <th className="text-left px-2 py-1 font-semibold">Speaker</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.words.map((word, i) => (
                        <tr
                          key={`${word.start ?? i}-${word.text}-${i}`}
                          className="border-t border-border"
                        >
                          <td className="px-2 py-0.5 text-on-surface">{word.text}</td>
                          <td className="px-2 py-0.5 text-on-surface-tertiary">
                            {word.start != null ? `${word.start.toFixed(2)}s` : "—"}
                          </td>
                          <td className="px-2 py-0.5 text-on-surface-tertiary">
                            {word.end != null ? `${word.end.toFixed(2)}s` : "—"}
                          </td>
                          <td className="px-2 py-0.5 text-on-surface-tertiary">
                            {word.speaker ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function OptionSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SpeechPanelOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = options.find((o) => o.id === value);
  return (
    <label className="block">
      <span className="text-xs font-semibold text-on-surface-muted uppercase tracking-wide">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full bg-surface-overlay text-on-surface text-sm border border-border-strong rounded-md px-3 py-2 focus:outline-none focus:border-accent-blue"
      >
        {!value && <option value="">Select…</option>}
        {options.map((opt) => (
          <option key={opt.id} value={opt.id}>
            {opt.label}
          </option>
        ))}
      </select>
      {selected?.description && (
        <p className="text-[11px] text-on-surface-faint mt-1">{selected.description}</p>
      )}
    </label>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="text-xs text-red-400 font-mono bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
      {message}
    </div>
  );
}

function describeTranscript(result: TranscribeAudioResult): string {
  const parts: string[] = [];
  if (result.durationSeconds != null) parts.push(`${result.durationSeconds.toFixed(1)}s of audio`);
  if (result.language) parts.push(result.language);
  if (result.confidence != null) parts.push(`${Math.round(result.confidence * 100)}% confidence`);
  return parts.join(" · ");
}

/** Decode base64 into a Blob without building a giant intermediate string. */
function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * Blob → base64 via FileReader. `readAsDataURL` yields
 * `data:<mime>;base64,<payload>`; the payload after the first comma is what
 * the plugin contract expects.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the audio clip."));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      resolve(comma === -1 ? value : value.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/** Map a MIME type to a file extension for downloads and provider filenames. */
function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
    case "audio/opus":
      return ".ogg";
    case "audio/webm":
      return ".webm";
    case "audio/mp4":
    case "audio/aac":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/flac":
      return ".flac";
    case "audio/l16":
    case "audio/pcm":
      return ".pcm";
    default:
      return ".audio";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
