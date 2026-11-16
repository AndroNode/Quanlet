"""Quanlet sound design: every effect on the site, rendered offline and mastered.

    python3 tools/sound/design.py <outdir>

Writes one WAV per sound, two sprite sheets (intro, site) as MP3 with a sync marker, a JSON map and a
preview reel. The aesthetic: cinematic product interface. Deep and clean low end, crisp transients, metal
and glass with inharmonic partials, air that moves through the stereo field, generated halls. No melody.
"""
import json
import os
import subprocess
import sys

import numpy as np

from dsp import (SR, RNG, bp, env, fade, fm, glide, hp, limit, lp, mix, modal, mono, n_of, norm_peak, pad_to,
                 pan_move, pink, reverse_swell, sat, sine, space, stereo, sweep, tt, white, widen, comb)

# ---------------------------------------------------------------- building blocks


def add(*xs):
    """Sum mono signals of any length."""
    n = max(len(x) for x in xs)
    return sum(pad_to(x, n) for x in xs)


def click(d=0.006, f=5200, decay=0.0013, g=1.0):
    return hp(white(d), f, 2) * env(d, 0.0003, decay) * g


def clamp(f, d=0.22, bright=1.0):
    """A tight metal latch: inharmonic partials with short, uneven decays."""
    ratios = [1, 1.47, 2.09, 2.76, 3.91, 5.2]
    decays = [0.09, 0.06, 0.045, 0.03, 0.02, 0.012]
    amps = [1, 0.7, 0.55 * bright, 0.4 * bright, 0.25 * bright, 0.15 * bright]
    return modal(d, [f * r for r in ratios], decays, amps) * env(d, 0.0005, None)


def thump(f=100, d=0.18, g=1.0):
    body = lp(white(d), 280, 2) * env(d, 0.001, 0.025)
    s = sine(d, glide(d, f, f * 0.55, "drop", 0.03)) * env(d, 0.002, 0.06)
    return (body * 0.8 + s) * g


def sub_drop(f0, f1, d, decay, tau=None):
    return sine(d, glide(d, f0, f1, "drop", tau or d / 5)) * env(d, 0.003, decay)


def glint(f, d=0.5, g=1.0, bright=1.0):
    """A synthetic glass point: FM with an irrational ratio, bright for a few ms, then a clean tone."""
    a = fm(d, f, 1.4142, 2.4 * bright, 0.012, 0.16)
    b = fm(d, f * 2.756, 1.4142, 1.2 * bright, 0.006, 0.06) * 0.35
    return hp(a + b, 700, 2) * g


def air(d, f0, f1, bw=1.2, p0=0.0, p1=0.0, peak=0.55, src=None, shape="exp"):
    """Moving air: band-limited pink noise whose band and pan travel; swells to `peak` (fraction of d)."""
    x = sweep(src if src is not None else pink(d), f0, f1, bw, shape)
    t = np.linspace(0, 1, len(x))
    e = np.where(t < peak, (t / peak) ** 2, np.exp(-(t - peak) / (1 - peak) * 4.5))
    return pan_move(x * e, p0, p1)


def grains(d, n, fmin, fmax, gmin=0.004, gmax=0.02, density=None, pan=0.9, kind="glint"):
    """A scatter of tiny particles (glints or clicks) through a span, with random pan."""
    out = np.zeros((2, n_of(d)))
    for k in range(n):
        u = RNG.uniform(0, 1)
        if density == "early":
            u = u**1.8
        elif density == "mid":
            u = np.clip(RNG.normal(0.35, 0.18), 0, 1)
        start = u * (d - gmax - 0.01)
        gd = RNG.uniform(gmin, gmax)
        f = np.exp(RNG.uniform(np.log(fmin), np.log(fmax)))
        if kind == "glint":
            g = fm(gd + 0.03, f, 1.4142, 1.5, 0.003, gd)
        else:
            g = hp(white(gd), min(f, 18000), 2) * env(gd, 0.0003, gd / 3)
        s = stereo(g * RNG.uniform(0.4, 1.0), RNG.uniform(-pan, pan))
        i = n_of(start)
        out[:, i : i + s.shape[-1]] += s[:, : out.shape[-1] - i]
    return out


def stutter(src, n=6, gap=0.022, seg=0.016, decay=0.8):
    """Digital stutter: a short slice repeated, each repeat filtered differently and quieter."""
    sl = mono(src)[: n_of(seg)] * np.hanning(n_of(seg))
    out = np.zeros(n_of(gap * n + seg))
    for k in range(n):
        lo = RNG.uniform(500, 1600)
        piece = bp(sl, lo, lo * RNG.uniform(2, 4), 2) * decay**k
        i = n_of(gap * k + RNG.uniform(0, 0.004))
        out[i : i + len(piece)] += piece
    return out


def master(x, peak_db, ceil=-1.0):
    x = stereo(x) if x.ndim == 1 else x
    x = norm_peak(x, peak_db + 1.5)
    x = limit(x, peak_db)
    # trim the tail once it has fallen 60 dB below the peak, then fade the last 60 ms
    env_ = np.max(np.abs(x), axis=0)
    thr = np.max(env_) * 10 ** (-60 / 20)
    idx = np.nonzero(env_ > thr)[0]
    end = min(x.shape[-1], (idx[-1] if len(idx) else x.shape[-1]) + n_of(0.05))
    return fade(x[:, :end], 0.0005, 0.06)


# ---------------------------------------------------------------- the sounds

S = {}
KEY_F = [2349.3, 2637.0, 2093.0, 2793.8, 3136.0]  # D7 E7 C7 F7 G7: one family, no tune
KEY_FROM = [-0.85, 0.85, -0.85, 0.85, 0.15]
KEY_PAN = [-0.4, 0.4, -0.55, 0.55, 0.0]

# Room tone: dark breathing air and a sub, rendered as a seamless 8 s loop.
L = 10.0
room = lp(pink(L), 240, 2) * (0.75 + 0.25 * np.sin(2 * np.pi * 0.09 * tt(L)))
room += hp(pink(L), 6500, 2) * 0.03
room += sine(L, 41.2) * 0.32 * (0.85 + 0.15 * np.sin(2 * np.pi * 0.13 * tt(L)))
room2 = widen(room, 14, 0.6)
xf = n_of(2.0)
loop = room2[:, : n_of(8.0)].copy()
w = np.linspace(0, 1, xf)
loop[:, :xf] = loop[:, :xf] * w + room2[:, n_of(8.0) : n_of(8.0) + xf] * (1 - w)
S["room"] = norm_peak(loop, -30)

for i in range(5):
    appear = add(glint(KEY_F[i], 0.4, 0.5), bp(white(0.06), 3000, 9000, 2) * env(0.06, 0.0005, 0.01) * 0.3)
    fly = air(0.82, 450, 3200, 1.3, KEY_FROM[i], KEY_PAN[i], peak=0.78)
    snd = mix((stereo(appear, KEY_PAN[i] * 0.6 + KEY_FROM[i] * 0.4), 0, 1.0), (fly, 0, 0.9), (grains(0.12, 6, 4000, 9000, 0.003, 0.008), 0, 0.25))
    S[f"key{i}"] = master(space(snd, 1.3, 0.22), -21)

for i in range(5):
    f = 1150 + i * 85
    snd = mix((click(0.006, 4500, 0.0012), 0, 1.0), (clamp(f, 0.25, 0.9), 0.001, 0.5), (thump(92, 0.18), 0, 0.9), (click(0.004, 3000, 0.001), 0.019, 0.5))
    S[f"lock{i}"] = master(space(pan_move(mono(snd), KEY_PAN[i], KEY_PAN[i]), 0.7, 0.14), -19)

# Unlock: servo whine and ratchet under a rising swell that lands exactly at 0.70 s (the opening).
d = 0.72
whine = sum(sine(d, glide(d, 150 * h, 205 * h, "lin")) / h for h in (1, 2, 3, 4, 5))
whine = bp(whine, 250, 2600, 2) * env(d, 0.05, None) * 0.25
ratchet = np.zeros(n_of(d))
tk = 0.02
while tk < 0.62:
    c = click(0.004, 2500, 0.0009)
    i = n_of(tk)
    ratchet[i : i + len(c)] += c * (0.3 + 0.5 * tk / 0.62)
    tk += 0.075 * (1 - tk * 0.9)
rise = sweep(pink(d), 300, 6000, 1.0) * np.linspace(0, 1, n_of(d)) ** 3
rise[n_of(0.695) :] *= np.linspace(1, 0, n_of(d) - n_of(0.695))
S["unlock"] = master(space(mix((widen(whine, 8), 0, 1), (stereo(ratchet), 0, 0.6), (widen(rise, 12, 0.7), 0, 0.8)), 0.9, 0.18), -19)

for g in range(3):
    f = 380 + g * 55
    hiss = hp(pink(0.25), 3200, 2) * env(0.25, 0.006, 0.07)
    snd = mix((click(0.006, 3800, 0.0014), 0, 1.0), (clamp(f, 0.3, 0.6), 0, 0.6), (thump(74 - g * 5, 0.24, 1.0), 0, 1.0), (hiss, 0.018, 0.22))
    S[f"bolt{g}"] = master(space(pan_move(mono(snd), [-0.35, 0.35, 0.0][g], [-0.35, 0.35, 0.0][g]), 1.0, 0.18), -16)

# The opening: a deep impact, a low metal body, a rush of air widening, and a fine haze in a long hall.
d = 3.4
impact = sub_drop(64, 30, d, 0.75, 0.25)
body = sat(lp(white(0.4), 650, 2) * env(0.4, 0.001, 0.07), 2.0)
metal = modal(1.6, [86, 131, 203, 287, 412, 590], [0.9, 0.62, 0.44, 0.3, 0.2, 0.12], [1, 0.8, 0.6, 0.45, 0.3, 0.2]) * 0.35
rush = air(1.3, 220, 6500, 1.3, -0.35, 0.35, peak=0.25)
haze = hp(white(1.2), 7200, 2) * env(1.2, 0.04, 0.35) * 0.18
op = mix((stereo(impact), 0, 1.0), (stereo(body), 0, 0.6), (widen(metal, 11, 0.5), 0, 1.0), (rush, 0, 0.5), (widen(haze, 9, 0.7), 0.02, 1.0), (click(0.006, 5000), 0, 0.5))
S["open"] = master(space(op, 2.6, 0.32, damp=1.1, predelay=0.02), -10)

# The homepage forms: crystals settle into the lattice, over a low swell.
d = 1.9
crystals = grains(d, 46, 3200, 9500, 0.004, 0.022, "mid", 0.95)
swell = lp(pink(d), 320, 2) * env(d, 0.45, 0.45) * 0.35
S["form"] = master(space(mix((crystals, 0, 1.0), (widen(swell, 12), 0, 1.0)), 1.8, 0.4), -23)
for k in range(5):
    p = float(np.cos(np.pi / 2 - k * 2 * np.pi / 5)) * 0.55
    snd = mix((stereo(glint(KEY_F[k] * 0.75, 0.45, 1.0, 0.8), p), 0, 1), (stereo(click(0.004, 6000, 0.001), p), 0, 0.4))
    S[f"formkey{k}"] = master(space(snd, 1.1, 0.25), -25)

# ---------------------------------------------------------------- the descent

S["part"] = master(space(air(0.8, 650, 2600, 1.3, 0.45, -0.25, 0.45), 1.0, 0.15), -25)

w = add(lp(fm(0.6, 880, 2.0, 1.6, 0.01, 0.16), 3600, 2), click(0.005, 4000, 0.001) * 0.4)
S["wallet"] = master(space(stereo(w, 0.35), 0.9, 0.18), -24)
S["walletfly"] = master(space(air(0.5, 520, 3000, 1.2, 0.55, 0.0, 0.8), 0.8, 0.12), -23)

# Refusal: impact, a digital stutter, a low dissonant resonance, shards scattering in the hall.
d = 1.5
buzz = sat(bp(white(0.05), 900, 3200, 2) * 3, 3)
err = modal(0.9, [98, 103.8, 196, 207.6], [0.45, 0.42, 0.25, 0.22], [1, 0.9, 0.4, 0.35])
ref = mix(
    (stereo(sub_drop(60, 36, 0.6, 0.22)), 0, 1.0),
    (stereo(thump(110, 0.2)), 0, 0.7),
    (widen(stutter(buzz, 6, 0.021, 0.015, 0.78), 6, 0.6), 0.004, 0.35),
    (widen(lp(err, 900, 2), 10, 0.5), 0, 0.55),
    (grains(0.6, 26, 5000, 14000, 0.003, 0.01, "early", 1.0, "click"), 0.01, 0.35),
    (click(0.006, 4500), 0, 0.6),
)
S["refuse"] = master(space(ref, 1.5, 0.3), -13)

for side, p in (("p", -0.3), ("a", 0.3)):
    scrape = comb(sweep(pink(0.2), 4200, 2000, 0.8), 1.1, 0.55) * env(0.2, 0.012, 0.06)
    S[f"insert{side}"] = master(space(stereo(scrape, p), 0.6, 0.12), -24)

for side, p, f in (("p", -0.3, 2349.3), ("a", 0.3, 3136.0)):
    parts = [(click(0.006, 4200, 0.0012), 0, 1.0), (clamp(1320, 0.2, 0.8), 0.001, 0.4), (thump(90, 0.15), 0, 0.6), (glint(f, 0.6, 0.55), 0.012, 1.0)]
    base = mix(*parts)
    snd = pan_move(mono(base), p, p)
    if side == "a":
        haze = widen(hp(white(1.0), 6500, 2) * env(1.0, 0.05, 0.3) * 0.12, 10, 0.8)
        snd = mix((snd, 0, 1), (haze, 0.03, 1))
    S[f"sign{side}"] = master(space(snd, 1.4, 0.25), -18)

d = 2.4
door = mix(
    (stereo(sub_drop(58, 32, d, 0.6, 0.22)), 0, 1.0),
    (stereo(sat(lp(white(0.3), 600, 2) * env(0.3, 0.001, 0.06), 2)), 0, 0.5),
    (widen(modal(1.2, [92, 140, 211, 305, 430], [0.7, 0.5, 0.35, 0.25, 0.15]) * 0.3, 11, 0.5), 0, 1.0),
    (air(1.0, 240, 4200, 1.3, -0.25, 0.25, 0.25), 0, 0.45),
    (click(0.006, 5000), 0, 0.4),
)
S["door"] = master(space(door, 2.0, 0.3), -12)

d = 1.1
through = air(d, 160, 4500, 1.5, -0.65, 0.65, 0.5, shape=lambda k: np.sin(np.pi * k * 0.85))
whoomp = sine(d, glide(d, 70, 45, "lin")) * env(d, 0.25, 0.25) * 0.5
S["through"] = master(space(mix((through, 0, 1.0), (stereo(whoomp), 0, 1.0)), 1.2, 0.2), -18)

# Grant: power comes up through an opening filter, with a crystalline edge.
d = 1.4
hum = sum(sine(d, f * (1 + 0.002 * k)) / (k + 1) for k, f in enumerate([110, 220, 330, 440, 660]))
hum = sweep(hum + 0.3 * pink(d), 240, 4200, 1.6, shape=lambda k: np.minimum(1, k * 2.2))
hum *= env(d, 0.06, None, release=0.9) * 0.6
S["grant"] = master(space(mix((widen(hum, 9, 0.6), 0, 1.0), (grains(0.5, 10, 5000, 10000, 0.003, 0.012, "early", 0.8), 0.05, 0.4)), 1.4, 0.3), -18)

ping = glint(3520, 0.9, 0.6) + modal(0.9, [1760, 2420], [0.25, 0.12], [0.3, 0.12])
S["payee"] = master(space(stereo(ping, 0.55), 2.0, 0.42), -22)
S["pay"] = master(space(mix((stereo(click(0.005, 4500, 0.001), -0.2), 0, 0.8), (air(0.24, 1300, 5200, 1.0, -0.2, 0.55, 0.6), 0.005, 1.0)), 0.6, 0.12), -26)
S["paid"] = master(space(mix((stereo(click(0.005, 4800, 0.001), 0.55), 0, 0.6), (stereo(glint(2637, 0.6, 1.0), 0.55), 0.004, 1.0)), 1.3, 0.28), -22)

ov = mix((stereo(sub_drop(62, 40, 0.5, 0.16)), 0, 0.8), (widen(stutter(buzz, 4, 0.02, 0.014, 0.75), 6, 0.5), 0.003, 0.3), (widen(lp(err, 800, 2) * 0.8, 8, 0.4), 0, 0.5), (click(0.005, 4500), 0, 0.5))
S["overspend"] = master(space(ov, 1.1, 0.22), -18)

# Lost: a power-down, the hum and its filter falling away.
d = 1.6
fall = glide(d, 120, 38, "drop", 0.35)
hum = sum(np.sin(2 * np.pi * np.cumsum(fall * h) / SR) / h for h in (1, 2, 3, 4))
hum = sweep(hum + 0.2 * pink(d), 3200, 140, 1.4, shape=lambda k: np.minimum(1, k * 1.4))
hum *= env(d, 0.01, 0.45)
S["lost"] = master(space(mix((widen(hum, 10, 0.5), 0, 1.0), (stereo(thump(70, 0.3)), 0, 0.6)), 1.6, 0.25), -16)

g3 = mix(*[(air(0.5, 700, 2800, 1.1, p, p * 0.3, 0.6), k * 0.075, 0.8) for k, p in enumerate([-0.7, 0.7, 0.0])])
S["guardians"] = master(space(g3, 1.2, 0.18), -24)

for name, p, f in (("gsign", -0.45, 2093.0), ("gsign2", 0.45, 2793.8)):
    snd = mix((click(0.006, 4200, 0.0012), 0, 1.0), (clamp(1240, 0.2, 0.7), 0.001, 0.35), (glint(f, 0.6, 0.55), 0.01, 1.0), (thump(96, 0.12), 0, 0.4))
    S[name] = master(space(pan_move(mono(snd), p, p), 1.3, 0.25), -20)

# Re-forged: power returns, a bright forging strike, a haze.
d = 2.0
up = sweep(pink(0.6), 300, 5200, 1.2) * env(0.6, 0.02, 0.18)
strike = modal(1.5, [523, 811, 1123, 1530, 2090, 2870], [0.6, 0.45, 0.32, 0.22, 0.15, 0.1], [1, 0.7, 0.55, 0.4, 0.3, 0.2]) * 0.35
rf = mix((widen(up, 9, 0.6), 0, 0.6), (widen(strike, 10, 0.5), 0.0, 1.0), (stereo(sub_drop(72, 40, 0.8, 0.3)), 0, 0.8), (widen(hp(white(1.0), 7000, 2) * env(1.0, 0.03, 0.3) * 0.15, 9, 0.8), 0.02, 1.0), (click(0.006, 5000), 0, 0.5))
S["reforge"] = master(space(rf, 2.2, 0.32), -15)

# The ghost key: something that should not exist. Hollow, beating, a breath.
d = 1.8
voice = sum(bp(pink(d), f * 0.93, f * 1.07, 2) for f in (300, 780, 2350)) * env(d, 0.25, 0.55)
beat = (sine(d, 146.8) + sine(d, 148.6)) * env(d, 0.3, 0.6) * 0.25
S["ghost"] = master(space(mix((widen(voice, 13, 0.8), 0, 1.0), (stereo(beat), 0, 1.0)), 2.6, 0.45, damp=1.3), -20)

d = 0.5
laser = sine(d, glide(d, 1900, 7400)) * env(d, 0.01, None, release=0.12) * 0.25
grit = comb(sweep(white(d), 1900, 7400, 0.5), 0.6, 0.6) * env(d, 0.01, None, release=0.12) * 0.5
S["scan"] = master(space(pan_move(laser + grit, -0.45, 0.45), 0.9, 0.18), -24)

d = 0.62
burst = hp(white(0.12), 2500, 2) * env(0.12, 0.001, 0.03)
sw = reverse_swell(burst, 1.6, 0.24)
after = grains(0.38, 10, 6000, 13000, 0.003, 0.012, "early", 0.6, "glint")
S["vanish"] = master(mix((sw, 0, 1.0), (after, 0.24, 0.35)), -22)

d = 2.8
orb = air(d, 220, 1900, 1.5, -0.7, 0.7, 0.45, shape=lambda k: np.sin(np.pi * k * 0.9))
swl = sine(d, 45) * env(d, 0.6, 0.6) * 0.45
shim = grains(1.6, 18, 4500, 10000, 0.004, 0.02, "mid", 1.0)
S["orbit"] = master(space(mix((orb, 0, 1.0), (stereo(swl), 0, 1.0), (shim, 0.25, 0.3)), 2.6, 0.35), -16)

# ---------------------------------------------------------------- interface

S["hover"] = master(stereo(click(0.004, 7000, 0.0006)), -40)
S["click"] = master(space(mix((click(0.006, 3800, 0.0012), 0, 1.0), (thump(130, 0.06), 0, 0.35)), 0.4, 0.08), -30)
S["menuopen"] = master(space(air(0.45, 600, 2800, 1.2, -0.1, 0.1, 0.6), 0.8, 0.15), -28)
S["menuclose"] = master(space(air(0.4, 2800, 600, 1.2, 0.1, -0.1, 0.4), 0.8, 0.15), -29)
S["ok"] = master(space(mix((click(0.005, 4500, 0.001), 0, 0.6), (glint(2637, 0.5, 0.7), 0.004, 1.0), (glint(3520, 0.5, 0.35), 0.06, 1.0)), 1.1, 0.25), -24)
S["refused"] = master(space(mix((stereo(sub_drop(62, 42, 0.4, 0.12)), 0, 0.6), (widen(stutter(buzz, 3, 0.02, 0.014, 0.75), 6, 0.5), 0.003, 0.25), (widen(lp(err, 800, 2) * 0.6, 8, 0.4), 0, 0.4)), 0.9, 0.18), -23)
S["hello"] = master(space(mix((click(0.005, 4500, 0.001), 0, 0.5), (glint(2349.3, 0.6, 0.8), 0.004, 1.0)), 1.2, 0.25), -22)

# ---------------------------------------------------------------- output

if __name__ == "__main__":
    from sprites_out import run

    run(S, sys.argv[1] if len(sys.argv) > 1 else "out", "quanlet-sound-v4.m4a")
