"""Three sound directions for Quanlet, as short demos of the same moments, to choose one before a full set.

    python3 tools/sound/directions.py <outdir>

Each demo plays: room tone, five keys arriving and locking, the lock turning, three bolts, the door opening,
then a refusal, a signature and a payment arriving. Same timing in all three; only the sound world changes.
"""
import os
import subprocess
import sys

import numpy as np

from dsp import (SR, RNG, bp, env, fade, fm, glide, hp, limit, lp, mix, modal, mono, n_of, norm_peak, pad_to,
                 pan_move, pink, reverse_swell, sat, sine, space, stereo, sweep, tt, white, widen, comb)


def add(*xs):
    n = max(len(x) for x in xs)
    return sum(pad_to(x, n) for x in xs)


def click(d=0.006, f=5200, decay=0.0013):
    return hp(white(d), f, 2) * env(d, 0.0003, decay)


def master(x, peak_db):
    x = stereo(x) if x.ndim == 1 else x
    x = norm_peak(x, peak_db + 1.5)
    return limit(x, peak_db)


def shimmer(x, t60=3.5, wet=0.4, up=0.35):
    """A hall whose tail also sounds an octave up: the cosmic bloom."""
    y = space(x, t60, wet, damp=0.8, predelay=0.03)
    tail = y - pad_to(stereo(x) if x.ndim == 1 else x, y.shape[-1]) * (1 - wet * 0.5)
    oct_ = tail[:, ::2]
    oct_ = space(oct_, t60 * 1.2, 1.0, damp=0.7)
    return mix((y, 0, 1.0), (lp(oct_, 9000, 1), 0.04, up))


def cloud(d, f0, f1, density, gdur=(0.02, 0.08), spread=0.35, pan=0.9, inharm=True):
    """A granular cloud of sine grains whose centre travels f0 -> f1; `density` is grains per second (array or number)."""
    n = n_of(d)
    out = np.zeros((2, n))
    t = 0.0
    while t < d - 0.01:
        k = t / d
        dens = density(k) if callable(density) else density
        c = f0 * (f1 / f0) ** k
        f = c * 2 ** RNG.normal(0, spread)
        if inharm:
            f *= RNG.choice([1, 1.414, 1.732, 2.236, 2.646])
        gd = RNG.uniform(*gdur)
        g = np.sin(2 * np.pi * f * tt(gd)) * np.hanning(n_of(gd))
        s = stereo(g * RNG.uniform(0.3, 1.0), RNG.uniform(-pan, pan))
        i = n_of(t)
        m = min(s.shape[-1], n - i)
        out[:, i : i + m] += s[:, :m]
        t += RNG.exponential(1 / max(dens, 1e-3))
    return out


def bitcrush(x, bits=6, hold=6):
    y = np.round(x * 2 ** (bits - 1)) / 2 ** (bits - 1)
    return np.repeat(y[::hold], hold)[: len(x)]


KEY_FROM = [-0.85, 0.85, -0.85, 0.85, 0.15]
KEY_PAN = [-0.4, 0.4, -0.55, 0.55, 0.0]
# The demo timeline (seconds): the same in every direction.
T_KEYS = [0.6, 1.05, 1.5, 1.95, 2.4]
FLY = 0.75
T_UNLOCK = 3.5
T_BOLT = [3.5, 3.68, 3.86]
T_OPEN = 4.2
T_REFUSE = 8.2
T_SIGN = 9.8
T_PAY = 11.0
T_PAID = 11.25
LEN = 13.5


def lattice():
    """A: Quantum lattice. Crystalline, cosmic, spacious: glass particles, shimmering halls, a deep floor."""
    S = {}
    L = 9.0
    bed = lp(pink(L), 180, 2) * (0.7 + 0.3 * np.sin(2 * np.pi * 0.07 * tt(L)))
    bed = stereo(bed) * 0.8 + cloud(L, 3000, 4200, 3, (0.15, 0.4), 0.4, 0.95) * 0.08
    bed += stereo(sine(L, 36.7) * 0.3)
    S["room"] = master(space(widen(mono(bed), 15, 0.7) + bed * 0.3, 3.0, 0.3), -30)
    for i in range(5):
        # materialise: a bloom of high partials out of a short reversed breath, then a glass trail travelling
        ping = add(*[sine(0.9, f) * env(0.9, 0.004, dc) * a for f, dc, a in zip(np.array([2349, 3322, 4698, 6200]) * (1 + 0.03 * i), [0.35, 0.22, 0.14, 0.08], [1, 0.6, 0.4, 0.25])])
        trail = cloud(FLY, 5200, 2600, lambda k: 70 * (1 - k) + 10, (0.008, 0.03), 0.25, 0.3)
        trail = np.stack([pan_move(trail[0], KEY_FROM[i], KEY_PAN[i])[0], pan_move(trail[1], KEY_FROM[i], KEY_PAN[i])[1]])
        S[f"key{i}"] = master(shimmer(mix((stereo(ping, KEY_FROM[i] * 0.6), 0, 0.7), (trail, 0, 0.5)), 2.4, 0.35, 0.3), -21)
        snap = add(click(0.005, 6000, 0.0008), modal(0.4, np.array([3100, 4420, 6050]) * (1 + 0.02 * i), [0.06, 0.04, 0.025], [1, 0.6, 0.4]) * 0.5)
        floor = sine(0.2, glide(0.2, 110, 60, "drop", 0.03)) * env(0.2, 0.002, 0.05)
        S[f"lock{i}"] = master(shimmer(mix((stereo(snap, KEY_PAN[i]), 0, 1.0), (stereo(floor), 0, 0.8)), 1.8, 0.28, 0.25), -19)
    d = 0.72
    rise = cloud(d, 900, 6400, lambda k: 30 + 400 * k**2, (0.01, 0.04), 0.3, 0.9)
    rise *= np.linspace(0, 1, rise.shape[-1]) ** 2
    rise[:, n_of(0.70) :] *= 0
    sw = stereo(sweep(pink(d), 300, 5000, 1.0) * np.linspace(0, 1, n_of(d)) ** 3 * 0.4)
    sw[:, n_of(0.70) :] *= 0
    S["unlock"] = master(mix((rise, 0, 1.0), (sw, 0, 1.0), (stereo(sine(d, 41) * np.linspace(0, 1, n_of(d)) * 0.5), 0, 1.0)), -19)
    for g in range(3):
        crack = add(click(0.006, 3000, 0.0015), modal(0.5, np.array([620, 1130, 1790, 2560]) * (1 + 0.08 * g), [0.12, 0.08, 0.05, 0.03]) * 0.4)
        thud = sine(0.3, glide(0.3, 80 - 6 * g, 42, "drop", 0.04)) * env(0.3, 0.002, 0.09)
        S[f"bolt{g}"] = master(space(mix((stereo(crack, [-0.35, 0.35, 0][g]), 0, 1.0), (stereo(thud), 0, 1.1)), 1.4, 0.22), -16)
    d = 5.0
    drop = sine(d, glide(d, 66, 28, "drop", 0.35)) * env(d, 0.003, 0.9)
    bloom = add(*[sine(d, f) * env(d, 0.08 + 0.02 * k, 1.6 - 0.12 * k) * a for k, (f, a) in enumerate(zip([110, 164.8, 246.9, 369.9, 554.4, 830.6, 1244.5], [1, 0.7, 0.55, 0.4, 0.3, 0.2, 0.12]))])
    bloom = bloom * 0.18
    glass = cloud(2.6, 2400, 7000, lambda k: 140 * np.exp(-k * 3) + 6, (0.02, 0.09), 0.5, 1.0)
    rush = pan_move(sweep(pink(1.4), 200, 7000, 1.4) * env(1.4, 0.25, 0.35), -0.4, 0.4)
    op = mix((stereo(drop), 0, 1.0), (widen(bloom, 13, 0.7), 0, 1.0), (glass, 0.02, 0.35), (rush, 0, 0.4), (stereo(click(0.006, 5000)), 0, 0.5))
    S["open"] = master(shimmer(op, 4.2, 0.38, 0.4), -10)
    d = 1.8
    crackle = np.zeros(n_of(0.5))
    for _ in range(60):
        i = n_of(RNG.uniform(0, 0.45) ** 1.8)
        c = click(0.004, RNG.uniform(3000, 9000), 0.0006) * RNG.uniform(0.2, 1)
        crackle[i : i + len(c)] += c[: len(crackle) - i]
    dis = add(sine(1.2, 98) * env(1.2, 0.004, 0.4), sine(1.2, 103.8) * env(1.2, 0.004, 0.38), sine(1.2, 146.8 * 1.06) * env(1.2, 0.004, 0.25) * 0.4)
    S["refuse"] = master(shimmer(mix((widen(crackle, 7, 0.8), 0, 0.9), (stereo(lp(dis, 700, 2)), 0, 0.7), (stereo(sine(0.6, glide(0.6, 64, 34, "drop", 0.12)) * env(0.6, 0.003, 0.2)), 0, 1.0)), 2.2, 0.3, 0.2), -13)
    ping = add(*[sine(1.2, f) * env(1.2, 0.002, dc) * a for f, dc, a in zip([1174.7, 1661.2, 2349.3, 3322.4], [0.5, 0.35, 0.22, 0.12], [1, 0.6, 0.45, 0.3])])
    S["sign"] = master(shimmer(mix((stereo(click(0.005, 5000, 0.001)), 0, 0.6), (stereo(ping * 0.6, -0.3), 0.003, 1.0), (stereo(sine(0.2, glide(0.2, 100, 60, "drop", 0.03)) * env(0.2, 0.002, 0.05)), 0, 0.5)), 3.0, 0.35, 0.35), -18)
    S["pay"] = master(space(pan_move(mono(cloud(0.25, 3000, 6000, 120, (0.006, 0.02), 0.2, 0.0)), -0.3, 0.55), 1.0, 0.15), -26)
    S["paid"] = master(shimmer(stereo(add(*[sine(0.8, f) * env(0.8, 0.002, dc) * a for f, dc, a in zip([2637, 3729, 5274], [0.3, 0.18, 0.1], [1, 0.5, 0.3])]) * 0.6, 0.55), 2.4, 0.35, 0.35), -22)
    return S


def machinery():
    """B: Vault machinery. Heavy and physical: steel, hydraulics, gears, a door the size of a room."""
    S = {}
    L = 9.0
    hum = add(*[sine(L, 50 * h) / h ** 1.5 for h in range(1, 7)]) * 0.25
    S["room"] = master(space(widen(lp(pink(L), 150, 2) * 0.8 + hum, 12, 0.5), 1.6, 0.25), -30)
    for i in range(5):
        whir = sweep(pink(FLY), 300, 1800, 0.8) * env(FLY, 0.4, None, release=0.2)
        gear = add(*[click(0.004, 2200, 0.001) * (0.4 + 0.6 * k / 8) for k in range(1)])
        teeth = np.zeros(n_of(FLY))
        tk = 0.05
        while tk < FLY - 0.05:
            c = click(0.003, 1800, 0.0008)
            j = n_of(tk)
            teeth[j : j + len(c)] += c * 0.4
            tk += 0.05
        S[f"key{i}"] = master(space(pan_move(add(whir * 0.6, teeth), KEY_FROM[i], KEY_PAN[i]), 0.9, 0.15), -22)
        clunk = add(click(0.008, 2500, 0.002), modal(0.5, [310, 455, 690, 980], [0.15, 0.1, 0.07, 0.05]) * 0.6, sine(0.3, glide(0.3, 90, 50, "drop", 0.03)) * env(0.3, 0.002, 0.08))
        S[f"lock{i}"] = master(space(stereo(clunk, KEY_PAN[i]), 1.0, 0.2), -18)
    d = 0.72
    motor = add(*[sine(d, glide(d, 70 * h, 110 * h, "lin")) / h for h in range(1, 8)]) * env(d, 0.05, None) * 0.35
    ratchet = np.zeros(n_of(d))
    tk = 0.02
    while tk < 0.66:
        c = click(0.005, 1500, 0.0012)
        j = n_of(tk)
        ratchet[j : j + len(c)] += c * (0.4 + 0.6 * tk / 0.66)
        tk += 0.06 * (1 - tk * 0.8)
    S["unlock"] = master(space(widen(add(bp(motor, 80, 2400), ratchet), 8, 0.5), 1.0, 0.18), -18)
    for g in range(3):
        hiss = hp(pink(0.4), 2500, 2) * env(0.4, 0.01, 0.12) * 0.4
        boom = add(click(0.01, 1800, 0.003), modal(0.8, [140, 212, 317, 450, 640], [0.3, 0.22, 0.16, 0.1, 0.07]) * 0.6, sine(0.5, glide(0.5, 70 - 4 * g, 38, "drop", 0.05)) * env(0.5, 0.002, 0.14) * 1.2)
        S[f"bolt{g}"] = master(space(mix((stereo(boom, [-0.35, 0.35, 0][g]), 0, 1.0), (widen(hiss, 9, 0.6), 0.03, 1.0)), 1.6, 0.25), -15)
    d = 4.5
    drop = sine(d, glide(d, 58, 26, "drop", 0.4)) * env(d, 0.003, 1.0)
    steel = modal(4.0, [62, 97, 141, 199, 276, 377, 505], [2.2, 1.6, 1.2, 0.9, 0.65, 0.45, 0.3], [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.2]) * 0.4
    grind = lp(sat(pink(1.6) * 2, 2), 900, 2) * env(1.6, 0.05, 0.5) * 0.4
    hiss = hp(pink(1.4), 3000, 2) * env(1.4, 0.02, 0.4) * 0.3
    S["open"] = master(space(mix((stereo(drop), 0, 1.0), (widen(steel, 14, 0.6), 0, 1.0), (widen(grind, 10, 0.6), 0.05, 1.0), (widen(hiss, 9, 0.7), 0.02, 1.0)), 3.2, 0.33), -10)
    buzz = add(*[np.sign(sine(0.5, 92)) * env(0.5, 0.003, 0.2) * 0.2])
    S["refuse"] = master(space(mix((stereo(lp(buzz, 900, 2)), 0, 0.7), (stereo(add(click(0.01, 1800, 0.003), modal(0.6, [180, 268, 391], [0.2, 0.14, 0.1]) * 0.6, sine(0.4, glide(0.4, 60, 35, "drop", 0.05)) * env(0.4, 0.002, 0.15))), 0, 1.0)), 1.4, 0.25), -13)
    S["sign"] = master(space(stereo(add(click(0.006, 2500, 0.0015), modal(0.6, [420, 630, 905, 1270], [0.18, 0.12, 0.08, 0.05]) * 0.6, sine(0.25, glide(0.25, 95, 55, "drop", 0.03)) * env(0.25, 0.002, 0.06)), -0.3), 1.2, 0.22), -18)
    S["pay"] = master(space(pan_move(add(click(0.004, 2000, 0.001), sweep(pink(0.22), 800, 2400, 0.8) * env(0.22, 0.08, 0.05) * 0.5), -0.3, 0.55), 0.8, 0.12), -26)
    S["paid"] = master(space(stereo(add(click(0.006, 2500, 0.0012), modal(0.5, [560, 840, 1190], [0.14, 0.09, 0.06]) * 0.5), 0.55), 1.0, 0.2), -22)
    return S


def interface():
    """C: Digital interface. Precise and synthetic: data, bit-depth grain, filtered pulses, glitch."""
    S = {}
    L = 9.0
    pulse = (sine(L, 55) * (0.5 + 0.5 * np.sign(np.sin(2 * np.pi * 1.0 * tt(L)))) * 0.15)
    S["room"] = master(space(widen(add(lp(pink(L), 300, 2) * 0.6, lp(pulse, 200, 2)), 10, 0.5), 1.2, 0.2), -31)
    for i in range(5):
        chatter = np.zeros(n_of(FLY))
        tk = 0.0
        while tk < FLY - 0.03:
            f = RNG.choice([1760, 2349, 2637, 3520, 4186])
            b = bitcrush(sine(0.018, f) * np.hanning(n_of(0.018)), 5, 4)
            j = n_of(tk)
            chatter[j : j + len(b)] += b * 0.35
            tk += RNG.uniform(0.03, 0.08)
        blip = bitcrush(sine(0.08, 2349 * (1 + 0.06 * i)) * env(0.08, 0.001, 0.025), 6, 3)
        S[f"key{i}"] = master(space(pan_move(add(blip, chatter * np.linspace(1, 0.3, n_of(FLY))), KEY_FROM[i], KEY_PAN[i]), 0.6, 0.15), -22)
        lock = add(click(0.004, 4000, 0.0008), bitcrush(sine(0.06, 1174.7) * env(0.06, 0.001, 0.015), 5, 4) * 0.6, sine(0.12, glide(0.12, 120, 70, "drop", 0.02)) * env(0.12, 0.002, 0.03))
        S[f"lock{i}"] = master(space(stereo(lock, KEY_PAN[i]), 0.5, 0.12), -19)
    d = 0.72
    arp = np.zeros(n_of(d))
    tk = 0.0
    k = 0
    while tk < 0.69:
        # data accelerating into the opening (random values, not a scale)
        f = RNG.uniform(1200, 5200)
        b = bitcrush(sine(0.012, f) * np.hanning(n_of(0.012)), 5, 3)
        j = n_of(tk)
        arp[j : j + len(b)] += b * (0.3 + 0.7 * tk / 0.7)
        tk += 0.05 * (1 - tk * 1.2) + 0.006
        k += 1
    S["unlock"] = master(space(widen(add(arp * 0.5, sweep(pink(d), 400, 6000, 1.0) * np.linspace(0, 1, n_of(d)) ** 3 * 0.5), 6, 0.5), 0.6, 0.15), -19)
    for g in range(3):
        S[f"bolt{g}"] = master(space(stereo(add(click(0.005, 3000, 0.001), bitcrush(sine(0.1, 220 + 40 * g) * env(0.1, 0.001, 0.03), 4, 6) * 0.6, sine(0.25, glide(0.25, 80, 45, "drop", 0.03)) * env(0.25, 0.002, 0.07)), [-0.35, 0.35, 0][g]), 0.7, 0.15), -16)
    d = 3.0
    drop = sine(d, glide(d, 60, 30, "drop", 0.3)) * env(d, 0.003, 0.7)
    sweepup = sweep(white(1.2), 200, 9000, 0.7) * env(1.2, 0.05, 0.4) * 0.5
    data = np.zeros(n_of(1.6))
    for _ in range(40):
        f = RNG.choice([1760, 2349, 2637, 3520, 4186, 5274])
        b = bitcrush(sine(0.02, f) * np.hanning(n_of(0.02)), 5, 3)
        j = n_of(RNG.uniform(0, 1) ** 1.5 * 1.5)
        data[j : j + len(b)] += b * 0.2
    S["open"] = master(space(mix((stereo(drop), 0, 1.0), (widen(sweepup, 8, 0.6), 0, 1.0), (widen(data, 6, 0.8), 0.05, 1.0)), 1.8, 0.25), -11)
    gl = np.zeros(n_of(0.3))
    for k in range(7):
        b = bitcrush(bp(white(0.02), 600, 3000, 2) * np.hanning(n_of(0.02)), 3, 8)
        j = n_of(k * 0.032)
        gl[j : j + len(b)] += b * 0.7 * 0.85**k
    S["refuse"] = master(space(mix((widen(gl, 5, 0.6), 0, 1.0), (stereo(bitcrush(sine(0.4, 110) * env(0.4, 0.002, 0.15), 4, 8) * 0.5), 0, 1.0), (stereo(sine(0.4, glide(0.4, 60, 35, "drop", 0.06)) * env(0.4, 0.002, 0.14)), 0, 1.0)), 0.8, 0.15), -13)
    S["sign"] = master(space(stereo(add(click(0.004, 4000, 0.0008), bitcrush(sine(0.12, 1760) * env(0.12, 0.001, 0.04), 6, 2), bitcrush(sine(0.12, 2637) * env(0.12, 0.001, 0.04), 6, 2) * 0.6), -0.3), 0.7, 0.18), -19)
    S["pay"] = master(space(pan_move(bitcrush(sine(0.15, glide(0.15, 1500, 4000)) * env(0.15, 0.002, 0.05), 5, 3), -0.3, 0.55), 0.5, 0.12), -26)
    S["paid"] = master(space(stereo(add(bitcrush(sine(0.1, 2637) * env(0.1, 0.001, 0.03), 6, 2), bitcrush(sine(0.12, 3520) * env(0.12, 0.001, 0.04), 6, 2) * 0.8), 0.55), 0.7, 0.18), -22)
    return S


def demo(S):
    parts = []
    room = np.tile(S["room"], (1, 2))[:, : n_of(T_OPEN + 0.6)]
    room = room * np.minimum(1, np.linspace(0, 6, room.shape[-1])) * np.linspace(1, 0.2, room.shape[-1])
    parts.append((room, 0, 1.0))
    for i, t in enumerate(T_KEYS):
        parts += [(S[f"key{i}"], t, 1.0), (S[f"lock{i}"], t + FLY, 1.0)]
    parts += [(S["unlock"], T_UNLOCK, 1.0)] + [(S[f"bolt{g}"], t, 1.0) for g, t in enumerate(T_BOLT)]
    parts += [(S["open"], T_OPEN, 1.0), (S["refuse"], T_REFUSE, 1.0), (S["sign"], T_SIGN, 1.0), (S["pay"], T_PAY, 1.0), (S["paid"], T_PAID, 1.0)]
    r = mix(*parts)
    return limit(pad_to(r, n_of(LEN)), -1)


def write(path, x):
    import wave

    y = (np.clip(x, -1, 1).T * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(y.tobytes())


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "out"
    os.makedirs(out, exist_ok=True)
    for name, fn in (("A-quantum-lattice", lattice), ("B-vault-machinery", machinery), ("C-digital-interface", interface)):
        x = demo(fn())
        wav = os.path.join(out, name + ".wav")
        write(wav, x)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-c:a", "aac", "-b:a", "192k", os.path.join(out, name + ".m4a")], check=True)
        print(name, "ok")
