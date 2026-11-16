"""Shared output for the sound designs: per-sound WAVs, two sprite sheets with a sync marker, a preview reel,
and (with QUANLET_WEB set) publishing the sheets into the web app."""
import json
import os
import subprocess

import numpy as np

from dsp import SR, limit, mix, n_of, sine


INTRO_BASE = ["room"] + [f"key{i}" for i in range(5)] + [f"lock{i}" for i in range(5)] + ["unlock", "bolt0", "bolt1", "bolt2", "open", "form"] + [f"formkey{k}" for k in range(5)] + ["hover", "click", "hello"]


def write_wav(path, x):
    import wave

    y = np.clip(x, -1, 1)
    y = (y.T * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(y.tobytes())


def sprite(S, names, base, out):
    """Sounds laid end to end with silence between, after a sync marker the player uses to find t = 0."""
    gap = n_of(0.3)
    pre = n_of(0.25)
    marker = np.zeros((2, n_of(0.3)))
    mk = sine(0.006, 1000) * np.hanning(n_of(0.006)) * 0.5
    marker[:, pre - n_of(0.003) : pre - n_of(0.003) + len(mk)] += mk
    parts = [marker, np.zeros((2, gap))]
    pos = marker.shape[-1] + gap
    table = {}
    for nm in names:
        x = S[nm]
        table[nm] = [round(pos / SR, 5), round(x.shape[-1] / SR, 5)]
        parts += [x, np.zeros((2, gap))]
        pos += x.shape[-1] + gap
    full = np.concatenate(parts, axis=1)
    wav = os.path.join(out, base + ".wav")
    write_wav(wav, full)
    mp3 = os.path.join(out, base + ".mp3")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, "-c:a", "libmp3lame", "-b:a", "128k", "-ar", str(SR), mp3], check=True)
    return {"file": base + ".mp3", "marker": round(pre / SR, 5), "sounds": table}


def run(S, out, reel_name):
    INTRO = INTRO_BASE
    SITE = [k for k in S if k not in INTRO]
    os.makedirs(out, exist_ok=True)
    os.makedirs(os.path.join(out, "wav"), exist_ok=True)
    for k, v in S.items():
        write_wav(os.path.join(out, "wav", k + ".wav"), v)
    meta = {"intro": sprite(S, INTRO, "intro", out), "site": sprite(S, SITE, "site", out)}
    with open(os.path.join(out, "sprites.json"), "w") as f:
        json.dump(meta, f, indent=1)
    # A preview reel in story order.
    reel = [("room", 0.0, 1.0)]
    for i in range(5):
        reel += [(f"key{i}", 0.5 + i * 0.45, 1.0), (f"lock{i}", 0.5 + i * 0.45 + 0.75, 1.0)]
    reel += [("unlock", 3.1, 1.0), ("bolt0", 3.1, 1.0), ("bolt1", 3.28, 1.0), ("bolt2", 3.46, 1.0), ("open", 3.8, 1.0), ("form", 4.6, 1.0)]
    reel += [(f"formkey{k}", 4.68 + [0.05, 0.16, 0.29, 0.42, 0.56][k], 1.0) for k in range(5)]
    seq = ["part", "wallet", "walletfly", "refuse", "insertp", "signp", "inserta", "signa", "door", "through", "grant", "payee", "pay", "paid", "pay", "paid", "pay", "overspend", "lost", "guardians", "gsign", "gsign2", "reforge", "ghost", "scan", "vanish", "orbit", "hover", "click", "menuopen", "ok", "refused"]
    t = 7.4
    for nm in seq:
        reel.append((nm, t, 1.0))
        t += 1.05 if nm not in ("refuse", "door", "orbit", "reforge", "ghost", "lost") else 1.7
    room = np.tile(S["room"], (1, 2))[:, : n_of(7.2)] * np.linspace(1, 0, n_of(7.2)) ** 0.5
    parts = [(room, 0, 1.0)] + [(S[n], o, g) for n, o, g in reel if n != "room"]
    r = mix(*parts)
    write_wav(os.path.join(out, "reel.wav"), limit(r * 1.0, -1))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", os.path.join(out, "reel.wav"), "-c:a", "aac", "-b:a", "192k", os.path.join(out, reel_name)], check=True)
    print("sounds", len(S), "intro", len(INTRO), "site", len(SITE))
    # Publish into the web app: content-hashed sprites under public/sound, the map next to the player.
    web = os.environ.get("QUANLET_WEB")
    if web:
        import hashlib
        import shutil

        dst = os.path.join(web, "public", "sound")
        os.makedirs(dst, exist_ok=True)
        for old in os.listdir(dst):
            if old.endswith(".mp3"):
                os.remove(os.path.join(dst, old))
        for k in meta:
            src = os.path.join(out, meta[k]["file"])
            h = hashlib.sha256(open(src, "rb").read()).hexdigest()[:10]
            name = f"{k}-{h}.mp3"
            shutil.copy(src, os.path.join(dst, name))
            meta[k]["file"] = "/sound/" + name
        with open(os.path.join(web, "src", "sound", "sprites.json"), "w") as f:
            json.dump(meta, f, separators=(",", ":"))
        print("published", [meta[k]["file"] for k in meta])


