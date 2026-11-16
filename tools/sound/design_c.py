"""Quanlet sound, direction C: digital interface. The set the site ships.

    QUANLET_WEB=apps/web python3 tools/sound/design_c.py <outdir>

Precise and synthetic: short sine data points with reduced bit depth (grain, not chiptune), random data
streams (never a scale), filtered pulses, white-noise sweeps, glitch stutters and clean sub drops for weight.
Small rooms only. Every sound mastered to its own level; the same names and sync as the other designs.
"""
import sys

import numpy as np

from dsp import (RNG, bp, env, glide, hp, limit, lp, mix, mono, n_of, norm_peak, pad_to, pan_move, pink, sine,
                 space, stereo, sweep, tt, white, widen, comb)

DATA = [1760.0, 2349.3, 2637.0, 3520.0, 4186.0, 5274.0]  # the data tones: values, not a melody
KEY_F = [2349.3, 2637.0, 2093.0, 2793.8, 3136.0]
KEY_FROM = [-0.85, 0.85, -0.85, 0.85, 0.15]
KEY_PAN = [-0.4, 0.4, -0.55, 0.55, 0.0]


def add(*xs):
    n = max(len(x) for x in xs)
    return sum(pad_to(x, n) for x in xs)


def crush(x, bits=6, hold=3):
    """Reduced bit depth and sample-and-hold: a fine digital grain."""
    y = np.round(x * 2 ** (bits - 1)) / 2 ** (bits - 1)
    return np.repeat(y[::hold], hold)[: len(x)]


def click(d=0.005, f=4200, decay=0.0009):
    return hp(white(d), f, 2) * env(d, 0.0003, decay)


def blip(f, d=0.07, decay=0.022, bits=6, hold=3):
    return crush(sine(d, f) * env(d, 0.0008, decay), bits, hold)


def drop(f0, f1, d, decay, tau=None):
    return sine(d, glide(d, f0, f1, "drop", tau or d / 6)) * env(d, 0.002, decay)


def chatter(d, gap=(0.03, 0.08), amp=None, freqs=DATA, gd=0.016, bits=5, hold=3, accel=0.0):
    """A data stream: random data tones at random gaps (optionally accelerating). amp(k) shapes it over 0..1."""
    out = np.zeros(n_of(d))
    t = 0.0
    while t < d - gd - 0.004:
        f = RNG.choice(freqs) * RNG.choice([1, 1, 1, 0.5, 2]) if freqs is DATA else RNG.uniform(*freqs)
        b = crush(sine(gd, f) * np.hanning(n_of(gd)), bits, hold)
        k = t / d
        a = amp(k) if amp else 1.0
        i = n_of(t)
        out[i : i + len(b)] += b * a * RNG.uniform(0.6, 1.0)
        g = RNG.uniform(*gap)
        t += g * (1 - accel * k) + 0.004
    return out


def glitch(n=6, gap=0.03, seg=0.02, bits=3, hold=8, decay=0.85):
    out = np.zeros(n_of(gap * n + seg + 0.01))
    for k in range(n):
        lo = RNG.uniform(500, 1600)
        b = crush(bp(white(seg), lo, lo * RNG.uniform(2, 4), 2) * np.hanning(n_of(seg)), bits, hold)
        i = n_of(k * gap + RNG.uniform(0, 0.004))
        out[i : i + len(b)] += b * 0.7 * decay**k
    return out


def master(x, peak_db):
    from dsp import fade

    x = stereo(x) if x.ndim == 1 else x
    x = norm_peak(x, peak_db + 1.5)
    x = limit(x, peak_db)
    e = np.max(np.abs(x), axis=0)
    idx = np.nonzero(e > np.max(e) * 10 ** (-60 / 20))[0]
    end = min(x.shape[-1], (idx[-1] if len(idx) else x.shape[-1]) + n_of(0.04))
    return fade(x[:, :end], 0.0004, 0.04)


def room(x, t=0.7, wet=0.16):
    return space(x, t, wet, predelay=0.008)


S = {}

# ---------------------------------------------------------------- the intro

# A low pulse once a second under quiet air: a system idling. Seamless 8 s loop.
L = 10.0
gate = 0.5 + 0.5 * np.tanh(6 * np.sin(2 * np.pi * 1.0 * tt(L)))
pulse = lp(sine(L, 55) * gate, 180, 2) * 0.25
bed = add(lp(pink(L), 280, 2) * 0.55, pulse, hp(pink(L), 7000, 2) * 0.02)
bed2 = widen(bed, 12, 0.5)
xf = n_of(2.0)
lp_ = bed2[:, : n_of(8.0)].copy()
w = np.linspace(0, 1, xf)
lp_[:, :xf] = lp_[:, :xf] * w + bed2[:, n_of(8.0) : n_of(8.0) + xf] * (1 - w)
S["room"] = norm_peak(lp_, -31)

FLY = 0.75
for i in range(5):
    head = add(blip(KEY_F[i], 0.08, 0.024), click(0.004, 6000, 0.0006) * 0.5)
    trail = chatter(FLY, (0.028, 0.07), lambda k: 1 - 0.65 * k)
    sw = sweep(white(FLY), 2400, 6000, 0.8) * env(FLY, 0.35, None, release=0.2) * 0.12
    snd = mix((stereo(head, KEY_FROM[i] * 0.6 + KEY_PAN[i] * 0.4), 0, 1.0), (pan_move(add(trail, sw), KEY_FROM[i], KEY_PAN[i]), 0.01, 0.8))
    S[f"key{i}"] = master(room(snd, 0.6, 0.15), -22)
    lock = add(click(0.004, 4000, 0.0008), blip(1174.7, 0.07, 0.016, 5, 4) * 0.6, drop(120, 70, 0.14, 0.035))
    S[f"lock{i}"] = master(room(stereo(lock, KEY_PAN[i]), 0.5, 0.12), -19)

# Unlock: data accelerating into the opening, a noise sweep rising; both stop dead at 0.70 s.
d = 0.72
stream = chatter(d, (0.02, 0.05), lambda k: 0.35 + 0.65 * k, accel=0.85)
rise = sweep(white(d), 400, 7000, 1.0) * np.linspace(0, 1, n_of(d)) ** 3 * 0.45
u = add(stream * 0.6, rise)
u[n_of(0.70) :] *= np.linspace(1, 0, len(u) - n_of(0.70))
S["unlock"] = master(room(widen(u, 6, 0.5), 0.6, 0.14), -19)

for g in range(3):
    b = add(click(0.005, 3000, 0.001), blip(220 + 40 * g, 0.1, 0.03, 4, 6) * 0.6, drop(80, 45, 0.25, 0.07))
    S[f"bolt{g}"] = master(room(stereo(b, [-0.35, 0.35, 0.0][g]), 0.7, 0.15), -16)

# Open: a clean sub drop, a noise sweep opening upward, a shower of data settling.
d = 3.0
shower = chatter(1.6, (0.01, 0.05), lambda k: np.exp(-3 * k), accel=0.0)
op = mix(
    (stereo(drop(60, 30, d, 0.7, 0.3)), 0, 1.0),
    (widen(sweep(white(1.2), 200, 9000, 0.7) * env(1.2, 0.05, 0.4) * 0.5, 8, 0.6), 0, 1.0),
    (widen(shower * 0.55, 6, 0.8), 0.05, 1.0),
    (stereo(click(0.005, 5000)), 0, 0.5),
)
S["open"] = master(space(op, 1.6, 0.24), -11)

# The homepage forms: data resolving into the lattice, over a low swell.
d = 1.9
res = chatter(d, (0.008, 0.04), lambda k: np.sin(np.pi * min(1, k * 1.2)) ** 0.7, gd=0.012)
S["form"] = master(room(mix((widen(res * 0.6, 7, 0.9), 0, 1.0), (stereo(lp(pink(d), 300, 2) * env(d, 0.4, 0.5) * 0.3), 0, 1.0)), 0.9, 0.2), -24)
for k in range(5):
    p = float(np.cos(np.pi / 2 - k * 2 * np.pi / 5)) * 0.55
    S[f"formkey{k}"] = master(room(stereo(add(blip(KEY_F[k] * 1.5, 0.06, 0.018), click(0.003, 7000, 0.0005) * 0.4), p), 0.6, 0.15), -26)

# ---------------------------------------------------------------- the descent

S["part"] = master(room(pan_move(add(chatter(0.6, (0.03, 0.07), lambda k: np.sin(np.pi * k)) * 0.6, sweep(white(0.6), 1500, 4500, 0.9) * env(0.6, 0.25, 0.15) * 0.12), 0.45, -0.25)), -26)
S["wallet"] = master(room(stereo(add(blip(880, 0.12, 0.04, 4, 5), click(0.004, 3500, 0.0008) * 0.4), 0.35), 0.6, 0.14), -24)
S["walletfly"] = master(room(pan_move(add(chatter(0.45, (0.025, 0.05), lambda k: 0.6 + 0.4 * k, freqs=(700, 1400)), sweep(white(0.45), 800, 3600, 0.9) * env(0.45, 0.3, 0.08) * 0.2), 0.55, 0.0)), -23)
S["refuse"] = master(room(mix((widen(glitch(7, 0.032, 0.02), 5, 0.6), 0, 1.0), (stereo(crush(sine(0.4, 110) * env(0.4, 0.002, 0.15), 4, 8) * 0.5), 0, 1.0), (stereo(drop(60, 35, 0.4, 0.14, 0.06)), 0, 1.0)), 0.8, 0.15), -13)
for side, p in (("p", -0.3), ("a", 0.3)):
    s_ = crush(sweep(white(0.16), 4200, 1800, 0.6) * env(0.16, 0.01, 0.05), 6, 2)
    S[f"insert{side}"] = master(room(stereo(s_, p), 0.5, 0.12), -25)
for side, p in (("p", -0.3), ("a", 0.3)):
    sg = add(click(0.004, 4000, 0.0008), blip(1760, 0.12, 0.04, 6, 2), np.pad(blip(2637, 0.12, 0.04, 6, 2) * 0.6, (n_of(0.035), 0)), drop(100, 60, 0.15, 0.04) * 0.5)
    x = stereo(sg, p)
    if side == "a":  # the shield accepts: a short high data burst spreading out
        x = mix((x, 0, 1.0), (widen(chatter(0.25, (0.008, 0.025), lambda k: 1 - k, freqs=(4000, 7000), gd=0.008) * 0.35, 6, 0.9), 0.05, 1.0))
    S[f"sign{side}"] = master(room(x, 0.7, 0.18), -19)
d = 2.2
S["door"] = master(space(mix((stereo(drop(58, 30, d, 0.6, 0.25)), 0, 1.0), (widen(sweep(white(1.0), 200, 7000, 0.7) * env(1.0, 0.05, 0.3) * 0.45, 8, 0.6), 0, 1.0), (stereo(crush(drop(140, 70, 0.2, 0.05), 4, 6) * 0.4), 0, 1.0), (stereo(click(0.005, 5000)), 0, 0.5)), 1.4, 0.22), -12)
d = 1.0
pass_ = sweep(white(d), 300, 8000, 0.8, shape=lambda k: np.sin(np.pi * k * 0.85)) * env(d, 0.35, 0.18) * 0.4
S["through"] = master(room(mix((pan_move(pass_, -0.65, 0.65), 0, 1.0), (stereo(sine(d, glide(d, 70, 45, "lin")) * env(d, 0.25, 0.25) * 0.5), 0, 1.0)), 0.8, 0.15), -19)
# Grant: a data fill (a stream that gets dense, then holds), a filter opening, a low pulse underneath.
d = 1.1
fill = chatter(0.7, (0.012, 0.05), lambda k: 0.4 + 0.6 * k, accel=0.8, gd=0.012)
S["grant"] = master(room(mix((widen(fill * 0.55, 6, 0.8), 0, 1.0), (widen(sweep(white(0.8), 600, 6000, 0.8) * env(0.8, 0.1, 0.25) * 0.15, 8, 0.6), 0, 1.0), (stereo(lp(sine(d, 55) * env(d, 0.05, 0.4), 200, 2) * 0.6), 0, 1.0)), 0.8, 0.15), -19)
echo = add(blip(3520, 0.08, 0.025), np.pad(blip(3520, 0.08, 0.025) * 0.35, (n_of(0.11), 0)), np.pad(blip(3520, 0.08, 0.025) * 0.12, (n_of(0.22), 0)))
S["payee"] = master(room(stereo(echo, 0.55), 0.6, 0.15), -23)
S["pay"] = master(room(pan_move(crush(sine(0.15, glide(0.15, 1500, 4000)) * env(0.15, 0.002, 0.05), 5, 3), -0.3, 0.55), 0.5, 0.12), -26)
S["paid"] = master(room(stereo(add(blip(2637, 0.1, 0.03, 6, 2), np.pad(blip(3520, 0.12, 0.04, 6, 2) * 0.8, (n_of(0.04), 0))), 0.55), 0.6, 0.16), -22)
S["overspend"] = master(room(mix((widen(glitch(4, 0.03, 0.018), 5, 0.5), 0, 0.8), (stereo(crush(sine(0.3, 110) * env(0.3, 0.002, 0.12), 4, 8) * 0.45), 0, 1.0), (stereo(drop(62, 40, 0.35, 0.11)), 0, 0.8)), 0.7, 0.14), -18)
# Lost: power-down, the tone falling and losing bits as it goes.
d = 1.2
f = glide(d, 420, 55, "drop", 0.3)
x = sine(d, f) * env(d, 0.003, 0.35)
seg = [crush(x[n_of(a) : n_of(b)], bits, hold) for a, b, bits, hold in ((0, 0.25, 6, 2), (0.25, 0.5, 5, 4), (0.5, 0.8, 4, 6), (0.8, 1.2, 3, 10))]
S["lost"] = master(room(stereo(add(lp(np.concatenate(seg), 3000, 2) * 0.6, drop(70, 40, 0.4, 0.12))), 0.8, 0.15), -17)
S["guardians"] = master(room(mix(*[(pan_move(chatter(0.3, (0.02, 0.05), lambda k: 1 - k), p, p * 0.3), k * 0.08, 0.8) for k, p in enumerate([-0.7, 0.7, 0.0])])), -24)
for name, p, fa, fb in (("gsign", -0.45, 2093.0, 3136.0), ("gsign2", 0.45, 2793.8, 4186.0)):
    sg = add(click(0.004, 4000, 0.0008), blip(fa, 0.12, 0.04, 6, 2), np.pad(blip(fb, 0.12, 0.04, 6, 2) * 0.55, (n_of(0.035), 0)))
    S[name] = master(room(stereo(sg, p), 0.7, 0.18), -20)
# Re-forged: a data stream converging, then a clean strike and drop.
rf = mix(
    (widen(chatter(0.35, (0.01, 0.03), lambda k: 0.3 + 0.7 * k, accel=0.8, gd=0.01) * 0.5, 6, 0.8), 0, 1.0),
    (stereo(add(click(0.005, 4500), blip(1174.7, 0.15, 0.05, 6, 2), np.pad(blip(1760, 0.15, 0.05, 6, 2) * 0.7, (n_of(0.03), 0)))), 0.0, 1.0),
    (stereo(drop(72, 40, 0.6, 0.2)), 0, 0.9),
    (widen(sweep(white(0.6), 1500, 8000, 0.8) * env(0.6, 0.03, 0.2) * 0.12, 8, 0.7), 0.02, 1.0),
)
S["reforge"] = master(room(rf, 0.9, 0.18), -16)
# The ghost key: a corrupted signal. Two low tones beating, ring-modulated, losing bits.
d = 1.5
gtone = (sine(d, 146.8) + sine(d, 149.3)) * sine(d, 31) * env(d, 0.2, 0.5)
gtone = crush(gtone * 0.5, 4, 12)
S["ghost"] = master(space(widen(add(lp(gtone, 2400, 2), bp(pink(d), 250, 900, 2) * env(d, 0.25, 0.45) * 0.15), 12, 0.7), 1.4, 0.25), -21)
d = 0.5
laser = crush(sine(d, glide(d, 1900, 7400)) * env(d, 0.01, None, release=0.12) * 0.3, 7, 2)
grit = comb(sweep(white(d), 1900, 7400, 0.5), 0.6, 0.6) * env(d, 0.01, None, release=0.12) * 0.35
S["scan"] = master(room(pan_move(add(laser, grit), -0.45, 0.45), 0.6, 0.14), -24)
# Vanish: a data point disintegrating, falling apart into coarser and sparser grains.
d = 0.5
v = np.zeros(n_of(d))
t = 0.0
k = 0
while t < 0.42:
    b = crush(sine(0.015, RNG.uniform(2500, 6000)) * np.hanning(n_of(0.015)), max(2, 6 - k // 2), 2 + k)
    i = n_of(t)
    v[i : i + len(b)] += b * (1 - t / 0.45) * 0.6
    t += 0.018 + k * 0.006
    k += 1
S["vanish"] = master(room(widen(add(blip(3520, 0.05, 0.015), v), 6, 0.8), 0.6, 0.15), -23)
# Orbit: a wide sweep travelling across, a sparse constellation of data points circling, a sub swell.
d = 2.6
orb = sweep(white(d), 300, 3500, 0.9, shape=lambda k: np.sin(np.pi * k * 0.9)) * env(d, 0.8, 0.5) * 0.25
con = np.zeros((2, n_of(d)))
for j in range(14):
    t = 0.2 + j * 0.15
    b = blip(RNG.choice(DATA), 0.05, 0.016) * 0.5
    s_ = stereo(b, float(np.sin(2 * np.pi * j / 7)) * 0.8)
    i = n_of(t)
    con[:, i : i + s_.shape[-1]] += s_[:, : con.shape[-1] - i]
S["orbit"] = master(space(mix((pan_move(orb, -0.7, 0.7), 0, 1.0), (con, 0, 1.0), (stereo(sine(d, 45) * env(d, 0.6, 0.6) * 0.45), 0, 1.0)), 1.6, 0.22), -17)

# ---------------------------------------------------------------- interface

S["hover"] = master(stereo(crush(click(0.004, 6500, 0.0006), 8, 1)), -40)
S["click"] = master(room(stereo(add(click(0.004, 3800, 0.0009), blip(1174.7, 0.04, 0.01, 5, 4) * 0.4)), 0.4, 0.08), -30)
S["menuopen"] = master(room(stereo(crush(sweep(white(0.35), 900, 5000, 0.8) * env(0.35, 0.15, 0.08), 6, 2) * 0.6)), -29)
S["menuclose"] = master(room(stereo(crush(sweep(white(0.32), 5000, 900, 0.8) * env(0.32, 0.05, 0.1), 6, 2) * 0.6)), -30)
S["ok"] = master(room(stereo(add(blip(2637, 0.1, 0.03, 6, 2), np.pad(blip(3520, 0.12, 0.04, 6, 2) * 0.8, (n_of(0.045), 0)))), 0.6, 0.15), -24)
S["refused"] = master(room(mix((widen(glitch(3, 0.03, 0.016), 5, 0.5), 0, 0.7), (stereo(crush(sine(0.25, 110) * env(0.25, 0.002, 0.1), 4, 8) * 0.4), 0, 1.0), (stereo(drop(62, 42, 0.3, 0.1)), 0, 0.6)), 0.6, 0.12), -23)
S["hello"] = master(room(stereo(add(click(0.004, 4500, 0.0008) * 0.5, blip(2349.3, 0.1, 0.03, 6, 2))), 0.6, 0.15), -23)

if __name__ == "__main__":
    from sprites_out import run

    run(S, sys.argv[1] if len(sys.argv) > 1 else "out", "quanlet-sound-digital.m4a")
