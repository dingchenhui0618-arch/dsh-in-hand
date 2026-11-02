#!/usr/bin/env python3
"""把 scripts/make-gifs.mjs 录下的 PNG 帧合成 GIF（Pillow）。

用法：python scripts/build-gif.py <frames_dir> <out.gif> [review_dir] [--width 720] [--max-mb 2.5]

frames_dir 里要有 timings.json（[{file, t}]），t 是毫秒时间戳。
每帧的停留时间按**真实间隔**换算（10ms 为单位，60–200ms 夹边），
所以片子的节奏与录制时的实际速度一致，不是硬凑 8fps。

压法：全局调色板（128 色起，超体积就往下调）+ 帧间差量（Pillow optimize），
不抖动 —— 这套界面是平色块，抖动只会让字边长噪点、体积还翻倍。
最长的停留给末帧（约 0.9s），循环回第一帧时不至于一闪而过。

另外把首帧与「变化最明显的那一帧」存成 PNG 到 review_dir，供人工看图自查。
"""
import json
import os
import sys

from PIL import Image, ImageChops

# Windows 上的 python 默认按 cp1252 写 stdout，中文会直接抛 UnicodeEncodeError。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:  # noqa: BLE001 — 3.6 或已被重定向
    pass

MAX_FRAME_MS = 200
MIN_FRAME_MS = 60
TAIL_MS = 900


def load_frames(frames_dir):
    with open(os.path.join(frames_dir, 'timings.json'), 'r', encoding='utf-8') as fh:
        frames = json.load(fh)
    frames.sort(key=lambda r: r['t'])
    return frames


def frame_durations(frames):
    durs = []
    for i in range(len(frames) - 1):
        raw = frames[i + 1]['t'] - frames[i]['t']
        ms = int(round(raw / 10.0)) * 10
        durs.append(max(MIN_FRAME_MS, min(MAX_FRAME_MS, ms)))
    durs.append(TAIL_MS)
    return durs


def resize(im, width):
    if im.width == width:
        return im
    h = int(round(im.height * width / float(im.width)))
    return im.resize((width, h), Image.LANCZOS)


def encode(images, durs, out, colors):
    """统一调色板 + 差量帧。调色板取自第一帧，其余帧向它靠。"""
    base = images[0].quantize(colors=colors, method=Image.MEDIANCUT)
    pal = [im.quantize(palette=base, dither=Image.NONE) for im in images]
    pal[0].save(out, 'GIF', save_all=True, append_images=pal[1:], duration=durs,
                loop=0, optimize=True, disposal=1)
    return os.path.getsize(out)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        print(__doc__.strip())
        return 2
    frames_dir, out = args[0], args[1]
    review = args[2] if len(args) > 2 else None
    width = 720
    max_mb = 2.5
    for flag, i in (('--width', None), ('--max-mb', None)):
        if flag in sys.argv:
            v = sys.argv[sys.argv.index(flag) + 1]
            if flag == '--width':
                width = int(v)
            else:
                max_mb = float(v)

    frames = load_frames(frames_dir)
    if len(frames) < 3:
        print('帧太少：' + str(len(frames)))
        return 1
    durs = frame_durations(frames)
    images = []
    for r in frames:
        im = Image.open(os.path.join(frames_dir, r['file'])).convert('RGB')
        images.append(resize(im, width))

    span = (frames[-1]['t'] - frames[0]['t']) / 1000.0
    ok = False
    size = 0
    used = 0
    for colors in (128, 96, 72, 56, 44):
        size = encode(images, durs, out, colors)
        used = colors
        if size <= max_mb * 1024 * 1024:
            ok = True
            break
    mb = size / 1024.0 / 1024.0
    print('  %s  %d 帧 · %dx%d · %.1fs · %d 色 · %.2f MB %s' % (
        os.path.basename(out), len(images), images[0].width, images[0].height,
        span, used, mb, 'OK' if ok else '仍然超过 %.1f MB' % max_mb))
    if not ok:
        return 3

    if review:
        os.makedirs(review, exist_ok=True)
        base = os.path.splitext(os.path.basename(out))[0]
        images[0].save(os.path.join(review, base + '-frame-first.png'))
        # 「中帧」取与首帧差异最大的那一帧：那才是这套片子真正在演示的瞬间
        diff = []
        for i, im in enumerate(images[1:], start=1):
            d = ImageChops.difference(im, images[0]).convert('L')
            diff.append((sum(d.histogram()[8:]), i))
        mid = max(diff)[1]
        images[mid].save(os.path.join(review, base + '-frame-mid.png'))
        print('    首帧 → %s-frame-first.png，中帧 #%d（差量最大）→ %s-frame-mid.png'
              % (base, mid, base))
    return 0


if __name__ == '__main__':
    sys.exit(main())
