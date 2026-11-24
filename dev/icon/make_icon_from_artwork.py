"""Makes the app icon from the pixel-art artwork (1024x1024 PNG, macOS icon shape baked in).

    python3 dev/icon/make_icon_from_artwork.py       # writes dev/icon/icon-1024.png
    npm run tauri icon dev/icon/icon-1024.png        # makes every size and the .icns/.ico

The artwork is a rounded frame on a black backdrop. The frame is cut out of the
backdrop, shrunk to the size macOS icons have (824 px in a 1024 canvas, 100 px margin) and given a
soft shadow, so it sits in the Dock like the other apps. Needs Pillow.
"""
import pathlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).parent
SOURCE = HERE / "angkordb-pixel.webp"
OUT = HERE / "icon-1024.png"

# The frame inside the artwork (pixels of the 1254 px original), inset a little so that
# no backdrop shows at the edge.
FRAME = (85, 88, 1169, 1156)
CORNER = 0.16  # corner radius, as a share of the frame's width
SIZE = 1024
BODY = 824
SS = 4  # supersampling for the mask


def main() -> None:
    art = Image.open(SOURCE).convert("RGB").crop(FRAME)
    body = art.resize((BODY, BODY), Image.LANCZOS)

    big = BODY * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=int(CORNER * big), fill=255
    )
    mask = mask.resize((BODY, BODY), Image.LANCZOS)

    icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    margin = (SIZE - BODY) // 2

    shadow = Image.new("L", (SIZE, SIZE), 0)
    shadow.paste(mask, (margin, margin + 10))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.35))
    icon.paste(Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 255)), (0, 0), shadow)

    body_rgba = body.convert("RGBA")
    body_rgba.putalpha(mask)
    icon.alpha_composite(body_rgba, (margin, margin))
    icon.save(OUT)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
