import base64
import os
import subprocess
import tempfile
import traceback

import functions_framework
import imageio_ffmpeg
import numpy as np
import parselmouth
from parselmouth.praat import call

# Bundled static ffmpeg binary (opus/webm decoders included). Lets this deploy as
# a plain source function — the Python buildpack has no system ffmpeg. Resolved
# once at import so per-request cost is just the subprocess.
FFMPEG_BIN = imageio_ffmpeg.get_ffmpeg_exe()

# Target /s/ sibilant band (Hz). Capture is 48 kHz → Nyquist 24 kHz, so the full
# 3–14 kHz sibilant band survives (was capped at 10 kHz under the old 16 kHz WAV).
SIBILANT_MIN_HZ = 3000
SIBILANT_MAX_HZ = 14000
TARGET_CENTER_HZ = 7000
TARGET_BAND_MIN = 5000
TARGET_BAND_MAX = 9000
HF_CUTOFF_HZ = 4000

# Energy-ratio bands (Hz). The 8–14 kHz band is the fullband-only feature Gemini
# cannot hear (its audio ears roll off ~8 kHz) — decisive for frontal-vs-normal.
ER_MID_LO, ER_MID_HI = 3000, 8000     # 3–8 kHz
ER_HI_LO, ER_HI_HI = 8000, 14000      # 8–14 kHz
ER_LOW_LO, ER_LOW_HI = 500, 4000      # 0.5–4 kHz (lateral turbulence leaks low)


def analyze_word(audio_bytes, word, position=''):
    """Analyze a single word recording for sibilant /s/ quality using Praat."""
    wav_path = None
    try:
        # Convert browser audio (WebM) to WAV via ffmpeg
        with tempfile.NamedTemporaryFile(suffix='.audio', delete=False) as f_in:
            f_in.write(audio_bytes)
            in_path = f_in.name

        wav_path = in_path.replace('.audio', '.wav')
        # 48 kHz WAV (Nyquist 24 kHz) preserves the full 3–14 kHz sibilant band.
        # 16 kHz here silently clipped everything above 8 kHz — half the /s/ energy.
        subprocess.run([
            FFMPEG_BIN, '-y', '-i', in_path,
            '-ac', '1', '-ar', '48000', '-acodec', 'pcm_s16le',
            wav_path
        ], capture_output=True, check=True, timeout=30)
        os.unlink(in_path)

        snd = parselmouth.Sound(wav_path)
        sr = snd.sampling_frequency
        samples = snd.values[0]
        n = len(samples)

        # ── Find sibilant segment (highest HF energy region) ──
        frame_size = int(0.025 * sr)  # 25ms
        hop = int(0.010 * sr)         # 10ms
        best_energy = 0
        best_center = n // 2

        for start in range(0, n - frame_size, hop):
            frame = samples[start:start + frame_size]
            window = np.hanning(len(frame))
            spectrum = np.abs(np.fft.rfft(frame * window))
            freqs = np.fft.rfftfreq(len(frame), 1.0 / sr)
            hf_energy = np.sum(spectrum[freqs >= HF_CUTOFF_HZ] ** 2)
            if hf_energy > best_energy:
                best_energy = hf_energy
                best_center = start + frame_size // 2

        # Expand around peak to capture full sibilant (~50-150ms)
        half_win = int(0.050 * sr)
        seg_start = max(0, best_center - half_win)
        seg_end = min(n, best_center + half_win)

        # Extend while HF energy stays above threshold
        threshold = best_energy * 0.15
        while seg_start > 0:
            cs = max(0, seg_start - hop)
            frame = samples[cs:cs + frame_size]
            if len(frame) < frame_size:
                break
            spectrum = np.abs(np.fft.rfft(frame * np.hanning(len(frame))))
            freqs = np.fft.rfftfreq(len(frame), 1.0 / sr)
            if np.sum(spectrum[freqs >= HF_CUTOFF_HZ] ** 2) < threshold:
                break
            seg_start = cs

        while seg_end < n:
            ce = min(n, seg_end + hop)
            frame = samples[seg_end:ce]
            if len(frame) < min(frame_size, hop):
                break
            spectrum = np.abs(np.fft.rfft(frame * np.hanning(len(frame))))
            freqs = np.fft.rfftfreq(len(frame), 1.0 / sr)
            if np.sum(spectrum[freqs >= HF_CUTOFF_HZ] ** 2) < threshold:
                break
            seg_end = ce

        t_start = seg_start / sr
        t_end = seg_end / sr

        # ── Praat spectral moments on sibilant segment ──
        segment = snd.extract_part(t_start, t_end, parselmouth.WindowShape.HANNING, 1.0, False)
        seg_samples = segment.values[0]
        if len(seg_samples) < 64:
            return {'word': word, 'position': position, 'error': 'Sibilant too short',
                    'sibilant_peak_hz': 0, 'center_of_gravity': 0, 'hf_ratio': 0,
                    'band_delta': 0, 'duration_ms': 0}

        spec = segment.to_spectrum()
        cog = call(spec, "Get centre of gravity", 2)
        std_dev = call(spec, "Get standard deviation", 2)
        skewness = call(spec, "Get skewness", 2)
        kurtosis = call(spec, "Get kurtosis", 2)

        # ── FFT for peak frequency and HF ratio ──
        windowed = seg_samples * np.hanning(len(seg_samples))
        fft_mag = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(len(windowed), 1.0 / sr)

        # Sibilant band peak (3-10 kHz)
        sib_mask = (freqs >= SIBILANT_MIN_HZ) & (freqs <= SIBILANT_MAX_HZ)
        if np.any(sib_mask):
            sib_freqs = freqs[sib_mask]
            peak_hz = float(sib_freqs[np.argmax(fft_mag[sib_mask])])
        else:
            peak_hz = 0.0

        # Overall peak (skip DC)
        overall_peak_hz = float(freqs[np.argmax(fft_mag[1:]) + 1])

        # HF ratio
        total_energy = np.sum(fft_mag ** 2)
        hf_energy = np.sum(fft_mag[freqs >= HF_CUTOFF_HZ] ** 2)
        hf_ratio = float(hf_energy / total_energy) if total_energy > 0 else 0.0

        # ── Band energy ratios (need 48 kHz capture to be meaningful) ──
        def band_energy(lo, hi):
            m = (freqs >= lo) & (freqs < hi)
            return float(np.sum(fft_mag[m] ** 2))

        e_mid = band_energy(ER_MID_LO, ER_MID_HI)   # 3–8 kHz
        e_hi = band_energy(ER_HI_LO, ER_HI_HI)      # 8–14 kHz (Gemini can't hear this)
        e_low = band_energy(ER_LOW_LO, ER_LOW_HI)   # 0.5–4 kHz
        # 8–14 / 3–8: fullband HF balance — decisive for frontal-vs-normal.
        energy_ratio_hi = float(e_hi / e_mid) if e_mid > 0 else 0.0
        # 0.5–4 / total: elevated low-frequency leak flags lateral turbulence.
        energy_ratio_low = float(e_low / total_energy) if total_energy > 0 else 0.0

        # RMS of the sibilant segment — quality gate for when to trust the numbers.
        rms = float(np.sqrt(np.mean(seg_samples ** 2)))

        # Centroid
        centroid_hz = float(np.sum(freqs * fft_mag) / np.sum(fft_mag)) if np.sum(fft_mag) > 0 else 0.0

        # Distance from target band
        if peak_hz < TARGET_BAND_MIN:
            band_delta = peak_hz - TARGET_BAND_MIN
        elif peak_hz > TARGET_BAND_MAX:
            band_delta = peak_hz - TARGET_BAND_MAX
        else:
            band_delta = 0

        duration_ms = (t_end - t_start) * 1000

        return {
            'word': word,
            'position': position,
            'center_of_gravity': round(cog, 1),
            'spectral_std_dev': round(std_dev, 1),
            'spectral_skewness': round(skewness, 3),
            'spectral_kurtosis': round(kurtosis, 3),
            'sibilant_peak_hz': round(peak_hz, 1),
            'overall_peak_hz': round(overall_peak_hz, 1),
            'centroid_hz': round(centroid_hz, 1),
            'hf_ratio': round(hf_ratio, 3),
            'energy_ratio_hi': round(energy_ratio_hi, 3),
            'energy_ratio_low': round(energy_ratio_low, 3),
            'rms': round(rms, 4),
            'band_delta': round(band_delta, 1),
            'target_hz': TARGET_CENTER_HZ,
            'duration_ms': round(duration_ms, 1),
        }

    except Exception as e:
        return {
            'word': word, 'position': position, 'error': str(e),
            'sibilant_peak_hz': 0, 'center_of_gravity': 0,
            'hf_ratio': 0, 'band_delta': 0, 'duration_ms': 0,
        }
    finally:
        if wav_path and os.path.exists(wav_path):
            os.unlink(wav_path)


@functions_framework.http
def extract_sibilant_metrics(request):
    """
    POST JSON: { "words": [{ "word": "sun", "position": "initial", "audio_base64": "..." }, ...] }
    Returns: JSON array of per-word Praat sibilant metrics.
    """
    # CORS
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    }
    if request.method == 'OPTIONS':
        return ('', 204, headers)

    try:
        data = request.get_json(force=True)
        words = data.get('words', [])
        if not words:
            return ({'error': 'words array required'}, 400, headers)

        print(f"[praat] request: {len(words)} clip(s)", flush=True)

        results = []
        for entry in words:
            word_name = entry.get('word', 'unknown')
            position = entry.get('position', '')
            b64 = entry.get('audio_base64', '')
            if not b64:
                print(f"[praat]   '{word_name}': SKIP (no audio)", flush=True)
                results.append({'word': word_name, 'position': position, 'error': 'No audio'})
                continue

            # Strip data URL prefix if present
            if ',' in b64:
                b64 = b64.split(',', 1)[1]

            audio_bytes = base64.b64decode(b64)
            result = analyze_word(audio_bytes, word_name, position)
            # Per-clip line so Cloud logs show whether analysis actually produced
            # numbers (and the key values) or fell over on a specific clip.
            if result.get('error'):
                print(f"[praat]   '{word_name}': ERROR {result['error']}", flush=True)
            else:
                print(
                    f"[praat]   '{word_name}': CoG={result.get('center_of_gravity')}Hz "
                    f"kurt={result.get('spectral_kurtosis')} "
                    f"E_hi={result.get('energy_ratio_hi')} "
                    f"dur={result.get('duration_ms')}ms",
                    flush=True,
                )
            results.append(result)

        ok = sum(1 for r in results if not r.get('error'))
        print(f"[praat] done: {ok}/{len(results)} clip(s) analysed OK", flush=True)

        return (results, 200, headers)

    except Exception as e:
        traceback.print_exc()
        return ({'error': str(e)}, 500, headers)
