/**
 * The Gemini TTS path returns **raw, headerless PCM**: signed 16-bit
 * little-endian samples at 24 000 Hz, mono. There is no container, so a
 * browser `<audio>` element cannot play the bytes as-is — `audio/L16` is not
 * a type any mainstream browser decodes.
 *
 * The fix is to prepend a 44-byte canonical RIFF/WAVE header describing the
 * exact sample format, and hand the host `audio/wav`. This is the single most
 * important detail in the Gemini plugin: skip it and the Speech tab returns a
 * blob that silently fails to play.
 *
 * Header layout (canonical 44-byte PCM WAV, all multi-byte fields
 * little-endian):
 *
 * ```
 * off  size  field
 *   0     4  "RIFF"
 *   4     4  chunk size            = 36 + dataLength
 *   8     4  "WAVE"
 *  12     4  "fmt "
 *  16     4  subchunk1 size        = 16 (PCM)
 *  20     2  audio format          = 1  (linear PCM, uncompressed)
 *  22     2  channels
 *  24     4  sample rate
 *  28     4  byte rate             = rate * channels * bytesPerSample
 *  32     2  block align           = channels * bytesPerSample
 *  34     2  bits per sample
 *  36     4  "data"
 *  40     4  data size             = dataLength
 *  44     …  the PCM payload
 * ```
 */

/** Byte length of a canonical PCM WAV header. */
export const WAV_HEADER_BYTES = 44;

/** What Gemini's TTS models emit — 24 kHz, mono, signed 16-bit LE PCM. */
export const GEMINI_PCM_SAMPLE_RATE = 24000;
export const GEMINI_PCM_CHANNELS = 1;
export const GEMINI_PCM_BITS_PER_SAMPLE = 16;

/**
 * Wrap raw PCM samples in a canonical 44-byte RIFF/WAVE header.
 *
 * @param pcm             Raw little-endian PCM samples, no container.
 * @param sampleRate      Samples per second (Gemini: 24000).
 * @param channels        Interleaved channel count (Gemini: 1).
 * @param bitsPerSample   Bit depth (Gemini: 16).
 */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Uint8Array {
  if (sampleRate <= 0) throw new Error(`pcmToWav: invalid sampleRate ${sampleRate}`);
  if (channels <= 0) throw new Error(`pcmToWav: invalid channels ${channels}`);
  if (bitsPerSample <= 0 || bitsPerSample % 8 !== 0) {
    throw new Error(`pcmToWav: invalid bitsPerSample ${bitsPerSample}`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = pcm.byteLength;

  const out = new Uint8Array(WAV_HEADER_BYTES + dataLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  writeAscii(out, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(out, 8, "WAVE");

  writeAscii(out, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk is 16 bytes
  view.setUint16(20, 1, true); // 1 = linear PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  writeAscii(out, 36, "data");
  view.setUint32(40, dataLength, true);

  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}

/**
 * Convenience wrapper for the exact format Gemini's TTS models return:
 * base64 PCM in, base64 WAV out, ready to hand back as `audio/wav`.
 */
export function geminiPcmBase64ToWavBase64(pcmBase64: string): string {
  const pcm = new Uint8Array(Buffer.from(pcmBase64, "base64"));
  const wav = pcmToWav(
    pcm,
    GEMINI_PCM_SAMPLE_RATE,
    GEMINI_PCM_CHANNELS,
    GEMINI_PCM_BITS_PER_SAMPLE,
  );
  return Buffer.from(wav).toString("base64");
}

/**
 * Seconds of audio represented by a raw PCM buffer of the given length, using
 * the Gemini output format. Used to fill the Speech panel's summary line.
 */
export function geminiPcmDurationSeconds(pcmByteLength: number): number {
  const blockAlign = GEMINI_PCM_CHANNELS * (GEMINI_PCM_BITS_PER_SAMPLE / 8);
  return pcmByteLength / (GEMINI_PCM_SAMPLE_RATE * blockAlign);
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    target[offset + i] = text.charCodeAt(i);
  }
}
