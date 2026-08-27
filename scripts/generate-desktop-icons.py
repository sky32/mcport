from pathlib import Path
from shutil import copy2

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "resources" / "icons"
RENDERER = ROOT / "desktop" / "renderer"
RESOURCES = ROOT / "resources"
ICONS.mkdir(parents=True, exist_ok=True)
RENDERER.mkdir(parents=True, exist_ok=True)
RESOURCES.mkdir(parents=True, exist_ok=True)

SIZE = 1024
image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gradient = Image.new("RGBA", (SIZE, SIZE))
pixels = gradient.load()

for y in range(SIZE):
    for x in range(SIZE):
        t = (x + y) / (2 * (SIZE - 1))
        r = int(64 + (126 - 64) * t)
        g = int(118 + (77 - 118) * t)
        b = int(255 + (232 - 255) * t)
        pixels[x, y] = (r, g, b, 255)

mask = Image.new("L", (SIZE, SIZE), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.rounded_rectangle((44, 44, 980, 980), radius=228, fill=255)
image.alpha_composite(Image.composite(gradient, Image.new("RGBA", (SIZE, SIZE)), mask))

draw = ImageDraw.Draw(image)
draw.rounded_rectangle((124, 124, 900, 900), radius=172, fill=(11, 17, 31, 215))
draw.rounded_rectangle((174, 174, 850, 850), radius=142, outline=(255, 255, 255, 28), width=4)

font_candidates = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/SFNS.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
font = None
for candidate in font_candidates:
    try:
        font = ImageFont.truetype(candidate, 272)
        break
    except OSError:
        continue
if font is None:
    font = ImageFont.load_default()

label = "RW"
bbox = draw.textbbox((0, 0), label, font=font)
width = bbox[2] - bbox[0]
height = bbox[3] - bbox[1]
draw.text(
    ((SIZE - width) / 2, (SIZE - height) / 2 - 30),
    label,
    font=font,
    fill=(248, 250, 255, 255),
)

source_icon = ICONS / "MCPort-Icon.png"
if source_icon.exists():
    image = Image.open(source_icon).convert("RGBA").resize((SIZE, SIZE), Image.Resampling.LANCZOS)

image.save(
    ICONS / "icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
image.save(ICONS / "icon.icns", format="ICNS")

renderer_sources = [
    ICONS / "MCPort-Icon.png",
    ICONS / "MCPort-Tray-Icon.png",
    RESOURCES / "MCPort-Logo-Dark.png",
    RESOURCES / "MCPort-Logo-Light.png",
]
for source in renderer_sources:
    if source.exists():
        copy2(source, RENDERER / source.name)

print(ICONS)
