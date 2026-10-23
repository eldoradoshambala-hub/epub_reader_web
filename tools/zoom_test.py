"""Pinching a picture open, and starting where reading stopped.

    python webapp/tools/zoom_test.py

Self-contained: it writes a small illustrated novel, serves the app itself on
a free port, and drives it at iPhone size in Chromium. Two-finger touches are
dispatched as real TouchEvents on the page, so they travel the same path a
hand does -- through the reader's touch handling, into the zoom view.

Then the page is reloaded, which is what a cold start of the home-screen app
amounts to, and the book has to come back open at the page it was left on
rather than on the shelf.
"""

from __future__ import annotations

import json
import shutil
import socketserver
import sys
import tempfile
import threading
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
sys.path.insert(0, str(HERE))

from PySide6.QtCore import QBuffer, QIODevice, QTimer, QUrl
from PySide6.QtGui import QColor, QImage, QPainter
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication

import serve

TEXT = "吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。" * 12

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">zoom-test</dc:identifier>
    <dc:title>挿絵のある小説</dc:title>
    <dc:language>ja</dc:language>
    <meta property="dcterms:modified">2026-10-23T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
    <item id="i1" href="images/inline.png" media-type="image/png"/>
    <item id="i2" href="images/plate.png" media-type="image/png"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/>
  </spine>
</package>"""

NAV = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目次</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">一</a></li><li><a href="ch2.xhtml">口絵</a></li><li><a href="ch3.xhtml">二</a></li>
</ol></nav></body></html>"""

CSS = "html { writing-mode: vertical-rl; -webkit-writing-mode: vertical-rl; }"


def chapter(body):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">
<head><title>本文</title><link rel="stylesheet" href="style.css"/></head>
<body>{body}</body></html>"""


CH1 = chapter('<h1>一</h1><p><img src="images/inline.png" alt=""/></p>' f"<p>{TEXT}</p>")
CH2 = chapter(
    '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="100%" height="100%" '
    'viewBox="0 0 900 1300" preserveAspectRatio="xMidYMid meet">'
    '<image width="900" height="1300" xlink:href="images/plate.png"/></svg>'
)
CH3 = chapter("<h1>二</h1>" + "".join(f"<p>{TEXT}</p>" for _ in range(6)))


def png(width, height, hue):
    image = QImage(width, height, QImage.Format.Format_RGB32)
    image.fill(QColor.fromHsv(hue, 120, 235))
    painter = QPainter(image)
    for step in range(0, width, 30):
        painter.setPen(QColor.fromHsv((hue + step) % 360, 200, 120))
        painter.drawLine(step, 0, width - step, height)
    painter.end()
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")
    return bytes(buffer.data())


def write_novel(path):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", CONTAINER)
        zf.writestr("OEBPS/content.opf", OPF)
        zf.writestr("OEBPS/nav.xhtml", NAV)
        zf.writestr("OEBPS/style.css", CSS)
        zf.writestr("OEBPS/ch1.xhtml", CH1)
        zf.writestr("OEBPS/ch2.xhtml", CH2)
        zf.writestr("OEBPS/ch3.xhtml", CH3)
        zf.writestr("OEBPS/images/inline.png", png(240, 180, 20))
        zf.writestr("OEBPS/images/plate.png", png(900, 1300, 200))


# The checks, run inside the app. Every gesture is a TouchEvent dispatched where
# a finger would land; nothing calls the zoom view's methods directly.
CHECKS = r"""
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = window.app;
const zoomEl = document.getElementById('zoom');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' });
const isOpen = () => !zoomEl.hidden && zoomEl.classList.contains('shown');

function fingers(target, points) {
  return points.map((p, i) => new Touch({
    identifier: i + 1, target, clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y,
  }));
}

/* Two fingers down on `target` (one after the other, as a hand does), moved
   from `from` apart to `to` apart around `centre`, then lifted. */
async function pinch(target, centre, from, to) {
  const at = (d) => [{ x: centre.x - d / 2, y: centre.y }, { x: centre.x + d / 2, y: centre.y }];
  const send = (type, touches, changed) => target.dispatchEvent(new TouchEvent(type, {
    bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: changed,
  }));
  const start = fingers(target, at(from));
  send('touchstart', [start[0]], [start[0]]);
  send('touchstart', start, [start[1]]);
  for (let k = 1; k <= 6; k++) {
    const now = fingers(target, at(from + (to - from) * k / 6));
    send('touchmove', now, now);
    await wait(16);
  }
  const last = fingers(target, at(to));
  send('touchend', [last[0]], [last[1]]);
  send('touchend', [], [last[0]]);
  await wait(450);
}

async function tapZoom(point) {
  const target = zoomEl.querySelector('img');
  const [finger] = fingers(target, [point]);
  const send = (type, touches) => target.dispatchEvent(new TouchEvent(type, {
    bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: [finger],
  }));
  send('touchstart', [finger]);
  send('touchend', []);
}

async function closeZoom() {
  zoomEl.querySelector('.zoom-close').click();
  await wait(350);
}

function frameDoc() { return app.reader.paneDoc(app.reader.frames[0]); }

function centreOf(el) {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

const books = await app.library.list();
const novel = books.find((b) => (b.title || '').includes('挿絵'));
await app.openRecord(novel);
await wait(900);

// -- an illustration set in the text ---------------------------------------
{
  const doc = frameDoc();
  const img = doc.querySelector('img');
  const box = img.getBoundingClientRect();
  check('挿絵が 1 ページ目に見えている',
        box.right > 0 && box.left < doc.defaultView.innerWidth && box.width > 0,
        `${Math.round(box.left)}..${Math.round(box.right)} / ${doc.defaultView.innerWidth}`);
  const page = app.reader.pageIndex;
  const spine = app.view.spineIndex;
  await pinch(img, centreOf(img), 40, 160);
  check('本文中の挿絵を二本指で広げると拡大表示が開く', isOpen());
  check('指を広げた分だけ大きくなる', app.zoom.scale > app.zoom.fit * 1.4,
        `倍率 ${(app.zoom.scale / app.zoom.fit).toFixed(2)} × 画面幅`);
  check('拡大してもページはめくれない',
        app.reader.pageIndex === page && app.view.spineIndex === spine,
        `${spine}:${page} -> ${app.view.spineIndex}:${app.reader.pageIndex}`);
  await closeZoom();
  check('✕ で閉じる', zoomEl.hidden);

  await pinch(img, centreOf(img), 160, 40);
  check('すぼめる動きでは開かない（開いてもすぐ閉じる）', zoomEl.hidden);
}

// -- an illustration page: an <svg> wrapping one <image> -------------------
{
  await app.view.goToHref('OEBPS/ch2.xhtml', '');
  await wait(900);
  const doc = frameDoc();
  const image = doc.querySelector('image');
  await pinch(image, centreOf(image), 60, 60);
  check('口絵ページ（svg の image）も開ける', isOpen());
  check('同じ幅のままなら画面に収まる大きさになる',
        Math.abs(app.zoom.scale / app.zoom.fit - 1) < 0.02,
        `倍率 ${(app.zoom.scale / app.zoom.fit).toFixed(3)}`);

  const middle = { x: innerWidth / 2, y: innerHeight / 2 };
  await tapZoom(middle);
  await wait(60);
  await tapZoom(middle);
  await wait(450);
  check('ダブルタップで拡大', app.zoom.scale > app.zoom.fit * 2,
        `倍率 ${(app.zoom.scale / app.zoom.fit).toFixed(2)}`);
  await tapZoom(middle);
  await wait(450);
  check('拡大中の 1 回タップでは閉じない', isOpen());
  await tapZoom(middle);
  await wait(60);
  await tapZoom(middle);
  await wait(450);
  check('もう一度ダブルタップで元の大きさ', Math.abs(app.zoom.scale / app.zoom.fit - 1) < 0.02,
        `倍率 ${(app.zoom.scale / app.zoom.fit).toFixed(3)}`);
  await tapZoom(middle);
  await wait(600);
  check('元の大きさで 1 回タップすると閉じる', zoomEl.hidden);
}

// -- a manga page, on the picture layer -------------------------------------
{
  const manga = books.find((b) => b.kind !== 'images' && !(b.title || '').includes('挿絵'));
  if (manga) {
    await app.openRecord(manga);
    await wait(900);
    const img = document.querySelector('.fixed-layer img');
    if (img) {
      await pinch(img, centreOf(img), 50, 150);
      check('漫画のページも拡大できる', isOpen());
      await closeZoom();
    }
  }
}

// -- leave the novel part-way through, for the restart ----------------------
await app.openRecord(novel);
await wait(700);
await app.view.goToHref('OEBPS/ch3.xhtml', '');
await wait(700);
app.reader.next();
await wait(1600);   // the position is written 0.9s after the page settles
window.__left = { spine: app.view.spineIndex, page: app.reader.pageIndex, id: novel.id };
check('二章の 2 ページ目まで進んだ', window.__left.page >= 1,
      JSON.stringify(window.__left));
localStorage.setItem('zoom-test.left', JSON.stringify(window.__left));
return results;
"""

AFTER_RESTART = r"""
(function () {
  const left = JSON.parse(localStorage.getItem('zoom-test.left') || 'null');
  const app = window.app;
  const library = document.getElementById('library');
  return JSON.stringify({
    left,
    book: !!(app && app.view.book),
    spine: app && app.view.spineIndex,
    page: app && app.reader.pageIndex,
    shelfShown: !library.hidden && !library.classList.contains('away'),
  });
})();
"""

RUNNER = """
window.__zoomDone = false;
const el = document.createElement('script');
el.type = 'module';
el.textContent = `
(async () => {
  try {
    const blob = await (await fetch('/books/novel.epub')).blob();
    const manga = await (await fetch('/books/manga.epub')).blob();
    await window.app.importFiles([
      new File([blob], 'novel.epub', { type: 'application/epub+zip' }),
      new File([manga], 'manga.epub', { type: 'application/epub+zip' }),
    ]);
    window.__zoomResult = await (async () => { %s })();
  } catch (error) {
    window.__zoomResult = { error: String(error && error.stack || error) };
  }
  window.__zoomDone = true;
})();
`;
document.body.appendChild(el);
"""


class LoudPage(QWebEnginePage):
    def javaScriptConsoleMessage(self, level, message, line, source):
        if level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            print(f"[console] {message}", file=sys.stderr)


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="zoom-test-"))
    write_novel(work / "novel.epub")
    manga = PROJECT / "samples" / "manga_fixed.epub"
    if manga.exists():
        shutil.copy(manga, work / "manga.epub")

    serve.Handler.books = work
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), serve.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"

    app = QApplication(sys.argv)
    view = QWebEngineView()
    # Off the record: the shelf this builds lives in memory and goes with the
    # process, and no shelf left by an earlier run can answer for this one.
    profile = QWebEngineProfile(view)
    view.setPage(LoudPage(profile, view))
    view.resize(390, 844)      # an iPhone, held upright
    view.show()

    rows: list[tuple[str, bool, str]] = []
    phase = {"name": "first"}

    def on_load(ok):
        if not ok:
            print("ページを読み込めませんでした", file=sys.stderr)
            app.exit(2)
            return
        if phase["name"] == "first":
            # Escaped for the template literal it is spliced into.
            body = CHECKS.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")
            QTimer.singleShot(1200, lambda: view.page().runJavaScript(RUNNER % body))
            QTimer.singleShot(1600, poll)
        else:
            QTimer.singleShot(3000, lambda: view.page().runJavaScript(AFTER_RESTART, restarted))

    def poll():
        view.page().runJavaScript(
            "JSON.stringify({done: !!window.__zoomDone, result: window.__zoomResult || null})",
            collected,
        )

    def collected(raw):
        status = json.loads(raw) if raw else {}
        if not status.get("done"):
            QTimer.singleShot(400, poll)
            return
        result = status.get("result")
        if isinstance(result, dict) and result.get("error"):
            print(result["error"], file=sys.stderr)
            app.exit(2)
            return
        for row in result or []:
            rows.append((row["name"], row["ok"], row.get("detail", "")))
        phase["name"] = "restart"
        view.reload()

    def restarted(raw):
        state = json.loads(raw) if raw else {}
        left = state.get("left") or {}
        rows.append(("起動すると前回の本が開いている", state.get("book"), ""))
        rows.append(("本棚ではなく本文が表示されている", not state.get("shelfShown"), ""))
        rows.append((
            "前回のページから続く",
            state.get("spine") == left.get("spine") and state.get("page") == left.get("page"),
            f"前回 {left.get('spine')}:{left.get('page')} / 起動後 {state.get('spine')}:{state.get('page')}",
        ))
        report()

    def report():
        failed = 0
        for name, ok, detail in rows:
            print(f"{'OK  ' if ok else 'NG  '}{name}" + (f"  ({detail})" if detail else ""))
            failed += 0 if ok else 1
        print(f"\n{len(rows) - failed}/{len(rows)}")
        app.exit(1 if failed else 0)

    view.loadFinished.connect(on_load)
    view.load(QUrl(url))
    QTimer.singleShot(90000, lambda: (print("timed out", file=sys.stderr), app.exit(2)))
    code = app.exec()
    server.shutdown()
    shutil.rmtree(work, ignore_errors=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
