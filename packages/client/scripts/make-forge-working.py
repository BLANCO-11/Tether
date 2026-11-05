"""Forge's working mark: particles flowing between shapes. Renders an animated WebP (alpha) and a GIF fallback."""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(sys.argv[1])
SIZE = 48            # output px (shown at 16-20px, so 3-4x)
SS = 5               # supersampling
FPS = 30
N = 40               # particles
HOLD = 11            # frames a shape is held
MORPH = 23           # frames of a morph
STAGGER = 0.45       # fraction of the morph spread across particles (the ripple)
TRAIL = 3            # ghost frames behind each particle

A = np.array([0x4C, 0x8D, 0xFF])   # accent (dark theme); reads on light too
B = np.array([0x8B, 0x5C, 0xF6])   # violet, as in .pi-mark's gradient


def resample(pts, n):
    """n points evenly spaced by arc length along a closed path."""
    pts = np.vstack([pts, pts[:1]])
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, cum[-1], n, endpoint=False)
    x = np.interp(t, cum, pts[:, 0])
    y = np.interp(t, cum, pts[:, 1])
    return np.stack([x, y], axis=1)


def path(fn, m=2000):
    th = np.linspace(0, 2 * math.pi, m, endpoint=False)
    return resample(np.stack(fn(th), axis=1), N)


def norm(p):
    p = p - p.mean(axis=0)
    return p / np.abs(p).max()


SHAPES = [
    norm(path(lambda t: (np.cos(t), np.sin(t)))),                                        # ring
    norm(path(lambda t: (np.sin(t), np.sin(t) * np.cos(t) * 1.3)) ),                      # figure-eight
    norm(np.stack([                                                                       # spiral (open, two arms)
        np.concatenate([(r := np.linspace(0.08, 1, N // 2)) * np.cos(r * 9), -r[::-1] * np.cos(r[::-1] * 9)]),
        np.concatenate([r * np.sin(r * 9), -r[::-1] * np.sin(r[::-1] * 9)]),
    ], axis=1)),
]


def ease(x):
    x = np.clip(x, 0, 1)
    return x * x * x * (x * (6 * x - 15) + 10)  # smootherstep


def positions(frame):
    """Every particle's position at a frame, with a per-particle delay so a morph ripples through."""
    cycle = HOLD + MORPH
    k = (frame // cycle) % len(SHAPES)
    f = frame % cycle
    a, b = SHAPES[k], SHAPES[(k + 1) % len(SHAPES)]
    if f < HOLD:
        p = a.copy()
    else:
        u = (f - HOLD) / MORPH
        delay = (np.arange(N) / N) * STAGGER
        t = ease((u - delay) / (1 - STAGGER))[:, None]
        # Mid-morph the particles bow outward a little, so they flow rather than slide in straight lines.
        bow = np.sin(math.pi * t) * 0.18
        mid = (a + b) / 2
        perp = np.stack([-mid[:, 1], mid[:, 0]], axis=1)
        p = a + (b - a) * t + perp * bow
    total = cycle * len(SHAPES)
    ang = 2 * math.pi * frame / total            # one slow turn per loop: seamless
    r = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]])
    return p @ r.T


def render(frame):
    W = SIZE * SS
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    scale = W * 0.40
    c = W / 2
    total = (HOLD + MORPH) * len(SHAPES)
    for g in range(TRAIL, -1, -1):  # ghosts first, then the particle on top
        p = positions((frame - g) % total)
        alpha = 255 if g == 0 else int(70 * (1 - g / (TRAIL + 1)))
        for i, (x, y) in enumerate(p):
            mix = 0.5 + 0.5 * math.sin(2 * math.pi * i / N + 2 * math.pi * frame / total)
            col = (A * (1 - mix) + B * mix).astype(int)
            pulse = 0.75 + 0.25 * math.sin(2 * math.pi * (frame / 24 + i / 7))
            rad = SS * (1.9 if g == 0 else 1.4) * pulse
            X, Y = c + x * scale, c + y * scale
            d.ellipse([X - rad, Y - rad, X + rad, Y + rad], fill=(*col, alpha))
    # A soft glow under the dots: blurred copy behind the sharp one.
    glow = img.filter(ImageFilter.GaussianBlur(SS * 2.2))
    ga = np.array(glow)
    ga[..., 3] = (ga[..., 3] * 0.55).astype(np.uint8)
    out = Image.alpha_composite(Image.fromarray(ga), img)
    return out.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    total = (HOLD + MORPH) * len(SHAPES)
    frames = [render(f) for f in range(total)]
    OUT.mkdir(parents=True, exist_ok=True)
    ms = round(1000 / FPS)
    frames[0].save(OUT / "forge-working.webp", save_all=True, append_images=frames[1:], duration=ms, loop=0, lossless=False, quality=72, method=6)
    # GIF: 1-bit transparency, so dots are cut at alpha 50% — fine on either theme at this size, but no soft glow.
    gif = []
    for f in frames:
        a = f.getchannel("A")
        rgb = Image.new("RGB", f.size, (0, 0, 0))
        rgb.paste(f.convert("RGB"), mask=a)
        q = rgb.quantize(colors=255)
        q.paste(255, mask=a.point(lambda v: 255 if v < 110 else 0))
        gif.append(q)
    gif[0].save(OUT / "forge-working.gif", save_all=True, append_images=gif[1:], duration=ms, loop=0, transparency=255, disposal=2)
    # A contact sheet to look at it without a browser.
    sheet = Image.new("RGBA", (SIZE * 12, SIZE * 2), (24, 24, 27, 255))
    light = Image.new("RGBA", (SIZE * 12, SIZE), (250, 250, 250, 255))
    sheet.paste(light, (0, SIZE))
    for i in range(12):
        f = frames[i * total // 12]
        sheet.alpha_composite(f, (i * SIZE, 0))
        sheet.alpha_composite(f, (i * SIZE, SIZE))
    sheet.save(OUT / "sheet.png")
    print(total, "frames,", f"{total / FPS:.1f}s loop")
    for n in ("forge-working.webp", "forge-working.gif"):
        print(n, (OUT / n).stat().st_size // 1024, "KB")


main()
