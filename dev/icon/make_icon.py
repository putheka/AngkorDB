"""Draws the AngkorDB app icon (1024x1024 PNG with the macOS icon shape baked in).

    python3 dev/icon/make_icon.py        # writes dev/icon/icon-1024.png
    npm run tauri icon dev/icon/icon-1024.png   # makes every size and the .icns/.ico

The motif: the towers of Angkor Wat standing on a stack of database discs, in sand-gold on a deep
teal-blue square. Needs Pillow. Drawn at 4x and shrunk, so the edges are smooth.
"""
import math
import pathlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersampling
S = SIZE * SS
OUT = pathlib.Path(__file__).with_name("icon-1024.png")


def px(v):
    return v * SS


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def vertical_gradient(box, top, bottom):
    x0, y0, x1, y1 = box
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for y in range(int(y0), int(y1)):
        t = (y - y0) / max(1, (y1 - y0 - 1))
        d.line([(x0, y), (x1, y)], fill=lerp(top, bottom, t) + (255,))
    return layer


def squircle_mask(margin, n=5.0):
    """The macOS icon shape: a superellipse in a 1024 canvas with a 100 px margin."""
    half = (SIZE - 2 * margin) / 2
    cx = cy = SIZE / 2
    points = []
    steps = 720
    for i in range(steps):
        a = 2 * math.pi * i / steps
        c, s = math.cos(a), math.sin(a)
        x = cx + half * math.copysign(abs(c) ** (2 / n), c)
        y = cy + half * math.copysign(abs(s) ** (2 / n), s)
        points.append((px(x), px(y)))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def shaded(draw, box, fill, shade, shade_share=0.34):
    """A flat block whose right side is darker, so it reads as a solid with a light from the left."""
    x0, y0, x1, y1 = box
    draw.rectangle([px(x0), px(y0), px(x1), px(y1)], fill=fill)
    draw.rectangle([px(x1 - (x1 - x0) * shade_share), px(y0), px(x1), px(y1)], fill=shade)


def tower(draw, cx, base_y, scale, fill, shade, ledge):
    """A stepped Angkor tower: tiers that narrow upward, then a lotus-bud spire."""
    tiers = [(236, 62), (190, 58), (146, 54), (106, 50)]
    y = base_y
    for width, height in tiers:
        w, h = width * scale, height * scale
        shaded(draw, (cx - w / 2, y - h, cx + w / 2, y), fill, shade)
        draw.rectangle([px(cx - w / 2), px(y - 9 * scale), px(cx + w / 2), px(y)], fill=ledge)
        y -= h
    # the spire: a lotus bud, fullest low down and drawn out to a point
    top = y
    height = 250 * scale
    right = []
    steps = 60
    for i in range(steps + 1):
        t = i / steps
        half = 50 * scale * (1 - t) ** 0.62 * (1 + 0.38 * math.sin(math.pi * min(1, t * 1.15)))
        right.append((cx + half, top - height * t))
    left = [(2 * cx - x, yy) for x, yy in reversed(right)]
    draw.polygon([(px(x), px(yy)) for x, yy in right + left], fill=fill)
    # the shaded side of the bud
    shade_half = [(cx + (x - cx) * 1.0, yy) for x, yy in right]
    mid = [(cx + (x - cx) * 0.05, yy) for x, yy in reversed(right)]
    draw.polygon([(px(x), px(yy)) for x, yy in shade_half + mid], fill=shade)
    draw.ellipse(
        [px(cx - 7 * scale), px(top - height - 12 * scale), px(cx + 7 * scale), px(top - height + 4 * scale)],
        fill=fill,
    )


def disc_stack(draw, cx, y_bottom, width, body, body_dark, lid, edge):
    """Three database discs: each a body, a lid and a thin bright rim."""
    ry, h, gap = 38, 74, 74
    for i in range(3):
        yb = y_bottom - i * gap  # bottom of this disc's body
        x0, x1 = cx - width / 2, cx + width / 2
        # body, with its right side darker
        draw.rectangle([px(x0), px(yb - h), px(x1), px(yb)], fill=body)
        # the curve of the bottom edge
        draw.ellipse([px(x0), px(yb - ry), px(x1), px(yb + ry)], fill=body)
        # lid
        draw.ellipse([px(x0), px(yb - h - ry), px(x1), px(yb - h + ry)], fill=lid, outline=edge, width=px(5))
        # the rim in front of the body
        draw.arc([px(x0), px(yb - ry), px(x1), px(yb + ry)], 0, 180, fill=edge, width=px(6))


def main():
    margin = 100
    mask = squircle_mask(margin)

    # background: deep blue at the top to teal at the bottom, with a soft light from the top left
    bg = vertical_gradient((0, margin, S, S - px(margin)), (16, 38, 66), (12, 112, 118))
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([px(80), px(20), px(760), px(700)], fill=(255, 255, 255, 46))
    glow = glow.filter(ImageFilter.GaussianBlur(px(110)))
    bg = Image.alpha_composite(bg, glow)

    # the motif
    motif = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(motif)
    sand, sand_shade, sand_ledge = (246, 218, 150, 255), (222, 176, 92, 255), (196, 148, 70, 255)
    far, far_shade, far_ledge = (222, 178, 96, 255), (188, 140, 68, 255), (160, 116, 52, 255)
    cx = SIZE / 2
    ground = 600
    tower(d, cx - 200, ground, 0.62, far, far_shade, far_ledge)
    tower(d, cx + 200, ground, 0.62, far, far_shade, far_ledge)
    tower(d, cx, ground, 1.0, sand, sand_shade, sand_ledge)
    disc_stack(d, cx, 850, 580, (22, 84, 112, 255), (14, 62, 88, 255), (40, 118, 146, 255), sand)
    # a little smaller and lower, so the tallest spire keeps clear of the top of the shape
    k = 0.88
    small = motif.resize((round(S * k), round(S * k)), Image.LANCZOS)
    motif = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    motif.paste(small, (round((S - S * k) / 2), round((S - S * k) / 2 + px(34))), small)

    art = Image.alpha_composite(bg, motif)
    art.putalpha(ImageChops.multiply(art.getchannel("A"), mask))

    # a faint shadow under the shape, as Apple's icons have
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow.putalpha(mask.point(lambda v: int(v * 0.35)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(px(14)))
    shadow = ImageChops.offset(shadow, 0, px(10))
    final = Image.alpha_composite(shadow, art)
    final = final.resize((SIZE, SIZE), Image.LANCZOS)
    final.save(OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
