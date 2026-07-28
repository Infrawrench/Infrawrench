import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { Directory, File, Paths } from "expo-file-system";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import type {
  DetailViewSchema,
  SpeechPanelCapability,
  SpeechPanelOption,
  SynthesizeSpeechPayload,
  SynthesizeSpeechResult,
  TranscribeAudioPayload,
  TranscribeAudioResult,
} from "@infrawrench/plugin-base";
import {
  CloudApiError,
  DEFAULT_ACCEPTED_AUDIO_TYPES,
  DEFAULT_MAX_AUDIO_BYTES,
  audioExtensionFor,
  audioMimeForExtension,
  audioSizeError,
  describeSynthesis,
  describeTranscript,
  formatAudioBytes,
  speechTextError,
  type CloudFetch,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, ErrorView, LoadingView, Row, RowGroup } from "@/components/ui";
import { Field, FormError, FormHint, Sheet } from "@/components/form";
import { KeyboardAvoider } from "@/components/KeyboardAvoider";
import { CheckIcon, MicIcon, PauseIcon, PlayIcon, StopIcon } from "@/components/icons";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * The mobile counterpart of the web/desktop `SpeechPanel` — the Speech tab a
 * resource picks up from `DetailViewSchema.speechPanel`. Type text and hear it
 * back, or record a clip (or pick one off the device) and read the transcript.
 *
 * Web renders this as a tab inside the resource page; on a phone it is pushed
 * as its own screen, like logs and the KV console. Everything below the wire
 * format is different from web — there is no `<audio>`, no `MediaRecorder` and
 * no Blob — so only the numbers and the wording are shared, through
 * `@infrawrench/client-core`'s speech helpers.
 *
 * Audio crosses base64 inside ordinary JSON, same as every other host.
 * `expo-file-system` does both directions natively (`write(…, base64)` and
 * `File.base64()`), so no byte-level encoding happens in JS.
 */

interface SpeechTarget {
  pluginId: string;
  accountId: string;
  resourceTypeId: string;
  resourceId: string;
  parentResourceId?: string | undefined;
}

/* ------------------------------------------------------------------ */
/* Cloud calls                                                         */
/* ------------------------------------------------------------------ */

function targetBody(target: SpeechTarget, payload: unknown): string {
  return JSON.stringify({
    pluginId: target.pluginId,
    accountId: target.accountId,
    resourceTypeId: target.resourceTypeId,
    resourceId: target.resourceId,
    payload,
    ...(target.parentResourceId ? { parentResourceId: target.parentResourceId } : {}),
  });
}

/** `POST /api/org/:orgId/resources/synthesize-speech`. */
async function synthesizeSpeech(
  api: CloudFetch,
  orgId: string,
  target: SpeechTarget,
  payload: SynthesizeSpeechPayload,
): Promise<SynthesizeSpeechResult> {
  const res = await api.org<{ result: SynthesizeSpeechResult }>(
    orgId,
    "/resources/synthesize-speech",
    { method: "POST", body: targetBody(target, payload) },
  );
  if (!res?.result?.audioBase64) throw new Error("The provider returned no audio.");
  return res.result;
}

/** `POST /api/org/:orgId/resources/transcribe-audio`. */
async function transcribeAudio(
  api: CloudFetch,
  orgId: string,
  target: SpeechTarget,
  payload: TranscribeAudioPayload,
): Promise<TranscribeAudioResult> {
  const res = await api.org<{ result: TranscribeAudioResult }>(
    orgId,
    "/resources/transcribe-audio",
    { method: "POST", body: targetBody(target, payload) },
  );
  if (!res?.result) throw new Error("The provider returned no transcript.");
  return res.result;
}

/**
 * A failed call is usually the provider talking — a bad voice id, an exhausted
 * quota. Dig the route's `{ error }` out of the body so the panel shows that
 * rather than "Cloud request failed: 400 https://…".
 */
function speechErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof CloudApiError) {
    try {
      const parsed = JSON.parse(e.body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch {
      /* not JSON — fall through to the raw message */
    }
  }
  return e instanceof Error ? e.message : fallback;
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export function SpeechScreen(target: SpeechTarget) {
  const { api, orgId } = useOrgApi();
  const { pluginId, resourceTypeId, resourceId, accountId, parentResourceId } = target;

  // Same key the resource detail screen uses, so arriving from that screen
  // reads the capability straight out of the cache instead of refetching.
  const detail = useQuery({
    queryKey: [
      "resource-detail",
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      parentResourceId ?? null,
    ],
    queryFn: () => {
      const search = new URLSearchParams({ resourceId, includePeerPanes: "false", accountId });
      if (parentResourceId) search.set("parentResourceId", parentResourceId);
      return api.org<{ detailSchema: DetailViewSchema }>(
        orgId,
        `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/detail?${search.toString()}`,
      );
    },
  });

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError) {
    return (
      <ErrorView
        message={detail.error instanceof Error ? detail.error.message : "Failed to load resource"}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const capability = detail.data?.detailSchema.speechPanel;
  if (!capability) return <EmptyView message="This resource has no speech test surface." />;

  return <SpeechBody capability={capability} target={target} api={api} orgId={orgId} />;
}

function SpeechBody({
  capability,
  target,
  api,
  orgId,
}: {
  capability: SpeechPanelCapability;
  target: SpeechTarget;
  api: CloudFetch;
  orgId: string;
}) {
  const [model, setModel] = useState(
    () => capability.defaultModel ?? capability.models?.[0]?.id ?? "",
  );

  // iOS mutes ordinary playback when the ringer switch is off; a speech test
  // that produces silence looks like a broken provider call.
  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  const showTts = capability.modes.includes("tts");
  const showStt = capability.modes.includes("stt");

  return (
    <KeyboardAvoider style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.title}>{capability.tabLabel ?? "Speech"}</Text>
          {capability.subtitle ? <Text style={styles.subtitle}>{capability.subtitle}</Text> : null}
        </View>

        {capability.disabledReason ? (
          <Card>
            <Text style={styles.disabled}>{capability.disabledReason}</Text>
          </Card>
        ) : (
          <>
            {capability.helpText ? <FormHint>{capability.helpText}</FormHint> : null}

            {capability.models && capability.models.length > 0 ? (
              <Card>
                <OptionPicker
                  label={capability.modelLabel ?? "Model"}
                  options={capability.models}
                  value={model}
                  onChange={setModel}
                />
              </Card>
            ) : null}

            {showTts ? (
              <SynthesizeSection
                capability={capability}
                model={model}
                target={target}
                api={api}
                orgId={orgId}
              />
            ) : null}

            {showStt ? (
              <TranscribeSection
                capability={capability}
                model={model}
                target={target}
                api={api}
                orgId={orgId}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </KeyboardAvoider>
  );
}

/* ------------------------------------------------------------------ */
/* Text to speech                                                      */
/* ------------------------------------------------------------------ */

interface SynthesizedClip {
  uri: string;
  /** Cache directory holding the clip — removed when the clip is replaced. */
  dirUri: string;
  fileName: string;
  summary: string;
}

function SynthesizeSection({
  capability,
  model,
  target,
  api,
  orgId,
}: {
  capability: SpeechPanelCapability;
  model: string;
  target: SpeechTarget;
  api: CloudFetch;
  orgId: string;
}) {
  const [text, setText] = useState(capability.defaultText ?? "");
  const [voice, setVoice] = useState(
    () => capability.defaultVoice ?? capability.voices?.[0]?.id ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<SynthesizedClip | null>(null);

  // Each clip gets its own cache directory: the player only reloads when the
  // source URI changes, so a stable filename would keep replaying the first
  // take. Left behind, they would accumulate for the life of the install.
  const clipRef = useRef<SynthesizedClip | null>(null);
  useEffect(() => {
    clipRef.current = clip;
  }, [clip]);
  useEffect(() => () => discardDirectory(clipRef.current?.dirUri), []);

  const maxCharacters = capability.maxCharacters;
  const overLimit = maxCharacters != null && text.length > maxCharacters;

  const run = useCallback(async () => {
    if (busy) return;
    const invalid = speechTextError(text, maxCharacters);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await synthesizeSpeech(api, orgId, target, {
        text,
        ...(voice ? { voiceId: voice } : {}),
        ...(model ? { modelId: model } : {}),
      });
      const extension = audioExtensionFor(result.mimeType);
      const fileName = safeFileName(result.fileName ?? `speech${extension}`, extension);
      const dir = new Directory(Paths.cache, `speech-${Date.now()}`);
      dir.create({ intermediates: true, idempotent: true });
      const file = new File(dir, fileName);
      file.write(result.audioBase64, { encoding: "base64" });
      setClip((prev) => {
        discardDirectory(prev?.dirUri);
        return {
          uri: file.uri,
          dirUri: dir.uri,
          fileName,
          summary: result.summary ?? describeSynthesis(file.size, result.characters),
        };
      });
    } catch (e) {
      setError(speechErrorMessage(e, "Synthesis failed"));
    } finally {
      setBusy(false);
    }
  }, [api, busy, maxCharacters, model, orgId, target, text, voice]);

  return (
    <Card>
      <Text style={styles.sectionTitle}>Text to speech</Text>

      {capability.voices && capability.voices.length > 0 ? (
        <OptionPicker
          label={capability.voiceLabel ?? "Voice"}
          options={capability.voices}
          value={voice}
          onChange={setVoice}
        />
      ) : null}

      <Field label="Text">
        <TextInput
          accessibilityLabel="Text to synthesize"
          value={text}
          onChangeText={setText}
          placeholder="Type something to hear it spoken…"
          placeholderTextColor={colors.textFaint}
          multiline
          style={styles.textArea}
        />
      </Field>

      {maxCharacters != null ? (
        <Text style={overLimit ? styles.counterOver : styles.counter}>
          {text.length} / {maxCharacters} characters
        </Text>
      ) : null}

      <FormError message={error} />

      <Button
        label={busy ? "Synthesizing…" : (capability.synthesizeLabel ?? "Synthesize")}
        disabled={busy}
        onPress={() => void run()}
      />

      {clip ? (
        <View style={styles.clipBox}>
          <ClipPlayer uri={clip.uri} />
          <View style={styles.clipFooter}>
            <Text style={styles.clipMeta} numberOfLines={1}>
              {clip.summary}
            </Text>
            <Button label="Save" variant="secondary" onPress={() => void shareClip(clip.uri)} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Speech to text                                                      */
/* ------------------------------------------------------------------ */

interface PendingAudio {
  uri: string;
  fileName: string;
  mimeType: string;
  size: number;
}

function TranscribeSection({
  capability,
  model,
  target,
  api,
  orgId,
}: {
  capability: SpeechPanelCapability;
  model: string;
  target: SpeechTarget;
  api: CloudFetch;
  orgId: string;
}) {
  const [language, setLanguage] = useState(
    () => capability.defaultLanguage ?? capability.languages?.[0]?.id ?? "",
  );
  const [audio, setAudio] = useState<PendingAudio | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TranscribeAudioResult | null>(null);
  const [showWords, setShowWords] = useState(false);

  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);
  const recording = recorderState.isRecording;

  const maxBytes = capability.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;

  const attach = useCallback(
    (next: PendingAudio) => {
      const tooBig = audioSizeError(next.size, maxBytes, next.fileName);
      if (tooBig) {
        setError(tooBig);
        return;
      }
      setError(null);
      setResult(null);
      setShowWords(false);
      setAudio(next);
    },
    [maxBytes],
  );

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setError("Microphone access was denied — grant it in Settings, or pick a clip instead.");
        return;
      }
      // iOS routes playback through the earpiece at a fraction of the volume
      // while the recording category is active, so it is turned back off in
      // `stopRecording` rather than left on for the life of the screen.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (e) {
      setError(e instanceof Error ? `Could not start recording: ${e.message}` : "Recording failed");
    }
  }, [recorder]);

  const stopRecording = useCallback(async () => {
    try {
      await recorder.stop();
      const uri = recorder.uri;
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      if (!uri) {
        setError("The recorder returned no clip.");
        return;
      }
      const file = new File(uri);
      const extension = extensionOf(uri) || ".m4a";
      attach({
        uri,
        fileName: `recording${extension}`,
        mimeType: file.type || audioMimeForExtension(extension),
        size: file.size,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recording failed");
    }
  }, [attach, recorder]);

  const pickFile = useCallback(async () => {
    setError(null);
    try {
      // The picker only understands MIME types; the capability's `accept` list
      // may also carry bare extensions, which are for the web file input.
      const declared = (capability.acceptedAudioTypes ?? DEFAULT_ACCEPTED_AUDIO_TYPES).filter((t) =>
        t.includes("/"),
      );
      const picked = await DocumentPicker.getDocumentAsync({
        type: declared.length > 0 ? declared : ["audio/*"],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      if (!asset) return;
      const extension = extensionOf(asset.name) || extensionOf(asset.uri);
      attach({
        uri: asset.uri,
        fileName: asset.name,
        mimeType: asset.mimeType ?? audioMimeForExtension(extension),
        size: asset.size ?? new File(asset.uri).size,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file");
    }
  }, [attach, capability.acceptedAudioTypes]);

  const run = useCallback(async () => {
    if (busy || !audio) return;
    const tooBig = audioSizeError(audio.size, maxBytes);
    if (tooBig) {
      setError(tooBig);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const audioBase64 = await new File(audio.uri).base64();
      const transcript = await transcribeAudio(api, orgId, target, {
        audioBase64,
        mimeType: audio.mimeType || "application/octet-stream",
        fileName: audio.fileName,
        ...(model ? { modelId: model } : {}),
        ...(language ? { language } : {}),
      });
      setResult(transcript);
      setShowWords(false);
    } catch (e) {
      setError(speechErrorMessage(e, "Transcription failed"));
    } finally {
      setBusy(false);
    }
  }, [api, audio, busy, language, maxBytes, model, orgId, target]);

  const words = result?.words ?? [];

  return (
    <Card>
      <Text style={styles.sectionTitle}>Speech to text</Text>

      {capability.languages && capability.languages.length > 0 ? (
        <OptionPicker
          label={capability.languageLabel ?? "Language"}
          options={capability.languages}
          value={language}
          onChange={setLanguage}
        />
      ) : null}

      <View style={styles.buttonRow}>
        {recording ? (
          <IconButton
            label="Stop recording"
            tone="danger"
            icon={<StopIcon color="#fff" size={16} />}
            onPress={() => void stopRecording()}
          />
        ) : (
          <IconButton
            label="Record"
            icon={<MicIcon color={colors.textSecondary} size={16} />}
            disabled={busy}
            onPress={() => void startRecording()}
          />
        )}
        <Button
          label="Pick a clip"
          variant="secondary"
          disabled={busy || recording}
          onPress={() => void pickFile()}
        />
      </View>

      {recording ? (
        <Text style={styles.recording} accessibilityLiveRegion="polite">
          Recording {formatClock(recorderState.durationMillis / 1000)} — speak now, then press Stop.
        </Text>
      ) : null}

      {audio ? (
        <View style={styles.clipBox}>
          <ClipPlayer uri={audio.uri} />
          <View style={styles.clipFooter}>
            <Text style={styles.clipMeta} numberOfLines={1}>
              {audio.fileName} · {formatAudioBytes(audio.size)}
            </Text>
            <Button
              label="Clear"
              variant="secondary"
              onPress={() => {
                setAudio(null);
                setResult(null);
              }}
            />
          </View>
        </View>
      ) : null}

      <FormError message={error} />

      <Button
        label={busy ? "Transcribing…" : (capability.transcribeLabel ?? "Transcribe")}
        disabled={busy || !audio || recording}
        onPress={() => void run()}
      />
      {!audio ? <FormHint>Record or pick a clip first.</FormHint> : null}

      {result ? (
        <View style={styles.transcript}>
          <Text style={result.text ? styles.transcriptText : styles.transcriptEmpty}>
            {result.text || "(no speech detected)"}
          </Text>
          <Text style={styles.clipMeta}>{result.summary ?? describeTranscript(result)}</Text>
          {words.length > 0 ? (
            <>
              <Pressable accessibilityRole="button" onPress={() => setShowWords((v) => !v)}>
                <Text style={styles.toggle}>
                  {showWords ? "Hide word timings" : `Show word timings (${words.length})`}
                </Text>
              </Pressable>
              {showWords ? (
                <View style={styles.table}>
                  <View style={styles.tableHeader}>
                    <Text style={[styles.cell, styles.cellWord, styles.cellHead]}>Word</Text>
                    <Text style={[styles.cell, styles.cellHead]}>Start</Text>
                    <Text style={[styles.cell, styles.cellHead]}>End</Text>
                    <Text style={[styles.cell, styles.cellHead]}>Speaker</Text>
                  </View>
                  {words.map((word, i) => (
                    <View key={`${word.start ?? i}-${word.text}-${i}`} style={styles.tableRow}>
                      <Text style={[styles.cell, styles.cellWord]} numberOfLines={1}>
                        {word.text}
                      </Text>
                      <Text style={styles.cell}>
                        {word.start != null ? `${word.start.toFixed(2)}s` : "—"}
                      </Text>
                      <Text style={styles.cell}>
                        {word.end != null ? `${word.end.toFixed(2)}s` : "—"}
                      </Text>
                      <Text style={styles.cell} numberOfLines={1}>
                        {word.speaker ?? "—"}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

/** Play/pause plus a clock, standing in for the web panel's `<audio controls>`. */
function ClipPlayer({ uri }: { uri: string }) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);

  const toggle = async () => {
    if (status.playing) {
      player.pause();
      return;
    }
    // A finished player sits at the end of the clip and `play()` is a no-op
    // there — rewind first so the button always does something.
    if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration)) {
      await player.seekTo(0);
    }
    player.play();
  };

  return (
    <View style={styles.playerRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "Pause" : "Play"}
        onPress={() => void toggle()}
        style={styles.playButton}
      >
        {status.playing ? (
          <PauseIcon color={colors.text} size={18} />
        ) : (
          <PlayIcon color={colors.text} size={18} />
        )}
      </Pressable>
      <Text style={styles.clipMeta}>
        {formatClock(status.currentTime)} / {formatClock(status.duration)}
      </Text>
    </View>
  );
}

/**
 * A dropdown's worth of options in a sheet. Voice lists run to dozens of
 * entries with a second line each, which is more than a chip row can carry.
 */
function OptionPicker({
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
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);
  return (
    <Field label={label} hint={selected?.description}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected?.label ?? "not set"}`}
        onPress={() => setOpen(true)}
        style={styles.select}
      >
        <Text style={selected ? styles.selectValue : styles.selectPlaceholder} numberOfLines={1}>
          {selected?.label ?? "Select…"}
        </Text>
      </Pressable>
      <Sheet
        visible={open}
        title={label}
        onClose={() => setOpen(false)}
        footer={<Button label="Close" variant="secondary" onPress={() => setOpen(false)} />}
      >
        <RowGroup>
          {options.map((option) => (
            <Row
              key={option.id}
              title={option.label}
              subtitle={option.description}
              right={
                option.id === value ? <CheckIcon color={colors.accent} size={18} /> : undefined
              }
              onPress={() => {
                onChange(option.id);
                setOpen(false);
              }}
            />
          ))}
        </RowGroup>
      </Sheet>
    </Field>
  );
}

/** Secondary button with a leading icon — the recorder's Record/Stop pair. */
function IconButton({
  label,
  icon,
  onPress,
  disabled = false,
  tone = "secondary",
}: {
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  tone?: "secondary" | "danger";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.iconButton,
        tone === "danger" && styles.iconButtonDanger,
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      {icon}
      <Text style={tone === "danger" ? styles.iconButtonDangerText : styles.iconButtonText}>
        {label}
      </Text>
    </Pressable>
  );
}

async function shareClip(uri: string): Promise<void> {
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
}

/** Best-effort cleanup — a missing directory is the state we wanted anyway. */
function discardDirectory(uri: string | undefined): void {
  if (!uri) return;
  try {
    const dir = new Directory(uri);
    if (dir.exists) dir.delete();
  } catch {
    /* cache eviction beat us to it */
  }
}

/** `.m4a` from `file:///…/recording.m4a`; empty string when there is none. */
function extensionOf(pathOrName: string): string {
  const base = pathOrName.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/**
 * Providers pick the download filename, and it lands on the user's file system
 * — keep it to one path segment with a usable extension.
 */
function safeFileName(name: string, extension: string): string {
  const cleaned = name.replace(/[/\\]+/g, "_").trim();
  if (!cleaned) return `speech${extension}`;
  return extensionOf(cleaned) ? cleaned : `${cleaned}${extension}`;
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  header: { gap: 2 },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" },
  subtitle: { color: colors.textMuted, fontSize: 13 },
  disabled: { color: colors.textMuted, fontSize: 13, fontStyle: "italic" },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  textArea: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    color: colors.text,
    fontSize: 14,
    minHeight: 110,
    padding: spacing.sm,
    textAlignVertical: "top",
  },
  counter: { color: colors.textFaint, fontSize: 11 },
  counterOver: { color: colors.danger, fontSize: 11 },
  buttonRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, alignItems: "center" },
  recording: { color: colors.danger, fontSize: 12 },
  clipBox: {
    backgroundColor: colors.surfaceOverlay,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.sm,
  },
  clipFooter: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  clipMeta: { color: colors.textMuted, flex: 1, fontSize: 11 },
  playerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  playButton: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: 999,
    height: 40,
    width: 40,
  },
  iconButton: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.xs,
    backgroundColor: "transparent",
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  iconButtonText: { color: colors.textSecondary, fontSize: 14, fontWeight: "600" },
  iconButtonDanger: { backgroundColor: colors.danger, borderColor: colors.danger },
  iconButtonDangerText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  select: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.sm,
  },
  selectValue: { color: colors.text, fontSize: 14 },
  selectPlaceholder: { color: colors.textFaint, fontSize: 14 },
  transcript: { gap: spacing.sm },
  transcriptText: { color: colors.text, fontSize: 14 },
  transcriptEmpty: { color: colors.textFaint, fontSize: 14, fontStyle: "italic" },
  toggle: { color: colors.textMuted, fontSize: 11 },
  table: {
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    overflow: "hidden",
  },
  tableHeader: { flexDirection: "row", backgroundColor: colors.surfaceOverlay },
  tableRow: {
    flexDirection: "row",
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cell: {
    color: colors.textMuted,
    flex: 1,
    fontFamily: "monospace",
    fontSize: 11,
    paddingHorizontal: spacing.xs,
    paddingVertical: 3,
  },
  cellWord: { color: colors.text, flex: 1.4 },
  cellHead: { color: colors.textSecondary, fontWeight: "600" },
});
