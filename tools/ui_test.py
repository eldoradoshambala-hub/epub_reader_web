"""Run the browser-side interface test and report what passed.

    python webapp/tools/ui_test.py --book "沙門空海" --size 1024x768

Needs webapp/tools/serve.py running with --books. The test itself lives in
tools/uitest.js; this only loads a book, runs it, and prints the result.
"""

from __future__ import annotations

import argparse
import json
import sys

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication

INNER = """
import * as test from '/tools/uitest.js';
(async () => {
  try {
    const listing = await (await fetch('/books/')).text();
    const names = Array.from(listing.matchAll(/href="([^"]+\\.epub)"/g))
      .map((m) => decodeURIComponent(m[1]));
    const name = names.find((n) => n.includes(%(book)s)) || names[0];
    if (!name) throw new Error('本がありません');
    const blob = await (await fetch('/books/' + encodeURIComponent(name))).blob();
    await window.app.importFiles([new File([blob], name, { type: 'application/epub+zip' })]);
    window.__uiResult = await test.run();
  } catch (error) {
    window.__uiResult = { error: String(error && error.stack || error) };
  }
  window.__uiDone = true;
})();
"""

# runJavaScript evaluates in an isolated world, where a dynamic import() has no
# base URL to resolve against. Injecting a module script instead runs the test
# in the page's own world, which is also where window.app lives.
SCRIPT = """
window.__uiDone = false;
window.__uiResult = null;
const el = document.createElement('script');
el.type = 'module';
el.textContent = %(inner)s;
document.body.appendChild(el);
"""


class LoudPage(QWebEnginePage):
    def javaScriptConsoleMessage(self, level, message, line, source):
        print(f"[console] {message}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8765/")
    parser.add_argument("--book", default="")
    parser.add_argument("--size", default="1024x768")
    parser.add_argument("--wait", type=int, default=120000)
    args = parser.parse_args()

    width, _, height = args.size.partition("x")
    app = QApplication(sys.argv)
    view = QWebEngineView()
    view.setPage(LoudPage(view))
    view.resize(int(width), int(height))
    view.show()

    state = {"code": 2}

    def on_load(ok: bool) -> None:
        if not ok:
            print("ページを読み込めませんでした", file=sys.stderr)
            app.exit(1)
            return
        inner = INNER % {"book": json.dumps(args.book)}
        QTimer.singleShot(
            900, lambda: view.page().runJavaScript(SCRIPT % {"inner": json.dumps(inner)})
        )
        poll()

    def poll() -> None:
        view.page().runJavaScript(
            "JSON.stringify({done: !!window.__uiDone, result: window.__uiResult || null})",
            handle,
        )

    def handle(raw) -> None:
        try:
            status = json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            status = {}
        if not status.get("done"):
            QTimer.singleShot(400, poll)
            return
        report(status.get("result") or {})

    def report(result: dict) -> None:
        if result.get("error"):
            print(result["error"], file=sys.stderr)
            app.exit(2)
            return
        for row in result.get("results", []):
            mark = "OK  " if row["ok"] else "NG  "
            detail = f"  ({row['detail']})" if row.get("detail") else ""
            print(f"{mark}{row['name']}{detail}")
        passed, total = result.get("passed", 0), result.get("total", 0)
        print(f"\n{passed}/{total}")
        state["code"] = 0 if passed == total else 1
        app.quit()

    view.loadFinished.connect(on_load)
    view.load(QUrl(args.url))
    QTimer.singleShot(args.wait, lambda: (print("timed out", file=sys.stderr), app.exit(2)))
    app.exec()
    return state["code"]


if __name__ == "__main__":
    raise SystemExit(main())
