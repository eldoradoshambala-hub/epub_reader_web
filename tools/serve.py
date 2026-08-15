"""Serve the web app over the local network.

Enough to try the reader on an iPhone before deciding where it should really
live: run this on the PC, open the printed address in Safari on the phone, and
add it to the home screen.

    python webapp/tools/serve.py            # just the app
    python webapp/tools/serve.py --books "D:/小説３/epub"

The optional --books directory is published at /books/ purely so the automated
render checks can fetch a real EPUB; leave it off for normal use.
"""

from __future__ import annotations

import argparse
import http.server
import posixpath
import socket
import socketserver
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Safari refuses a module script served as text/plain, and treats a manifest
# with the wrong type as absent.
EXTRA_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".webmanifest": "application/manifest+json",
    ".epub": "application/epub+zip",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    books: Path | None = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path: str) -> str:
        clean = urllib.parse.urlparse(path).path
        if self.books is not None and clean.startswith("/books/"):
            name = urllib.parse.unquote(clean[len("/books/"):])
            # Keep the mount inside the folder it was given.
            target = (self.books / name).resolve()
            if self.books.resolve() in target.parents or target == self.books.resolve():
                return str(target)
            return str(self.books)
        return super().translate_path(path)

    def guess_type(self, path):
        suffix = posixpath.splitext(str(path))[1].lower()
        if suffix in EXTRA_TYPES:
            return EXTRA_TYPES[suffix]
        return super().guess_type(path)

    def end_headers(self):
        # The service worker and the shell must not be served from a stale
        # cache while the app is being changed.
        self.send_header("Cache-Control", "no-store")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


def lan_address() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--books", type=Path, default=None)
    args = parser.parse_args()

    Handler.books = args.books
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", args.port), Handler) as server:
        print(f"PC:       http://localhost:{args.port}/")
        print(f"iPhone:   http://{lan_address()}:{args.port}/")
        if args.books:
            print(f"books:    /books/ -> {args.books}")
        print("Ctrl+C で終了")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
