"""Compare the JavaScript EPUB parser against the Python one, book by book.

The web reader re-implements what the desktop reader learned from a real
library, so the only verification worth having is running both over the same
books and diffing the results. This serves the web app and the books over
localhost, drives a browser through them, and reports every field that differs.

Usage:
    python webapp/tools/check_parser.py <folder-or-file...> [--sample N]
"""

from __future__ import annotations

import http.server
import json
import os
import random
import socketserver
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
WEBAPP = os.path.dirname(HERE)
PROJECT = os.path.dirname(WEBAPP)
sys.path.insert(0, PROJECT)

from PySide6 import QtWebEngineWidgets  # noqa: F401,E402
from PySide6.QtCore import QTimer  # noqa: E402
from PySide6.QtWebEngineWidgets import QWebEngineView  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from epubreader.epubfile import DOCUMENT_TYPES, EpubError, open_epub  # noqa: E402

# Fields where a mismatch means the port is wrong, rather than a difference in
# how the two languages happen to render a value.
COMPARED = [
    "title", "creator", "language", "layout", "direction", "opfDir",
    "manifest", "spine", "docs", "toc", "tocUnresolved", "vertical",
    "cover", "spreadSides", "firstHrefs", "tocFirst",
]


def find_books(roots, sample):
    found = []
    for root in roots:
        if os.path.isfile(root):
            found.append(root)
            continue
        for base, _dirs, files in os.walk(root):
            for name in sorted(files):
                if name.lower().endswith(".epub"):
                    found.append(os.path.join(base, name))
    found.sort()
    if sample and len(found) > sample:
        # Spread the sample across the collection rather than taking a run of
        # volumes from one series, which would all share a producer.
        rng = random.Random(11)
        found = sorted(rng.sample(found, sample))
    return found


def python_side(path):
    row = {"name": os.path.basename(path)}
    try:
        book = open_epub(path)
    except EpubError as exc:
        row["error"] = str(exc)
        return row
    try:
        docs = [s for s in book.spine if s.media_type in DOCUMENT_TYPES]
        row.update(
            title=book.metadata.title,
            creator=book.metadata.creator,
            language=book.metadata.language,
            layout=book.metadata.layout,
            direction=book.direction,
            opfDir=book.opf_dir,
            manifest=len(book.manifest),
            spine=len(book.spine),
            docs=len(docs),
            toc=len(book.toc),
            tocFirst=[[t.label, t.href, t.fragment, t.depth] for t in book.toc[:3]],
            tocUnresolved=sum(
                1 for t in book.toc if t.href not in {s.href for s in book.spine}
            ),
            vertical=book.looks_vertical(),
            cover=book.cover_href,
            spreadSides=[s.spread_side for s in book.spine[:8]],
            firstHrefs=[s.href for s in book.spine[:3]],
        )
    finally:
        book.close()
    return row


def make_server(books):
    listing = json.dumps(
        [{"name": os.path.basename(p)} for p in books], ensure_ascii=False
    ).encode("utf-8")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=WEBAPP, **kwargs)

        def log_message(self, *args):
            pass  # the harness output is noisy enough

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/tools/books.json":
                self._send(listing, "application/json")
                return
            if path.startswith("/tools/book/"):
                try:
                    index = int(path.rsplit("/", 1)[1])
                    with open(books[index], "rb") as fh:
                        self._send(fh.read(), "application/epub+zip")
                except (ValueError, IndexError, OSError):
                    self.send_error(404)
                return
            super().do_GET()

        def _send(self, payload, mime):
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    return Server(("127.0.0.1", 0), Handler)


def compare(expected, actual):
    """Fields that differ between the two implementations."""
    if "error" in expected or "error" in actual:
        if expected.get("error") and actual.get("error"):
            return []          # both refused it; that is agreement enough
        return [("error", expected.get("error"), actual.get("error"))]
    diffs = []
    for field in COMPARED:
        want = expected.get(field)
        got = actual.get(field)
        if isinstance(want, list):
            want = json.loads(json.dumps(want))
        if want != got:
            diffs.append((field, want, got))
    return diffs


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sample = 0
    if "--sample" in sys.argv:
        sample = int(sys.argv[sys.argv.index("--sample") + 1])

    books = find_books(args, sample)
    print(f"{len(books)} 冊を両実装で解析して突き合わせます\n")

    print("  Python 側を解析中...", flush=True)
    expected = [python_side(path) for path in books]

    server = make_server(books)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    app = QApplication([sys.argv[0]])
    view = QWebEngineView()
    view.resize(500, 300)
    view.show()
    view.load(f"http://127.0.0.1:{port}/tools/parse_check.html")

    state = {"done": False}

    def poll():
        view.page().runJavaScript(
            "JSON.stringify({p: window.__progress, r: window.__results})", received
        )

    def received(raw):
        try:
            payload = json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            payload = {}
        if payload.get("r") is None:
            print(f"    browser: {payload.get('p', 0)}/{len(books)}", flush=True)
            QTimer.singleShot(3000, poll)
            return
        state["done"] = True
        report(payload["r"])
        app.quit()

    def report(actual):
        print()
        mismatched = 0
        for want, got in zip(expected, actual):
            diffs = compare(want, got)
            if not diffs:
                continue
            mismatched += 1
            print(f"  ✗ {want['name'][:58]}")
            for field, a, b in diffs[:4]:
                print(f"      {field}: python={a!r}")
                print(f"      {' ' * len(field)}  js    ={b!r}")
        print()
        print("=" * 70)
        print(f"一致          : {len(books) - mismatched} / {len(books)}")
        print(f"不一致        : {mismatched}")
        print("=" * 70)
        state["failed"] = mismatched

    QTimer.singleShot(2500, poll)
    QTimer.singleShot(20 * 60 * 1000, app.quit)
    app.exec()
    server.shutdown()
    return 1 if state.get("failed") or not state["done"] else 0


if __name__ == "__main__":
    sys.exit(main())
