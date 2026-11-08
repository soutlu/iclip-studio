from __future__ import annotations

from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

from iclip.platform.media.fonts import FontStyle

TEST_CHARACTERS = " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?-汉字"


def make_font(
    path: Path,
    *,
    characters: str = TEST_CHARACTERS,
    family: str = "Iclip Test",
    weight: int = 400,
    style: FontStyle = "normal",
    otf: bool = False,
    win_metrics: tuple[int, int] = (900, 300),
) -> Path:
    points = sorted(set(characters))
    cmap = {ord(char): f"uni{ord(char):04X}" for char in points}
    order = [".notdef", *cmap.values()]
    metrics = {".notdef": (1000, 0)}
    for char in points:
        metrics[cmap[ord(char)]] = (1000, 0)
    builder = FontBuilder(1000, isTTF=not otf)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap(cmap)
    if otf:
        charstrings = {}
        for glyph in order:
            width = metrics[glyph][0]
            pen = T2CharStringPen(width, None)
            if glyph != cmap.get(ord(" ")):
                pen.moveTo((50, 0))
                pen.lineTo((max(100, width - 50), 0))
                pen.lineTo((max(100, width - 50), 700))
                pen.lineTo((50, 700))
                pen.closePath()
            charstrings[glyph] = pen.getCharString()
        builder.setupCFF(
            "IclipTest",
            {"FullName": family, "FamilyName": family, "Weight": "Regular"},
            charstrings,
            {},
        )
    else:
        glyphs = {}
        for glyph in order:
            width = metrics[glyph][0]
            pen = TTGlyphPen(None)
            if glyph != cmap.get(ord(" ")):
                pen.moveTo((50, 0))
                pen.lineTo((max(100, width - 50), 0))
                pen.lineTo((max(100, width - 50), 700))
                pen.lineTo((50, 700))
                pen.closePath()
            glyphs[glyph] = pen.glyph()
        builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=900, descent=-300)
    builder.setupNameTable(
        {
            "familyName": family,
            "styleName": "Regular" if style == "normal" else style.title(),
            "uniqueFontIdentifier": f"{family}-{weight}-{style}",
            "fullName": f"{family} {weight} {style}",
            "psName": f"IclipTest-{weight}-{style}",
        }
    )
    flags = 1 if style == "italic" else 1 << 9 if style == "oblique" else 0
    flags |= (1 << 5) if weight >= 700 else 0
    if weight == 400 and style == "normal":
        flags |= 1 << 6
    builder.setupOS2(
        version=4,
        sTypoAscender=900,
        sTypoDescender=-300,
        usWinAscent=win_metrics[0],
        usWinDescent=win_metrics[1],
        usWeightClass=weight,
        fsSelection=flags,
    )
    builder.setupHead(
        macStyle=(int(weight >= 700) | (int(style == "italic") << 1)),
        created=3_860_000_000,
        modified=3_860_000_000,
    )
    builder.setupPost(italicAngle=-12 if style != "normal" else 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    builder.save(path)
    return path
