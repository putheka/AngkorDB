"""Draws the background of the installer window (660x400, plus a @2x for Retina).

    python3 dev/icon/make_dmg_background.py     # writes src-tauri/icons/dmg-background.png (+@2x)

The app icon goes on the left and the Applications folder on the right (positions are in
`tauri.conf.json`); this draws the arrow between them and the line of text. Needs Pillow.
"""
import pathlib

from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parents[2] / "src-tauri" / "icons"
FONT = "/System/Library/Fonts/Helvetica.ttc"


def draw(scale):
    w, h = 660 * scale, 400 * scale
    img = Image.new("RGB", (w, h))
    px = img.load()
    top, bottom = (16, 38, 66), (12, 92, 104)
    for y in range(h):
        t = y / (h - 1)
        c = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        for x in range(w):
            px[x, y] = c
    d = ImageDraw.Draw(img)
    sand = (244, 213, 142)
    # arrow between the two icons (icons are centred at x=170 and x=490, y=190)
    y = 190 * scale
    d.line([(250 * scale, y), (400 * scale, y)], fill=sand, width=7 * scale)
    d.polygon(
        [(412 * scale, y), (386 * scale, y - 20 * scale), (386 * scale, y + 20 * scale)], fill=sand
    )
    title = ImageFont.truetype(FONT, 22 * scale)
    small = ImageFont.truetype(FONT, 14 * scale)
    text = "Drag AngkorDB to Applications"
    box = d.textbbox((0, 0), text, font=title)
    d.text(((w - (box[2] - box[0])) / 2, 40 * scale), text, font=title, fill=(255, 255, 255))
    note = "Then open it from Launchpad or the Applications folder"
    box = d.textbbox((0, 0), note, font=small)
    d.text(((w - (box[2] - box[0])) / 2, 335 * scale), note, font=small, fill=(190, 215, 220))
    return img


draw(1).save(OUT / "dmg-background.png")
draw(2).save(OUT / "dmg-background@2x.png")
print("wrote", OUT / "dmg-background.png", "and @2x")
