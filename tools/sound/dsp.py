"""Small offline DSP toolkit for Quanlet's sound design (numpy/scipy). 48 kHz, float64, stereo arrays (2, n)."""
import numpy as np
from scipy import signal

SR = 48000
RNG = np.random.default_rng(7)


def n_of(d):
    return max(1, int(round(d * SR)))


def tt(d):
    return np.arange(n_of(d)) / SR


def silence(d):
    return np.zeros((2, n_of(d)))


def mono(x):
    return x if x.ndim == 1 else x.mean(axis=0)


def stereo(x, pan=0.0):
    """Equal-power pan of a mono signal (or pass stereo through)."""
    if x.ndim == 2:
        return x
    a = (pan + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)])


def pan_move(x, p0, p1, curve=1.0):
    """Mono -> stereo with the pan travelling from p0 to p1 across the sound."""
    k = np.linspace(0, 1, len(x)) ** curve
    p = p0 + (p1 - p0) * k
    a = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)])


def pad_to(x, n):
    if x.shape[-1] >= n:
        return x[..., :n]
    w = [(0, 0)] * (x.ndim - 1) + [(0, n - x.shape[-1])]
    return np.pad(x, w)


def mix(*parts):
    """Sum signals (mono or stereo, any length) at offsets: parts are (signal, offset_seconds, gain)."""
    n = 0
    for s, off, g in parts:
        n = max(n, n_of(off) + s.shape[-1])
    out = np.zeros((2, n))
    for s, off, g in parts:
        s2 = stereo(s) if s.ndim == 1 else s
        i = n_of(off)
        out[:, i : i + s2.shape[-1]] += s2 * g
    return out


# ---------------------------------------------------------------- sources

def white(d):
    return RNG.standard_normal(n_of(d))


def pink(d):
    n = n_of(d)
    X = np.fft.rfft(RNG.standard_normal(n))
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = f[1]
    X /= np.sqrt(f)
    x = np.fft.irfft(X, n)
    return x / (np.std(x) + 1e-12)


def env(d, attack=0.002, decay=None, hold=0.0, curve=1.0, release=None):
    """Raised-cosine attack, optional hold, then exponential decay (time constant `decay`) or a release ramp."""
    t = tt(d)
    e = np.ones_like(t)
    a = max(attack, 1e-4)
    m = t < a
    e[m] = 0.5 - 0.5 * np.cos(np.pi * t[m] / a)
    if decay is not None:
        k = t > a + hold
        e[k] *= np.exp(-(t[k] - a - hold) / decay)
    if release is not None:
        r0 = d - release
        k = t > r0
        e[k] *= 0.5 + 0.5 * np.cos(np.pi * (t[k] - r0) / release)
    return e**curve


def fade(x, fin=0.002, fout=0.01):
    n = x.shape[-1]
    a = np.ones(n)
    i, o = min(n_of(fin), n // 2), min(n_of(fout), n // 2)
    a[:i] = np.linspace(0, 1, i)
    a[n - o :] *= np.linspace(1, 0, o)
    return x * a


def sine(d, f, phase=0.0):
    """Sine with a frequency that may be an array (glides); phase-continuous."""
    n = n_of(d)
    f = np.broadcast_to(np.asarray(f, float), (n,)) if np.ndim(f) else np.full(n, float(f))
    ph = 2 * np.pi * np.cumsum(f) / SR + phase
    return np.sin(ph)


def glide(d, f0, f1, shape="exp", tau=None):
    t = tt(d)
    if shape == "exp":
        return f0 * (f1 / f0) ** (t / d)
    if shape == "drop":  # fast at first, settling (an impact's pitch)
        tau = tau or d / 4
        return f1 + (f0 - f1) * np.exp(-t / tau)
    return f0 + (f1 - f0) * t / d


def modal(d, freqs, decays, amps=None, jitter=0.0):
    """Sum of damped sines: struck metal, glass, wood. Inharmonic ratios give the expensive sound."""
    t = tt(d)
    amps = amps if amps is not None else [1.0] * len(freqs)
    x = np.zeros_like(t)
    for f, dc, a in zip(freqs, decays, amps):
        f2 = f * (1 + jitter * RNG.uniform(-1, 1))
        x += a * np.exp(-t / dc) * np.sin(2 * np.pi * f2 * t + RNG.uniform(0, 2 * np.pi))
    return x


def fm(d, fc, ratio, index, idecay, adecay, attack=0.001):
    """FM glint: carrier with an index that falls away fast -> a bright edge that settles into a clean tone."""
    t = tt(d)
    I = index * np.exp(-t / idecay)
    x = np.sin(2 * np.pi * fc * t + I * np.sin(2 * np.pi * fc * ratio * t))
    return x * env(d, attack, adecay)


# ---------------------------------------------------------------- filters

def _sos(kind, f, order=2, q=None):
    nyq = SR / 2
    if kind == "bp":
        lo, hi = f
        return signal.butter(order, [max(10, lo) / nyq, min(hi, nyq * 0.98) / nyq], btype="band", output="sos")
    return signal.butter(order, min(f, nyq * 0.98) / nyq, btype={"lp": "low", "hp": "high"}[kind], output="sos")


def lp(x, f, order=2):
    return signal.sosfilt(_sos("lp", f, order), x, axis=-1)


def hp(x, f, order=2):
    return signal.sosfilt(_sos("hp", f, order), x, axis=-1)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_sos("bp", (lo, hi), order), x, axis=-1)


def reso(x, f, q):
    """A resonant peak (biquad bandpass, constant 0 dB peak)."""
    b, a = signal.iirpeak(min(f, SR / 2 * 0.97) / (SR / 2), q)
    return signal.lfilter(b, a, x, axis=-1)


def sweep(x, f0, f1, bw_oct=1.0, shape="exp", nper=1024):
    """Time-varying band: an STFT mask whose centre travels f0 -> f1 (log). For air, risers, scans."""
    n = len(x)
    f, t, Z = signal.stft(x, SR, nperseg=nper, noverlap=nper * 3 // 4, boundary="even")
    d = n / SR
    k = np.clip(t / d, 0, 1)
    if callable(shape):
        k = shape(k)
    c = f0 * (f1 / f0) ** k if shape != "lin" else f0 + (f1 - f0) * k
    ff = np.maximum(f, 1)[:, None]
    sig = bw_oct / 2.355
    M = np.exp(-0.5 * (np.log2(ff / c[None, :]) / sig) ** 2)
    _, y = signal.istft(Z * M, SR, nperseg=nper, noverlap=nper * 3 // 4, boundary=True)
    return pad_to(y, n)


def comb(x, delay_ms, fb=0.6):
    d = n_of(delay_ms / 1000)
    b = np.zeros(d + 1)
    b[0] = 1
    a = np.zeros(d + 1)
    a[0] = 1
    a[d] = -fb
    return signal.lfilter(b, a, x, axis=-1)


# ---------------------------------------------------------------- dynamics and colour

def sat(x, drive=1.5):
    return np.tanh(x * drive) / np.tanh(drive)


def norm_peak(x, db):
    p = np.max(np.abs(x)) + 1e-12
    return x * (10 ** (db / 20) / p)


def limit(x, ceil_db=-1.0):
    c = 10 ** (ceil_db / 20)
    return np.tanh(x / c) * c


# ---------------------------------------------------------------- space

def _ir(t60, d, damp=1.0, predelay=0.012, er=True, seed=0):
    rng = np.random.default_rng(seed)
    n = n_of(d)
    t = np.arange(n) / SR
    out = np.zeros((2, n))
    bands = [(20, 200, 1.15), (200, 900, 1.0), (900, 3500, 0.78), (3500, 9000, 0.55 / damp), (9000, 20000, 0.32 / damp)]
    for ch in range(2):
        acc = np.zeros(n)
        for lo, hi, k in bands:
            nz = bp(rng.standard_normal(n), lo, hi, 2)
            acc += nz * np.exp(-6.9 * t / (t60 * k))
        out[ch] = acc
    if er:
        for ch in range(2):
            for _ in range(14):
                i = n_of(rng.uniform(0.004, 0.07))
                out[ch, i] += rng.uniform(-1, 1) * 3.0 * np.exp(-i / SR / 0.05)
    pd = n_of(predelay)
    out = np.pad(out, ((0, 0), (pd, 0)))[:, :n]
    out /= np.sqrt(np.sum(out**2) / 2) + 1e-12
    # soften the onset so the tail blooms rather than clicks
    ramp = np.minimum(1, np.arange(n) / n_of(0.006))
    return out * ramp


_IRS = {}


def space(x, t60=1.6, wet=0.25, damp=1.0, predelay=0.012, tail=None):
    """Convolution reverb with a generated, decorrelated stereo hall. Returns the dry/wet mix (stereo)."""
    x2 = stereo(x) if x.ndim == 1 else x
    key = (round(t60, 2), round(damp, 2), round(predelay, 3))
    if key not in _IRS:
        _IRS[key] = _ir(t60, t60 * 1.15, damp, predelay, seed=len(_IRS) + 3)
    ir = _IRS[key]
    tail = tail if tail is not None else t60
    n = x2.shape[-1] + n_of(tail)
    y = np.zeros((2, n))
    for ch in range(2):
        w = signal.fftconvolve(x2[ch], ir[ch])[:n]
        y[ch, : len(w)] += w * wet
        y[ch, : x2.shape[-1]] += x2[ch] * (1 - wet * 0.5)
    return y


def widen(x, ms=9.0, amount=0.5):
    """Haas-style width for a mono source: the right channel slightly late and filtered."""
    m = mono(x)
    d = n_of(ms / 1000)
    r = np.pad(m, (d, 0))[: len(m)]
    r = lp(r, 9000, 1)
    return np.stack([m, m * (1 - amount) + r * amount])


def reverse_swell(x, t60=1.8, d=0.7):
    """A reversed reverb of `x` that rises into its start: the swell is returned, ending at x's onset."""
    tail = space(x, t60=t60, wet=1.0, predelay=0.0, tail=d + 0.2)
    tail = tail[:, n_of(0.004) : n_of(0.004) + n_of(d)]
    sw = tail[:, ::-1]
    sw = sw * np.linspace(0, 1, sw.shape[-1]) ** 1.5
    return sw
