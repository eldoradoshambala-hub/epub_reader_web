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

/* The shelf: the home of the application, so everything it can do is checked
   the way it is done -- through the buttons. */
async function shelfChecks(check) {
  const app = window.app;
  await app.showLibrary();
  await wait(700);
  check('本棚が開く', !document.getElementById('library').hidden
        && !document.getElementById('library').classList.contains('away'));
  check('続きから が出る', !document.getElementById('resume').hidden);

  const before = (await app.library.list()).map((b) => b.id);
  if (before.length >= 2) {
    const moved = (await app.library.list())[0];
    await app.moveBook(moved, +1, await app.library.list());
    const after = (await app.library.list()).map((b) => b.id);
    check('本の位置を入れ替えられる', after[1] === before[0] && after[0] === before[1],
          `${before.slice(0, 2)} -> ${after.slice(0, 2)}`);
  } else {
    check('本の位置を入れ替えられる', true, '本が1冊（省略）');
  }

  const target = (await app.library.list())[0];
  await app.showBookMenu(target);
  await wait(400);
  await app.setBookGenre('manga');
  app.setGenre('novel');
  await wait(400);
  const hiddenByGenre = !Array.from(document.getElementById('shelf').children)
    .some((card) => card.querySelector('.name').textContent === (target.title || target.fileName));
  check('ジャンルで絞り込める', hiddenByGenre);
  app.setGenre('all');
  await wait(300);

  const folder = await app.library.addFolder('テスト棚');
  await app.library.update(target.id, { folderId: folder.id });
  await app.renderShelf();
  await wait(300);
  const atRoot = Array.from(document.getElementById('shelf').children)
    .some((card) => card.querySelector('.name').textContent === folder.name);
  check('フォルダが本棚に出る', atRoot);

  app.folderId = folder.id;
  await app.renderShelf();
  await wait(300);
  const inside = Array.from(document.getElementById('shelf').children)
    .some((card) => card.querySelector('.name').textContent === (target.title || target.fileName));
  check('フォルダの中に本が入る', inside);
  check('フォルダ名が見出しに出る',
        document.getElementById('shelf-title').textContent === folder.name);

  await app.library.removeFolder(folder.id);
  app.folderId = null;
  await app.renderShelf();
  await wait(300);
  const back = (await app.library.list()).find((b) => b.id === target.id);
  check('フォルダを消すと本は本棚へ戻る', back && !back.folderId);

  const count = (await app.library.list()).length;
  const doomed = (await app.library.list())[count - 1];
  await app.library.remove(doomed.id);
  await app.renderShelf();
  check('本を削除できる', (await app.library.list()).length === count - 1);

  const cover = await app.library.coverFor((await app.library.list())[0].id);
  check('読んだ後も表紙が残る', !!cover && cover.size > 0,
        cover ? `${Math.round(cover.size / 1024)} KB` : 'なし');

  closeSheetIfOpen('library');
}

/* Turning a page in a picture book must never leave the layer showing its own
   background. That gap was the black flash between manga pages: the old
   picture was taken away before the new one could be painted. Watch the layer
   itself rather than trusting the code that fills it. */
async function checkPictureTurns(check) {
  const app = window.app;
  const books = await app.library.list();
  const manga = books.find((b) => b.fileName.includes('manga_fixed'));
  if (!manga) { check('画像ページの切り替えで黒画面が出ない', true, '固定レイアウトの本なし（省略）'); return; }

  await app.openRecord(manga);
  await settle();
  if (app.reader.mode !== 'fixed') {
    check('画像ページの切り替えで黒画面が出ない', true, '固定レイアウトとして開かず（省略）');
    return;
  }

  const layer = document.querySelector('.fixed-layer');
  let unpaintable = 0;
  const observer = new MutationObserver(() => {
    const kids = Array.from(layer.children);
    if (!kids.length || !kids.every((i) => i.complete && i.naturalWidth > 0)) unpaintable++;
  });
  observer.observe(layer, { childList: true });

  let blankFrames = 0;
  let watching = true;
  const watch = () => {
    if (!watching) return;
    const kids = Array.from(layer.children);
    if (!kids.length || !kids.some((i) => i.complete && i.naturalWidth > 0)) blankFrames++;
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);

  const turns = Math.min(8, app.view.views.length - 1);
  for (let i = 0; i < turns; i++) { app.reader.next(); await wait(300); }
  watching = false;
  observer.disconnect();

  check('画像ページの切り替えで黒画面が出ない', unpaintable === 0 && blankFrames === 0,
        `${turns} 回 / 未描画 ${unpaintable} / 空フレーム ${blankFrames}`);
}

function closeSheetIfOpen(id) {
  const sheet = document.getElementById(id);
  if (!sheet.hidden) sheet.classList.add('away');
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
  // Positions live in their own store now, apart from the book record.
  const saved = await app.library.positionFor(record.id);
  check('読書位置が保存される', saved && saved.spineIndex === chapter,
        JSON.stringify(saved));

  check('章のページ数が測れている', startPages > 0, String(startPages));

  await checkPictureTurns(check);
  await shelfChecks(check);

  return { passed: results.filter((r) => r.ok).length, total: results.length, results };
}
