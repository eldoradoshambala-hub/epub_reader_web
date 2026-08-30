"""Does the web app read a pile of pictures as a book?

Drives the real application in a real browser: imports a picture ZIP and a set
of separately picked pictures the way the Files app hands them over, opens
both, and checks the things a picture reader gets wrong -- the page order, the
lone cover, a scanned double spread that must not be paired, the binding
switch, and whether the picture on screen is the page the reader says it is on.

Needs webapp/tools/serve.py running with --books pointed at a folder holding
the fixtures (a picture ZIP and some loose pictures).

    python webapp/tools/image_test.py --zip 画像ZIP.zip --pictures 画像フォルダ
"""

from __future__ import annotations

import argparse
import json
import sys

from PySide6.QtCore import QTimer, QUrl
from PySide6.QtWebEngineCore import QWebEnginePage
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QApplication

INNER = r"""
(async () => {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fileFrom(url, name) {
    const blob = await (await fetch(url)).blob();
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
  }

  async function listing(path) {
    const text = await (await fetch(path)).text();
    return Array.from(text.matchAll(/href="([^"?]+)"/g))
      .map((m) => decodeURIComponent(m[1]))
      .filter((n) => !n.startsWith('/') && !n.endsWith('/'));
  }

  try {
    const app = window.app;
    const wanted = %(config)s;

    /* -- a ZIP of pictures, opened without unpacking --------------------- */

    const zipFile = await fileFrom('/books/' + encodeURIComponent(wanted.zip), wanted.zip);
    await app.importFiles([zipFile]);
    let books = await app.library.list();
    let record = books.find((b) => b.fileName === wanted.zip);
    check('ZIP が画像の本として入る', record && record.kind === 'images',
          record ? record.kind : '(なし)');
    check('漫画として棚に並ぶ', record && record.genre === 'manga', record && record.genre);
    check('表紙が作られる', !!(await app.library.coverFor(record.id)));

    await app.openRecord(record);
    await sleep(700);
    let book = app.view.book;
    check('固定レイアウトとして開く', book.isFixedLayout);
    check('右開きで開く', app.view.readsRightToLeft);
    check('CP932 のファイル名が読める',
          book.labels.every((label) => !/[�]/.test(label)),
          book.labels.slice(0, 2).join(' / '));
    check('ページ順が自然順',
          JSON.stringify(book.labels)
            === JSON.stringify(book.labels.slice().sort(window.__comparePaths)),
          book.labels.join(' / '));
    check('ページ一覧になる', document.getElementById('contents-title').textContent === 'ページ',
          document.getElementById('contents-title').textContent);
    check('綴じ方向の切り替えが出る', !document.getElementById('btn-binding').hidden);

    await app.setSpreadMode('double');
    await sleep(500);
    check('表紙は単独', JSON.stringify(app.view.views[0]) === '[0]',
          JSON.stringify(app.view.views.slice(0, 3)));

    /* Turning through to the end must never show a page other than the one
       the reader says it is on. */
    let mismatch = '';
    for (let turn = 0; turn < app.view.views.length - 1; turn++) {
      const before = app.view.viewIndex;
      app.reader.next();
      await sleep(340);
      const group = app.view.views[app.view.viewIndex];
      const shown = Array.from(document.querySelectorAll('#reader .fixed-layer img'));
      if (app.view.viewIndex !== before + 1) mismatch = `view ${before} -> ${app.view.viewIndex}`;
      else if (shown.length !== group.length) mismatch = `枚数 ${shown.length} / ${group.length}`;
      else if (!shown.every((img) => img.complete && img.naturalWidth > 0)) mismatch = '画像が描けない';
      if (mismatch) break;
    }
    check('最後までページが送れて、表示が一致する', !mismatch, mismatch);

    /* -- the binding switch ---------------------------------------------- */

    document.getElementById('btn-binding').click();
    await sleep(500);
    check('左開きに切り替わる', !app.view.readsRightToLeft);
    let saved = await app.library.get(record.id);
    check('綴じ方向を本ごとに憶える', saved.rtl === false, String(saved.rtl));
    document.getElementById('btn-binding').click();
    await sleep(400);

    /* -- separately picked pictures, as one volume ------------------------ */

    const names = (await listing('/books/' + wanted.pictures + '/'))
      .filter((n) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(n));
    const pictures = [];
    for (const name of names) {
      pictures.push(await fileFrom(
        '/books/' + wanted.pictures + '/' + encodeURIComponent(name), name
      ));
    }
    check('画像を複数選べる', pictures.length >= 3, `${pictures.length} 枚`);
    await app.importFiles(pictures);
    books = await app.library.list();
    const set = books.find((b) => b.id.startsWith('set:'));
    check('まとめて 1 冊になる', !!set && set.kind === 'images', set ? set.id : '(なし)');

    await app.openRecord(set);
    await sleep(700);
    book = app.view.book;
    check('選んだ枚数ぶんのページ', book.spine.length === pictures.length,
          `${book.spine.length} / ${pictures.length}`);
    check('自然順に並ぶ', book.labels[0] === 'p1.png' && book.labels[1] === 'p2.png',
          book.labels.join(' / '));

    await app.setSpreadMode('double');
    await sleep(500);
    const wide = book.spine.map((_, i) => i).filter((i) => book.standsAlone(i));
    const pairedWide = wide.filter(
      (i) => app.view.views.some((g) => g.length > 1 && g.includes(i))
    );
    check('横長ページを見つける', wide.length === 1, `横長 ${JSON.stringify(wide)}`);
    check('横長ページは組まれない', pairedWide.length === 0, JSON.stringify(pairedWide));
    check('ページ番号で数える',
          /^\d+(–\d+)?\/\d+$/.test(document.getElementById('page-count').textContent),
          document.getElementById('page-count').textContent);

    /* Re-opening resumes where it was left, the way a book does. */
    app.reader.next();
    await sleep(450);
    const at = app.view.spineIndex;
    app.savePositionNow();
    await sleep(300);
    await app.openRecord(await app.library.get(set.id));
    await sleep(700);
    check('開き直すと続きから', app.view.spineIndex === at,
          `${at} -> ${app.view.spineIndex}`);

    window.__uiResult = {
      results,
      passed: results.filter((r) => r.ok).length,
      total: results.length,
    };
  } catch (error) {
    window.__uiResult = { error: String((error && error.stack) || error) };
  }
  window.__uiDone = true;
})();
"""

# The natural-order comparison the app itself uses, put where the test can
# reach it: checking the order against a different implementation would only
# prove the two agree with each other.
PRELUDE = """
import { comparePaths } from '/js/imagebook.js';
window.__comparePaths = comparePaths;
"""

SCRIPT = """
window.__uiDone = false;
window.__uiResult = null;
const prelude = document.createElement('script');
prelude.type = 'module';
prelude.textContent = %(prelude)s;
document.body.appendChild(prelude);
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
    parser.add_argument("--zip", default="画像ZIP.zip")
    parser.add_argument("--pictures", default="画像フォルダ")
    parser.add_argument("--size", default="1024x768")
    parser.add_argument("--wait", type=int, default=180000)
    args = parser.parse_args()

    width, _, height = args.size.partition("x")
    app = QApplication(sys.argv)
    view = QWebEngineView()
    view.setPage(LoudPage(view))
    view.resize(int(width), int(height))
    view.show()

    state = {"code": 2}

    def on_load(ok):
        if not ok:
            print("ページを読み込めませんでした", file=sys.stderr)
            app.exit(1)
            return
        config = json.dumps({"zip": args.zip, "pictures": args.pictures})
        inner = INNER % {"config": config}
        QTimer.singleShot(900, lambda: view.page().runJavaScript(SCRIPT % {
            "prelude": json.dumps(PRELUDE), "inner": json.dumps(inner),
        }))
        poll()

    def poll():
        view.page().runJavaScript(
            "JSON.stringify({done: !!window.__uiDone, result: window.__uiResult || null})",
            handle,
        )

    def handle(raw):
        try:
            status = json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            status = {}
        if not status.get("done"):
            QTimer.singleShot(400, poll)
            return
        report(status.get("result") or {})

    def report(result):
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
