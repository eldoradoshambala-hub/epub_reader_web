"""Copy the web app out to a folder, ready to be committed or uploaded.

For the way this project is worked on: development happens in a private
repository, and only what is needed is copied into the public one. Rather than
picking files by hand each time -- which is how a stray audit file or a book
ends up published -- the list lives here.

    python webapp/tools/export.py --out ../epub_reader_web
    python webapp/tools/export.py --out //DS124/web/reader --runtime-only

--runtime-only copies just what the browser asks for; without it the test
tools and the README come too, which is what you want in a repository someone
else might read.

Nothing is deleted at the destination unless --clean is given, and even then
only files this script put there before.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Everything the running app fetches. Kept explicit: a glob would quietly pick
# up whatever happened to be lying in the folder.
RUNTIME = [
    "index.html",
    "app.css",
    "reader.css",
    "manifest.webmanifest",
    "sw.js",
    "js/app.js",
    "js/book.js",
    "js/epub.js",
    "js/library.js",
    "js/reader.js",
    "js/resources.js",
    "js/zip.js",
    "icons/icon-120.png",
    "icons/icon-152.png",
    "icons/icon-167.png",
    "icons/icon-180.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-maskable-512.png",
]

EXTRA = [
    "README.md",
    "package.json",
    "tools/export.py",
    "tools/harness.js",
    "tools/make_icons.py",
    "tools/serve.py",
    "tools/shot_web.py",
    "tools/ui_test.py",
    "tools/uitest.js",
    "tools/test_zip.mjs",
    "tools/parse_check.html",
    "tools/check_parser.py",
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--runtime-only", action="store_true")
    parser.add_argument("--clean", action="store_true",
                        help="先に出力先の同名ファイルを消す")
    args = parser.parse_args()

    wanted = list(RUNTIME) if args.runtime_only else RUNTIME + EXTRA
    missing = [name for name in wanted if not (ROOT / name).is_file()]
    if missing:
        print("元のファイルがありません:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1

    out = args.out.expanduser()
    out.mkdir(parents=True, exist_ok=True)

    if args.clean:
        for name in RUNTIME + EXTRA:
            target = out / name
            if target.is_file():
                target.unlink()

    for name in wanted:
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if name == "README.md":
            # At the destination this folder is the root, so the paths in the
            # commands lose the webapp/ in front of them.
            text = (ROOT / name).read_text(encoding="utf-8")
            text = text.replace("webapp/tools/", "tools/")
            text = text.replace("この `webapp` フォルダの中身", "このリポジトリの中身")
            target.write_text(text, encoding="utf-8")
        else:
            shutil.copy2(ROOT / name, target)

    total = sum((out / name).stat().st_size for name in wanted)
    print(f"{len(wanted)} 個 / {total / 1024:.0f} KB -> {out}")
    if not args.runtime_only:
        print("公開用リポジトリなら、この中身をそのままルートに置けば Pages で動きます。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
