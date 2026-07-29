/**
 * The recording half of the iOS audio session, kept out of `SpeechScreen` so
 * its failure paths are testable without an emulator.
 *
 * While `allowsRecording` is on, iOS switches the route to the earpiece and
 * plays everything back at a fraction of the volume. That is fine for the few
 * seconds a recording lasts and ruinous afterwards — a leaked session makes
 * every clip the Speech tab synthesizes later sound broken, with nothing on
 * screen to explain why. So every path that turns the session on has to come
 * back through `releaseRecordingMode`: a clean stop, a failed start, a failed
 * stop, or leaving the screen mid-recording.
 *
 * `setAudioMode` is injected rather than imported so this module stays free of
 * `expo-audio` — the screen passes `setAudioModeAsync`.
 */

export type SetAudioMode = (mode: {
  allowsRecording: boolean;
  playsInSilentMode: boolean;
}) => Promise<void>;

/**
 * Hand the audio session back to playback.
 *
 * Swallows its own errors: every caller is already on an error path or in an
 * unmount cleanup, where there is nobody left to tell and throwing would only
 * mask the original failure.
 */
export async function releaseRecordingMode(setAudioMode: SetAudioMode): Promise<void> {
  try {
    await setAudioMode({ allowsRecording: false, playsInSilentMode: true });
  } catch {
    // Best effort — see above.
  }
}

/**
 * Turn the recording session on, run `start`, and release the session again if
 * `start` throws.
 *
 * The bug this exists to prevent: enabling the session and then letting
 * `prepareToRecordAsync()` or `record()` fail leaves it on with nothing
 * recording. The error still propagates — the caller decides what to show.
 */
export async function withRecordingMode(
  setAudioMode: SetAudioMode,
  start: () => Promise<void>,
): Promise<void> {
  await setAudioMode({ allowsRecording: true, playsInSilentMode: true });
  try {
    await start();
  } catch (e) {
    await releaseRecordingMode(setAudioMode);
    throw e;
  }
}
