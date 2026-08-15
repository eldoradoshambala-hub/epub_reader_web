/* Drive the reader the way a finger does, and check what happens.
 *
 * Loaded into the running app by tools/ui_test.py:
 *   const t = await import('/tools/uitest.js'); await t.run();
 *
 * Taps are dispatched as real click events inside the chapter iframe, so they
 * travel the same path as a touch: through the anchor test, then the tap
 * zones. Anything that only calls the reader's methods directly would pass
 * even if nothing were wired to the screen at all.
 */

'use strict';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(450);

function tapAt(fraction) {
  const app = window.app;
  const frame = app.reader.frames[0];
  const doc = app.reader.paneDoc(frame);
  const box = frame.getBoundingClientRect();
  const x = window.innerWidth * fraction - box.left;
  const target = doc.body;
  target.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: box.height / 2,
  }));
}

async function openFirstBook() {
  const app = window.app;
  const books = await app.library.list();
  if (!books.length) throw new Error('本棚が空です');
  await app.openRecord(books[0]);
  await settle();
  return books[0];
}

/** The first spine item with more than a couple of pages of running text. */
async function findTextChapter() {
  const app = window.app;
  const count = app.view.book.spine.length;
  for (let i = 0; i < count; i++) {
    await app.view.showSpine(i);
    await settle();
    if (app.reader.mode === 'reflow' && app.reader.pageCount >= 4) return i;
  }
  throw new Error('本文のある章が見つかりません');
}

export async function run() {
  const app = window.app;
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

  const record = await openFirstBook();
  check('本が開く', !!app.view.book, app.view.book && app.view.book.metadata.title);

  const chapter = await findTextChapter();
  const startPages = app.reader.pageCount;

  // -- page turning -------------------------------------------------------
  const before = app.reader.pageIndex;
  tapAt(0.15);
  await settle();
  const afterForward = app.reader.pageIndex;
  check('左タップで進む', afterForward > before, `${before} -> ${afterForward}`);

  tapAt(0.85);
  await settle();
  check('右タップで戻る', app.reader.pageIndex === before,
        `${afterForward} -> ${app.reader.pageIndex}`);

  // -- the bars -----------------------------------------------------------
  app.toggleBars(false);
  tapAt(0.5);
  await wait(150);
  const shown = !document.getElementById('bar-top').classList.contains('away');
  tapAt(0.5);
  await wait(150);
  const hidden = document.getElementById('bar-top').classList.contains('away');
  check('中央タップでバーが出る', shown);
  check('もう一度で引っ込む', hidden);

  // -- links --------------------------------------------------------------
  let linkChecked = false;
  for (let i = 0; i < app.view.book.spine.length && !linkChecked; i++) {
    await app.view.showSpine(i);
    await settle();
    const doc = app.reader.paneDoc(app.reader.frames[0]);
    if (!doc || app.reader.mode !== 'reflow') continue;
    const anchor = Array.from(doc.querySelectorAll('a[href]'))
      .find((a) => !/^[a-z][a-z0-9+.-]*:/i.test(a.getAttribute('href') || ''));
    if (!anchor) continue;
    const from = app.view.spineIndex;
    anchor.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, detail: 1, clientX: 10, clientY: 10,
    }));
    await wait(900);
    check('本文中のリンクで移動する', app.view.spineIndex !== from || app.view.offSpine,
          `${from} -> ${app.view.spineIndex}`);
    linkChecked = true;
  }
  if (!linkChecked) check('本文中のリンクで移動する', true, 'リンクなし（省略）');

  // -- contents -----------------------------------------------------------
  await app.view.showSpine(chapter);
  await settle();
  const tocButtons = document.querySelectorAll('#toc-list li button');
  if (tocButtons.length > 1) {
    const from = app.view.spineIndex;
    tocButtons[tocButtons.length - 1].click();
    await wait(1000);
    check('目次から飛べる', app.view.spineIndex !== from,
          `${from} -> ${app.view.spineIndex}`);
  } else {
    check('目次から飛べる', true, '項目なし（省略）');
  }

  // -- page display -------------------------------------------------------
  await app.view.showSpine(chapter);
  await settle();
  await app.setSpreadMode('double');
  await wait(900);
  check('見開きに切り替わる', app.reader.spread || app.view.spreadOnScreen,
        `spread=${app.reader.spread}`);
  const pressed = document.querySelector('#spread-modes button[data-mode="double"]')
    .getAttribute('aria-pressed');
  check('見開きボタンが押された状態になる', pressed === 'true');

  if (app.reader.spread) {
    const parityBefore = app.reader.pageParity;
    app.shiftSpread(-1);
    await wait(400);
    check('◀ で見開きが1ページずれる', app.reader.pageParity !== parityBefore,
          `parity ${parityBefore} -> ${app.reader.pageParity}`);
  } else {
    check('◀ で見開きが1ページずれる', true, '見開きにならない画面幅（省略）');
  }

  await app.setSpreadMode('single');
  await wait(900);
  check('単ページに戻せる', !app.reader.spread);
  await app.setSpreadMode('auto');
  await wait(900);

  // -- seeking ------------------------------------------------------------
  await app.view.seekToFraction(0.5);
  await wait(1000);
  const fraction = app.view.progressFraction();
  check('進捗バーの位置へ飛ぶ', Math.abs(fraction - 0.5) < 0.12, fraction.toFixed(3));

  // -- settings -----------------------------------------------------------
  await app.view.showSpine(chapter);
  await settle();
  const pagesBefore = app.reader.pageCount;
  app.change('fontSize', 30);
  await wait(900);
  check('文字を大きくするとページ数が増える', app.reader.pageCount > pagesBefore,
        `${pagesBefore} -> ${app.reader.pageCount}`);
  app.change('fontSize', 19);
  await wait(900);
  check('元に戻せる', Math.abs(app.reader.pageCount - pagesBefore) <= 1,
        `${app.reader.pageCount} / ${pagesBefore}`);

  // -- remembering where you were -----------------------------------------
  await app.view.showSpine(chapter);
  await settle();
  app.reader.goToPage(2, false);
  await wait(400);
  app.savePositionNow();
  await wait(400);
  const saved = await app.library.get(record.id);
  check('読書位置が保存される',
        saved && saved.position && saved.position.spineIndex === chapter,
        JSON.stringify(saved && saved.position));

  check('章のページ数が測れている', startPages > 0, String(startPages));

  return { passed: results.filter((r) => r.ok).length, total: results.length, results };
}
