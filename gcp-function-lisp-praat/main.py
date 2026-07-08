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

# Energy-ratio bands (Hz). The 8–14 kHz band is the fullband-only featu re Gemini
# cannot hear (its audio ears roll off ~8 kHz) — decisive for frontal-vs-normal.
ER_MID_LO, ER_MID_HI = 3000, 8000     # 3–8 kHz
ER_HI_LO, ER_HI_HI = 8000, 14000      # 8–14 kHz
ER_LOW_LO, ER_LOW_HI = 500, 4000      # 0.5–4 kHz (lateral turbulence leaks low)


def _measure_window(snd, sr, t_start, t_end):
    """Compute Praat + FFT spectral metrics for one sibilant time window.
    Returns a dict of metrics, or {'error': ...} when the window is too short.
    """
    segment = snd.extract_part(t_start, t_end, parselmouth.WindowShape.HANNING, 1.0, False)
    seg_samples = segment.values[0]
    if len(seg_samples) < 64:
        return {'error': 'Sibilant too short'}

    spec = segment.to_spectrum()
    cog = call(spec, "Get centre of gravity", 2)
    std_dev = call(spec, "Get standard deviation", 2)
    skewness = call(spec, "Get skewness", 2)
    kurtosis = call(spec, "Get kurtosis", 2)

    # ── FFT for peak frequency and HF ratio ──
    windowed = seg_samples * np.hanning(len(seg_samples))
    fft_mag = np.abs(np.fft.rfft(windowed))
    freqs = np.fft.rfftfreq(len(windowed), 1.0 / sr)

    # Sibilant band peak (3-14 kHz)
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


def analyze_word(audio_bytes, word, position='', sibilants=None):
    """Measure sibilant quality on the MFA-supplied time windows.

    sibilants: list of {start, end, label} from MFA. Each window is measured on
    this 48 kHz decode (MFA locates, Praat measures). A word has one window; a
    sentence has one per /s/. Returns the loudest segment's metrics at top level
    (backward compat) plus a 'segments' list of every measured window.
    """
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
        clip_dur = snd.values.shape[1] / sr

        if not sibilants:
            return {'word': word, 'position': position, 'error': 'No sibilant windows',
                    'segments': []}

        segments = []
        for s in sibilants:
            try:
                ts, te = float(s.get('start')), float(s.get('end'))
            except (TypeError, ValueError):
                continue
            ts = max(0.0, min(ts, clip_dur))
            te = max(0.0, min(te, clip_dur))
            if te - ts < 0.005:
                continue
            m = _measure_window(snd, sr, ts, te)
            if m.get('error'):
                continue
            m['label'] = s.get('label', '')
            m['start'] = round(ts, 3)
            m['end'] = round(te, 3)
            segments.append(m)

        if not segments:
            return {'word': word, 'position': position,
                    'error': 'No measurable sibilant', 'segments': []}

        # Primary = loudest segment (best signal for the single-value fields).
        primary = max(segments, key=lambda s: s.get('rms', 0))
        return {'word': word, 'position': position, **primary, 'segments': segments}

    except Exception as e:
        return {'word': word, 'position': position, 'error': str(e), 'segments': []}
    finally:
        if wav_path and os.path.exists(wav_path):
            os.unlink(wav_path)


@functions_framework.http
def extract_sibilant_metrics(request):
    """
    POST JSON: { "words": [{ "word": "sun", "position": "initial",
                             "audio_base64": "...",
                             "sibilants": [{ "start": 0.41, "end": 0.57 }, ...] }, ...] }
    'sibilants' are MFA time windows (seconds). Returns a JSON array of per-word
    Praat metrics; each carries a 'segments' list (one per measured window).
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
            result = analyze_word(audio_bytes, word_name, position,
                                  sibilants=entry.get('sibilants'))
            # Per-clip line so Cloud logs show whether analysis actually produced
            # numbers (and the key values) or fell over on a specific clip.
            if result.get('error'):
                print(f"[praat]   '{word_name}': ERROR {result['error']}", flush=True)
            else:
                segs = result.get('segments', [])
                print(f"[praat]   '{word_name}': {len(segs)} seg", flush=True)
                # One line per measured sibilant window so all N are visible (not just
                # the loudest). hf_ratio = energy share above 4 kHz; a correctly-cut
                # /s/,/z/ is HF-heavy (>=0.5), a mis-cut onto a vowel is not.
                for s in segs:
                    hf = s.get('hf_ratio', 0)
                    verdict = 'OK' if hf >= 0.5 else 'WEAK?' if hf >= 0.25 else 'MIS-CUT?'
                    print(
                        f"[praat]     {s.get('label', '?'):>3} "
                        f"{s.get('start')}-{s.get('end')}s "
                        f"({int(s.get('duration_ms', 0))}ms) "
                        f"CoG={s.get('center_of_gravity')}Hz "
                        f"kurt={s.get('spectral_kurtosis')} "
                        f"E_hi={s.get('energy_ratio_hi')} "
                        f"hf={hf} -> {verdict}",
                        flush=True,
                    )
            results.append(result)

        ok = sum(1 for r in results if not r.get('error'))
        print(f"[praat] done: {ok}/{len(results)} clip(s) analysed OK", flush=True)

        return (results, 200, headers)

    except Exception as e:
        traceback.print_exc()
        return ({'error': str(e)}, 500, headers)
