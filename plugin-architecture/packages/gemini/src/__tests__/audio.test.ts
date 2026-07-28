import { describe, expect, it } from "vitest";
import {
  GEMINI_PCM_BITS_PER_SAMPLE,
  GEMINI_PCM_CHANNELS,
  GEMINI_PCM_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  geminiPcmBase64ToWavBase64,
  geminiPcmDurationSeconds,
  pcmToWav,
} from "../audio.js";

/**
 * Known-good reference header for 24 000 Hz / mono / 16-bit PCM with a
 * 4-byte payload, byte-for-byte. Derived by hand from the canonical RIFF
 * layout so the test fails if the implementation drifts, rather than merely
 * agreeing with itself.
 *
 *   RIFF | 36 + 4 = 40 | WAVE | fmt  | 16 | 1 | 1 | 24000 | 48000 | 2 | 16 | data | 4
 */
const REFERENCE_HEADER = Uint8Array.from([
  // "RIFF"
  0x52, 0x49, 0x46, 0x46,
  // chunk size 40 = 0x28, little-endian
  0x28, 0x00, 0x00, 0x00,
  // "WAVE"
  0x57, 0x41, 0x56, 0x45,
  // "fmt "
  0x66, 0x6d, 0x74, 0x20,
  // subchunk1 size 16
  0x10, 0x00, 0x00, 0x00,
  // audio format 1 (PCM)
  0x01, 0x00,
  // channels 1
  0x01, 0x00,
  // sample rate 24000 = 0x5DC0
  0xc0, 0x5d, 0x00, 0x00,
  // byte rate 48000 = 0xBB80
  0x80, 0xbb, 0x00, 0x00,
  // block align 2
  0x02, 0x00,
  // bits per sample 16
  0x10, 0x00,
  // "data"
  0x64, 0x61, 0x74, 0x61,
  // data size 4
  0x04, 0x00, 0x00, 0x00,
]);

describe("pcmToWav", () => {
  it("emits the exact canonical 44-byte header for Gemini's 24kHz mono 16-bit output", () => {
    const pcm = Uint8Array.from([0x01, 0x02, 0x03, 0x04]);
    const wav = pcmToWav(pcm, 24000, 1, 16);

    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcm.byteLength);
    expect(Array.from(wav.subarray(0, WAV_HEADER_BYTES))).toEqual(Array.from(REFERENCE_HEADER));
  });

  it("appends the PCM payload verbatim after the header", () => {
    const pcm = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const wav = pcmToWav(pcm, GEMINI_PCM_SAMPLE_RATE, GEMINI_PCM_CHANNELS, 16);
    expect(Array.from(wav.subarray(WAV_HEADER_BYTES))).toEqual(Array.from(pcm));
  });

  it("computes byteRate and blockAlign from channels and bit depth", () => {
    // Stereo 48 kHz 16-bit: blockAlign 4, byteRate 192000 (0x2EE00).
    const wav = pcmToWav(new Uint8Array(8), 48000, 2, 16);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(48000); // sample rate
    expect(view.getUint32(28, true)).toBe(192000); // byte rate
    expect(view.getUint16(32, true)).toBe(4); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("keeps the RIFF chunk size at 36 + data length", () => {
    const wav = pcmToWav(new Uint8Array(1024), 24000, 1, 16);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(4, true)).toBe(36 + 1024);
    expect(view.getUint32(40, true)).toBe(1024);
  });

  it("handles an empty payload without corrupting the header", () => {
    const wav = pcmToWav(new Uint8Array(0), 24000, 1, 16);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES);
    expect(view.getUint32(4, true)).toBe(36);
    expect(view.getUint32(40, true)).toBe(0);
  });

  it("rejects nonsensical formats", () => {
    expect(() => pcmToWav(new Uint8Array(2), 0, 1, 16)).toThrow(/sampleRate/);
    expect(() => pcmToWav(new Uint8Array(2), 24000, 0, 16)).toThrow(/channels/);
    expect(() => pcmToWav(new Uint8Array(2), 24000, 1, 12)).toThrow(/bitsPerSample/);
  });
});

describe("geminiPcmBase64ToWavBase64", () => {
  it("round-trips base64 PCM into base64 WAV with the payload intact", () => {
    const pcm = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const wavBase64 = geminiPcmBase64ToWavBase64(Buffer.from(pcm).toString("base64"));
    const wav = new Uint8Array(Buffer.from(wavBase64, "base64"));

    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + pcm.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(Array.from(wav.subarray(WAV_HEADER_BYTES))).toEqual(Array.from(pcm));
  });
});

describe("geminiPcmDurationSeconds", () => {
  it("reports one second for one second's worth of 24kHz mono 16-bit samples", () => {
    const oneSecond =
      GEMINI_PCM_SAMPLE_RATE * GEMINI_PCM_CHANNELS * (GEMINI_PCM_BITS_PER_SAMPLE / 8);
    expect(geminiPcmDurationSeconds(oneSecond)).toBeCloseTo(1, 6);
    expect(geminiPcmDurationSeconds(oneSecond / 2)).toBeCloseTo(0.5, 6);
  });
});
