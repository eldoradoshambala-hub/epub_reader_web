"""Screenshot the web reader at phone size, so the layout can be looked at.

The automated checks say no line is sliced; they cannot say whether the page
looks like a book. This opens the web app in a Chromium window the size of an
iPhone screen, drives it to a given place in a given book, and grabs the view.

    python webapp/tools/shot_web.py --book "foo.epub" --out out.png --spine 9

Needs webapp/tools/serve.py running with --books pointed at the folder the
book is in. Only the web view is captured, never the desktop.
"""

from __future__ import annotations

import argparse
import json
import sys

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication


class LoudPage(QWebEnginePage):
    """The page's own console, forwarded: a failed import reports itself
    there and nowhere else."""

    def javaScriptConsoleMessage(self, level, message, line, source):
        print(f"[console] {message}", file=sys.stderr)

SETUP = """
window.__shotReady = false;
window.__shotError = null;
window.__shotStep = 'start';
(async () => {
  const step = (s) => { window.__shotStep = s; };
  try {
    // Matched against the server's listing rather than used directly, so a
    // fragment of the title is enough and the exact spelling of a long
    // Japanese file name never has to travel through the command line.
    const wanted = %(book)s;
    const takeAll = %(all)s;
    if (wanted || takeAll) {
      step('listing');
      const listing = await (await fetch('/books/')).text();
      const names = Array.from(listing.matchAll(/href="([^"]+\\.epub)"/g))
        .map((m) => decodeURIComponent(m[1]));
      const chosen = takeAll ? names : names.filter((n) => n.includes(wanted)).slice(0, 1);
      if (!chosen.length) throw new Error('本が見つかりません: ' + wanted);
      const files = [];
      for (const one of chosen) {
        step('download ' + one);
        const blob = await (await fetch('/books/' + encodeURIComponent(one))).blob();
        files.push(new File([blob], one, { type: 'application/epub+zip' }));
      }
      step('import');
      await window.app.importFiles(files);
      const books = await window.app.library.list();
      const record = wanted
        ? (books.find((b) => b.fileName.includes(wanted)) || books[0])
        : books[0];
      step('open');
      if (record) await window.app.openRecord(record);
    }
    const settings = %(settings)s;
    if (Object.keys(settings).length) {
      Object.assign(window.app.settings, settings);
      window.app.syncSettingsForm();
      window.app.applyPageColours();
      await window.app.reader.configure(window.app.settings);
      await window.app.view.applySpreadMode();
    }
    step('settings done');
    const spine = %(spine)d;
    if (spine >= 0) await window.app.view.showSpine(spine);
    const page = %(page)d;
    if (page > 0) window.app.reader.goToPage(page, false);
    if (%(bars)s) window.app.toggleBars(true); else window.app.toggleBars(false);
    const sheet = %(sheet)s;
    // Opened by clicking, so the shot exercises the same path a finger does.
    if (sheet) document.getElementById('btn-' + (sheet === 'library' ? 'shelf' : sheet)).click();
    document.getElementById('toast').classList.remove('show');
    await new Promise(r => setTimeout(r, 2200));
    document.getElementById('toast').classList.remove('show');
    step('done: sheet=' + (sheet ? (document.getElementById(sheet).hidden ? 'hidden'
           : document.getElementById(sheet).className) : '-')
         + ' shelf=' + document.getElementById('shelf').children.length
         + ' books=' + (await window.app.library.list()).length
         + ' open=' + !!window.app.view.book);
    window.__shotReady = true;
  } catch (error) {
    window.__shotError = String(error && error.stack || error);
    window.__shotReady = true;
  }
})();
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8765/")
    parser.add_argument("--book", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument("--spine", type=int, default=-1)
    parser.add_argument("--page", type=int, default=0)
    parser.add_argument("--size", default="390x844")
    parser.add_argument("--bars", action="store_true")
    parser.add_argument("--all", action="store_true", help="本棚に全部取り込む")
    parser.add_argument("--sheet", default="", choices=["", "library", "settings", "contents"])
    parser.add_argument("--settings", nargs="*", default=[])
    parser.add_argument("--wait", type=int, default=25000)
    args = parser.parse_args()

    settings: dict[str, object] = {}
    for pair in args.settings:
        key, _, value = pair.partition("=")
        try:
            settings[key] = json.loads(value)
        except json.JSONDecodeError:
            settings[key] = value

    width, _, height = args.size.partition("x")
    app = QApplication(sys.argv)
    view = QWebEngineView()
    view.setPage(LoudPage(view))
    view.resize(int(width), int(height))
    view.show()

    state = {"done": False}

    def on_load(ok: bool) -> None:
        if not ok:
            print("ページを読み込めませんでした", file=sys.stderr)
            app.exit(1)
            return
        script = SETUP % {
            "book": json.dumps(args.book),
            "settings": json.dumps(settings, ensure_ascii=False),
            "spine": args.spine,
            "page": args.page,
            "bars": "true" if args.bars else "false",
            "all": "true" if args.all else "false",
            "sheet": json.dumps(args.sheet),
        }
        # The app boots on DOMContentLoaded; give it a moment to exist.
        QTimer.singleShot(900, lambda: view.page().runJavaScript(script))
        poll()

    # Ask for a JSON string, not an object: QtWebEngine hands back an empty
    # string when a value will not convert, and undefined inside an array is
    # enough to trigger that -- which looks exactly like "not ready yet".
    def poll() -> None:
        if state["done"]:
            return
        view.page().runJavaScript(
            "JSON.stringify({ready: !!window.__shotReady,"
            " error: window.__shotError || null,"
            " step: window.__shotStep || null})",
            handle,
        )

    def handle(result) -> None:
        if state["done"]:
            return
        try:
            status = json.loads(result) if result else {}
        except (TypeError, ValueError):
            status = {}
        state["step"] = status.get("step")
        if not status.get("ready"):
            QTimer.singleShot(250, poll)
            return
        state["done"] = True
        print(f"[step] {status.get('step')}", file=sys.stderr)
        if status.get("error"):
            print(status["error"], file=sys.stderr)
        QTimer.singleShot(400, capture)

    def capture() -> None:
        pixmap = view.grab()
        pixmap.save(args.out, "PNG")
        print(f"wrote {args.out} ({pixmap.width()}x{pixmap.height()})")
        app.quit()

    view.loadFinished.connect(on_load)
    view.load(QUrl(args.url))
    def give_up() -> None:
        print(f"timed out at: {state.get('step')}", file=sys.stderr)
        app.exit(2)

    QTimer.singleShot(args.wait, give_up)
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
