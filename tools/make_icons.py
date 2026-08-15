"""Draw the home-screen icons.

Qt is already a dependency of the desktop reader, and it is the one thing on
this machine that can set Japanese type, so the icons are painted rather than
hand-rolled as PNG bytes. iOS masks the icon into a rounded square itself, so
the artwork runs to the edges; the maskable variant keeps its content inside
the safe circle Android crops to.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QColor, QFont, QGuiApplication, QImage, QLinearGradient, QPainter

OUT = Path(__file__).resolve().parent.parent / "icons"

PAPER_TOP = QColor("#f6f1e5")
PAPER_BOTTOM = QColor("#e6dcc6")
SPINE = QColor("#2f6f5e")
INK = QColor("#22201d")


def draw(size: int, inset: float = 0.0) -> QImage:
    image = QImage(size, size, QImage.Format_ARGB32)
    image.fill(Qt.transparent)

    painter = QPainter(image)
    painter.setRenderHint(QPainter.Antialiasing)
    painter.setRenderHint(QPainter.TextAntialiasing)

    # The maskable icon draws the same picture smaller, centred, on a full
    # bleed of the spine colour so the crop never bites into the artwork.
    if inset:
        painter.fillRect(0, 0, size, size, SPINE)
    margin = size * inset
    box = QRectF(margin, margin, size - 2 * margin, size - 2 * margin)

    gradient = QLinearGradient(box.topLeft(), box.bottomRight())
    gradient.setColorAt(0.0, PAPER_TOP)
    gradient.setColorAt(1.0, PAPER_BOTTOM)
    painter.fillRect(box, gradient)

    # A right-hand spine: Japanese books are bound on the right.
    spine_width = box.width() * 0.17
    painter.fillRect(
        QRectF(box.right() - spine_width, box.top(), spine_width, box.height()), SPINE
    )

    # Ruled lines standing in for columns of vertical text.
    painter.setPen(Qt.NoPen)
    painter.setBrush(QColor(INK.red(), INK.green(), INK.blue(), 38))
    line_area = QRectF(box.left(), box.top(), box.width() - spine_width, box.height())
    for index in range(5):
        step = line_area.width() / 6.0
        x = line_area.right() - step * (index + 1)
        height = line_area.height() * (0.62 if index % 2 else 0.74)
        painter.drawRoundedRect(
            QRectF(x, line_area.top() + line_area.height() * 0.14, step * 0.10, height),
            step * 0.05,
            step * 0.05,
        )

    font = QFont()
    for family in ("Yu Mincho", "MS Mincho", "Yu Gothic", "Meiryo"):
        font.setFamily(family)
        if font.exactMatch():
            break
    font.setPixelSize(int(box.height() * 0.52))
    font.setWeight(QFont.DemiBold)
    painter.setFont(font)
    painter.setPen(INK)
    text_box = QRectF(
        box.left(), box.top(), box.width() - spine_width, box.height()
    ).adjusted(0, box.height() * 0.02, -box.width() * 0.04, 0)
    painter.drawText(text_box, Qt.AlignCenter, "縦")

    painter.end()
    return image


def main() -> int:
    QGuiApplication(sys.argv)
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (120, 152, 167, 180, 192, 512):
        draw(size).save(str(OUT / f"icon-{size}.png"), "PNG")
    draw(512, inset=0.14).save(str(OUT / "icon-maskable-512.png"), "PNG")
    print(f"wrote {len(list(OUT.glob('*.png')))} icons to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
