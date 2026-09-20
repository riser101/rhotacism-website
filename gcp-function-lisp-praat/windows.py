"""MFA-free sibilant location + per-window features.

Shared by the Cloud Run service (main.py) and the offline batch tools so the
thresholds fitted offline are the thresholds deployed. numpy only.

Pipeline per clip: peak-normalise -> 10 ms frame stats (level, ZCR, HF share)
-> noise floor (p10 level) -> strict unvoiced-fricative windows (ZCR > 0.10,
HF(>=2k) share > 0.5, level > relative floor) -> if a word is EXPECTED to carry
an /s,z/ and none was found, a relaxed pass for weak/voiced fricatives (the
interdental /s/ is quiet and low; /z/ is voiced) -> per-window frequency-domain
features. Everything is relative to the speaker/clip: no absolute Hz norms.
"""
import numpy as np

FRAME_MS = 10
MIN_WIN_MS = 40
MAX_WIN_MS = 600  # anything longer is a sustained /s/ probe; measured whole anyway


def normalise(x):
    """Peak-normalise to -1 dBFS. Returns (y, peak_dbfs_of_original)."""
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if peak <= 0:
        return x, -120.0
    return x * (0.891 / peak), 20 * np.log10(peak)


def frame_stats(x, sr):
    hop = int(sr * FRAME_MS / 1000)
    win = hop * 2
    n = max(0, (len(x) - win) // hop)
    hann = np.hanning(win)
    f = np.fft.rfftfreq(win, 1.0 / sr)
    hf_m, lo_m = f >= 2000, f > 100
    zc = np.zeros(n); hf = np.zeros(n); lv = np.zeros(n)
    for i in range(n):
        raw = x[i * hop:i * hop + win]
        seg = raw * hann
        mag = np.abs(np.fft.rfft(seg)) ** 2
        tot = mag[lo_m].sum() + 1e-12
        hf[i] = mag[hf_m].sum() / tot
        zc[i] = np.mean(np.abs(np.diff(np.sign(raw))) > 0)
        lv[i] = np.sqrt(np.mean(seg ** 2))
    return zc, hf, lv, hop


def _runs(mask, hop, sr, min_ms, gap_frames=1):
    runs, start, gap = [], None, 0
    n = len(mask)
    for i, m in enumerate(mask):
        if m:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap > gap_frames:
                end = i - gap + 1
                if (end - start) * FRAME_MS >= min_ms:
                    runs.append((start * hop / sr, end * hop / sr))
                start, gap = None, 0
    if start is not None and (n - start) * FRAME_MS >= min_ms:
        runs.append((start * hop / sr, n * hop / sr))
    return runs


def find_windows(x, sr, expect_sibilant=True, position=''):
    """Return (windows[(t0,t1,kind)], noise_rms, vowel_rms).

    kind = 'strict' (clear unvoiced fricative) or 'weak' (relaxed pass; weak,
    low, or voiced sibilant — the frontal / /z/ case). Never returns more than
    one 'weak' window: the loudest candidate inside the expected word region.
    """
    zc, hf, lv, hop = frame_stats(x, sr)
    if not len(lv):
        return [], 0.0, 0.0
    # Noise floor from frames that do NOT look like a fricative, so a sustained
    # /s/ probe (whole clip is fricative) does not become its own floor.
    fric_like = (zc > 0.10) & (hf > 0.5)
    quiet = lv[~fric_like]
    p95 = float(np.percentile(lv, 95))
    # Fewer than 5 non-fricative frames = a sustained /s/ probe: no measurable
    # floor, assume a clean capture (the level gate then falls to p95 * 0.02).
    noise = float(np.percentile(quiet, 10)) if len(quiet) >= 5 else p95 * 1e-3
    noise = max(noise, 1e-5)
    # Vowel level: 90th percentile of voiced, above-median frames.
    voiced = (zc < 0.06) & (lv > np.percentile(lv, 50))
    vowel = float(np.percentile(lv[voiced], 90)) if voiced.sum() else p95
    floor = max(noise * 3, p95 * 0.02)
    strict = (zc > 0.10) & (hf > 0.5) & (lv > floor)
    wins = [(a, b, 'strict') for a, b in _runs(strict, hop, sr, MIN_WIN_MS)]
    if not wins and expect_sibilant:
        floor2 = max(noise * 2, p95 * 0.01)
        relaxed = (zc > 0.05) & (hf > 0.15) & (lv > floor2)
        cands = _runs(relaxed, hop, sr, MIN_WIN_MS)
        if cands:
            # Position hint: initial -> earliest, final -> latest, else loudest.
            def level(w):
                a, b = int(w[0] * sr / hop), int(w[1] * sr / hop)
                return float(np.sqrt(np.mean(lv[a:b] ** 2))) if b > a else 0.0
            # Guard against vowel/nasal tails: a weak sibilant still has most
            # of its (>100 Hz) energy above 2 kHz on average.
            def hf_share(w):
                a, b = int(w[0] * sr / hop), int(w[1] * sr / hop)
                return float(np.mean(hf[a:b])) if b > a else 0.0
            cands = [c for c in cands if hf_share(c) >= 0.3]
            if cands:
                if position == 'initial':
                    c = cands[0]
                elif position == 'final':
                    c = cands[-1]
                else:
                    c = max(cands, key=level)
                wins = [(c[0], c[1], 'weak')]
    return wins, noise, vowel


def welch_features(x, sr, t0, t1, win=1024, hop=256, nfft=4096):
    """Whistle / tonality features on a Welch-averaged, 300 Hz-smoothed PSD.

    Returns welch_peak_hz, welch_prom_db (peak above a 3 kHz median baseline),
    welch_q (peak / -3 dB bandwidth), peak_conc (share of frames whose own peak
    lies within 150 Hz of the modal frame peak), peak_std_hz, spectral_edge_hz
    (highest frequency still within 30 dB of the band max — mic bandwidth guard),
    and a second, independent narrow-peak scan (narrow_peak_hz / narrow_prom_db)
    over 4–14 kHz so an in-band whistle is not masked by the broadband maximum.
    """
    a, b = int(t0 * sr), int(t1 * sr)
    seg = x[a:b]
    if len(seg) < win:
        seg = np.pad(seg, (0, win - len(seg)))
    f = np.fft.rfftfreq(nfft, 1.0 / sr)
    band = (f >= 3000) & (f <= 16000)
    fb = f[band]
    hann = np.hanning(win)
    P, peaks = [], []
    for i in range(0, max(1, len(seg) - win + 1), hop):
        p = np.abs(np.fft.rfft(seg[i:i + win] * hann, n=nfft)) ** 2
        P.append(p)
        peaks.append(fb[np.argmax(p[band])])
    P = np.array(P)
    peaks = np.array(peaks)
    avg = P.mean(0)
    db_full = 10 * np.log10(avg + 1e-20)
    db = db_full[band]
    df = f[1] - f[0]
    # 300 Hz smoothing, edge-safe.
    k = max(1, int(150 / df))
    sm = np.convolve(np.pad(db, k, mode='edge'), np.ones(2 * k + 1) / (2 * k + 1), mode='valid')
    K = max(1, int(1500 / df))
    base = np.array([np.median(sm[max(0, i - K):i + K]) for i in range(len(sm))])
    prom = sm - base
    inner = (fb >= 3500) & (fb <= 13500)
    prom_in = np.where(inner, prom, -99)
    i = int(np.argmax(prom_in))
    pk = sm[i]
    j1 = j2 = i
    while j1 > 0 and sm[j1] > pk - 3:
        j1 -= 1
    while j2 < len(sm) - 1 and sm[j2] > pk - 3:
        j2 += 1
    bw = max(fb[j2] - fb[j1], df)
    med = float(np.median(peaks))
    conc = float(np.mean(np.abs(peaks - med) < 150))
    # Spectral edge: highest freq within 30 dB of the 3-16 kHz max (bandwidth guard).
    mx = float(np.max(db))
    above = fb[db > mx - 30]
    edge = float(above.max()) if len(above) else float(fb[0])
    # Independent narrow-peak scan: raw (unsmoothed) PSD vs 600 Hz median baseline,
    # 4-14 kHz. Catches a tone sitting on the fricative's own broad maximum.
    k2 = max(1, int(300 / df))
    base2 = np.array([np.median(db[max(0, i2 - k2):i2 + k2]) for i2 in range(len(db))])
    prom2 = db - base2
    scan = (fb >= 4000) & (fb <= 14000)
    prom2_in = np.where(scan, prom2, -99)
    i2 = int(np.argmax(prom2_in))
    return {
        'welch_peak_hz': round(float(fb[i]), 1),
        'welch_prom_db': round(float(prom[i]), 1),
        'welch_q': round(float(fb[i] / bw), 1),
        'peak_conc': round(conc, 2),
        'peak_std_hz': round(float(np.std(peaks)), 1),
        'spectral_edge_hz': round(edge, 1),
        'narrow_peak_hz': round(float(fb[i2]), 1),
        'narrow_prom_db': round(float(prom2[i2]), 1),
        'n_frames': int(len(P)),
    }


def level_features(x, sr, t0, t1, noise_rms, vowel_rms):
    a, b = int(t0 * sr), int(t1 * sr)
    seg = x[a:b]
    rms = float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0
    db = lambda v: 20 * np.log10(max(v, 1e-9))
    return {
        'snr_db': round(db(rms) - db(noise_rms), 1),
        'sib_vowel_db': round(db(rms) - db(vowel_rms), 1),
    }
