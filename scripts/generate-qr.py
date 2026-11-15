# AI-assisted code: written with Antigravity (Google DeepMind), reviewed by the team.
"""
Generate crisp QR code assets (SVG + PNG + presentation card PNG) for the
permanent GitHub Pages URL of Marswalk Map.
"""

from __future__ import annotations

import io
from pathlib import Path
import segno
from PIL import Image, ImageDraw, ImageFont

LIVE_URL = "https://demirataalbuz-maker.github.io/martian-map/"

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_SVG = ROOT / "public" / "live_qr.svg"
SUNUM_SVG = ROOT / "sunum" / "marswalk_qr.svg"
SUNUM_PNG_PLAIN = ROOT / "sunum" / "marswalk_qr_sade.png"
SUNUM_PNG_CARD = ROOT / "sunum" / "marswalk_live_qr.png"


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        [
            "C:/Windows/Fonts/segoeuib.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
            "C:/Windows/Fonts/calibrib.ttf",
        ]
        if bold
        else [
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf",
            "C:/Windows/Fonts/calibri.ttf",
        ]
    )
    for path in candidates:
        p = Path(path)
        if p.exists():
            try:
                return ImageFont.truetype(str(p), size=size)
            except OSError:
                pass
    return ImageFont.load_default()


def draw_centered_text(
    draw: ImageDraw.ImageDraw,
    y: int,
    text: str,
    font: ImageFont.ImageFont,
    fill: str,
    canvas_width: int,
) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    x = (canvas_width - text_w) // 2 - bbox[0]
    draw.text((x, y), text, font=font, fill=fill)


def main() -> None:
    qr = segno.make(LIVE_URL, error="Q")

    PUBLIC_SVG.parent.mkdir(parents=True, exist_ok=True)
    SUNUM_SVG.parent.mkdir(parents=True, exist_ok=True)

    # 1 & 2. Crisp vector SVGs (offline in-app popover & presentation asset)
    for out_svg in (PUBLIC_SVG, SUNUM_SVG):
        qr.save(
            str(out_svg),
            kind="svg",
            scale=8,
            border=3,
            dark="#16110f",
            light="#ffffff",
            xmldecl=False,
        )

    # 3. Clean 1024x1024 black-on-white square PNG
    buf_plain = io.BytesIO()
    qr.save(buf_plain, kind="png", scale=24, border=4, dark="#000000", light="#ffffff")
    buf_plain.seek(0)
    plain_img = Image.open(buf_plain).convert("RGB").resize((1024, 1024), Image.Resampling.NEAREST)
    plain_img.save(SUNUM_PNG_PLAIN, format="PNG")

    # 4. 1080x1280 presentation card with Mars theme header + white QR quiet-zone card
    W, H = 1080, 1280
    card = Image.new("RGB", (W, H), "#16110f")
    draw = ImageDraw.Draw(card)

    # Subtle top accent bar & border
    draw.rectangle([0, 0, W, 10], fill="#d97745")
    draw.rounded_rectangle([24, 24, W - 24, H - 24], radius=32, outline="#382923", width=3)

    font_kicker = load_font(26, bold=True)
    font_title = load_font(54, bold=True)
    font_sub = load_font(30, bold=False)
    font_url = load_font(28, bold=True)
    font_foot = load_font(24, bold=False)

    draw_centered_text(draw, 58, "NASA SPACE APPS CHALLENGE 2026", font_kicker, "#e28b5a", W)
    draw_centered_text(draw, 102, "Marswalk Map — Jezero Crater", font_title, "#f5eee9", W)
    draw_centered_text(
        draw,
        172,
        "Canlı 3B Mars Küresi & Görev Rota Planlayıcı",
        font_sub,
        "#c9b7ad",
        W,
    )

    # White QR container with generous quiet zone
    qr_box_size = 860
    qr_box_x = (W - qr_box_size) // 2
    qr_box_y = 240
    draw.rounded_rectangle(
        [qr_box_x, qr_box_y, qr_box_x + qr_box_size, qr_box_y + qr_box_size],
        radius=28,
        fill="#ffffff",
    )

    buf_qr = io.BytesIO()
    qr.save(buf_qr, kind="png", scale=20, border=4, dark="#16110f", light="#ffffff")
    buf_qr.seek(0)
    qr_img = Image.open(buf_qr).convert("RGB").resize((800, 800), Image.Resampling.NEAREST)
    card.paste(qr_img, (qr_box_x + 30, qr_box_y + 30))

    draw_centered_text(draw, 1138, "demirataalbuz-maker.github.io/martian-map", font_url, "#f2c14e", W)
    draw_centered_text(
        draw,
        1188,
        "Kameranızla okutarak tarayıcıdan doğrudan açın (giriş gerekmez)",
        font_foot,
        "#b5a399",
        W,
    )

    card.save(SUNUM_PNG_CARD, format="PNG")
    print(f"Generated:\n- {PUBLIC_SVG}\n- {SUNUM_SVG}\n- {SUNUM_PNG_PLAIN}\n- {SUNUM_PNG_CARD}")


if __name__ == "__main__":
    main()
