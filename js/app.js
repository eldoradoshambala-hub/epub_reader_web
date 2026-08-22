/* The application: shelf, reader, and the controls around them.
 *
 * Everything below the surface -- the ZIP, the parser, the paginator -- is
 * shared with the desktop reader. This file is the part that is specific to a
 * phone: a shelf you fill from the Files app, three sheets that slide over the
 * page, and bars that stay out of the way until you tap the middle of the
 * screen.
 */

'use strict';

import { Epub } from './epub.js';
import { Reader, DEFAULT_SETTINGS } from './reader.js';
import { BookView } from './book.js';
import { Library } from './library.js';
import { mimeFor } from './resources.js';

const VERSION = '1.0.0';
const SETTINGS_KEY = 'reader.settings';
const LAST_BOOK_KEY = 'reader.lastBook';

const BACKGROUND_PRESETS = [
  ['#f3ede1', '生成り'],
  ['#ffffff', '白'],
  ['#efe6d2', '古紙'],
  ['#dfe7dd', '若草'],
  ['#2b2b2b', '墨'],
  ['#12161c', '夜'],
];

const el = (id) => document.getElementById(id);

/* -- small pieces of interface ------------------------------------------- */

let toastTimer = 0;
function toast(message) {
  const node = el('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
}

function busy(on, text) {
  const node = el('busy');
  if (text) el('busy-text').textContent = text;
  node.hidden = !on;
}

/* A sheet is kept in the DOM but translated off-screen, so opening it does not
   re-run the layout of the page underneath. */
function openSheet(id) {
  const sheet = el(id);
  sheet.dataset.open = '1';
  sheet.hidden = false;
  sheet.classList.add('away');
  // Flush the style so the sheet starts off-screen, then let it slide in.
  // This used to wait for an animation frame, but a frame is not guaranteed
  // to arrive promptly -- and if it did not, the class stayed on and the
  // sheet never appeared at all.
  void sheet.offsetHeight;
  sheet.classList.remove('away');
}

function closeSheet(id) {
  const sheet = el(id);
  delete sheet.dataset.open;
  sheet.classList.add('away');
  // Only take it out of the layout if it is still meant to be closed: opening
  // the same sheet again during the slide would otherwise be undone here.
  setTimeout(() => {
    if (!sheet.dataset.open) sheet.hidden = true;
  }, 260);
}

function sheetIsOpen(id) {
  const sheet = el(id);
  return !sheet.hidden && !sheet.classList.contains('away');
}

/* -- the application ------------------------------------------------------ */

class App {
  constructor(library, baseCss) {
    this.library = library;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadSettings());
    this.normaliseSpreadModes();
    this.record = null;         // shelf entry of the open book
    this.editingShelf = false;
    this.folderId = null;       // which folder the shelf is showing
    this.genre = 'all';
    this.allBooks = [];
    this.menuRecord = null;
    this.backgroundUrl = null;
    this.coverUrls = [];
    this.saveTimer = 0;
    this.barsTimer = 0;

    this.reader = new Reader(el('reader'), {
      baseCss,
      onTapMiddle: () => this.toggleBars(),
    });
    this.view = new BookView(this.reader, {
      onPosition: (state) => this.onPosition(state),
      onChapter: (index) => this.markChapter(index),
      onMessage: (text) => toast(text),
    });

    this.bindChrome();
    this.buildSettingsForm();
    this.reader.configure(this.settings);
    this.applyPageColours();
  }

  /* -- chrome ------------------------------------------------------------ */

  bindChrome() {
    el('btn-shelf').addEventListener('click', () => this.showLibrary());
    el('btn-close-library').addEventListener('click', () => closeSheet('library'));
    el('btn-contents').addEventListener('click', () => this.showContents());
    el('btn-close-contents').addEventListener('click', () => closeSheet('contents'));
    el('btn-settings').addEventListener('click', () => { this.refreshStorageNote(); openSheet('settings'); });
    el('btn-close-settings').addEventListener('click', () => closeSheet('settings'));
    el('btn-reset-settings').addEventListener('click', () => this.resetSettings());

    el('btn-import').addEventListener('click', () => el('file-input').click());
    el('file-input').addEventListener('change', (e) => this.importFiles(e.target.files));
    el('btn-edit-shelf').addEventListener('click', () => this.toggleShelfEditing());
    el('btn-new-folder').addEventListener('click', () => this.newFolder());
    el('btn-folder-up').addEventListener('click', async () => {
      const folders = await this.library.folders();
      const here = folders.find((f) => f.id === this.folderId);
      this.folderId = here ? here.parentId || null : null;
      await this.renderShelf();
    });
    for (const button of el('genre-tabs').querySelectorAll('button')) {
      button.addEventListener('click', () => this.setGenre(button.dataset.genre));
    }
    el('btn-close-book-menu').addEventListener('click', () => closeSheet('book-menu'));
    for (const button of el('book-genre').querySelectorAll('button')) {
      button.addEventListener('click', () => this.setBookGenre(button.dataset.genre));
    }
    el('btn-move-back').addEventListener('click', () => this.moveFromMenu(-1));
    el('btn-move-forward').addEventListener('click', () => this.moveFromMenu(+1));
    el('btn-delete-book').addEventListener('click', async () => {
      const record = this.menuRecord;
      if (!record) return;
      closeSheet('book-menu');
      await this.removeRecord(record);
    });

    for (const button of el('spread-modes').querySelectorAll('button')) {
      button.addEventListener('click', () => this.setSpreadMode(button.dataset.mode));
    }
    el('btn-shift-left').addEventListener('click', () => this.shiftSpread(-1));
    el('btn-shift-right').addEventListener('click', () => this.shiftSpread(+1));

    this.bindSeek();

    // Leaving the app (or the tab going to the background on iOS) is the last
    // reliable moment to write the reading position.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.savePositionNow();
    });
    window.addEventListener('pagehide', () => this.savePositionNow());
  }

  toggleBars(force) {
    const show = force === undefined ? el('bar-top').classList.contains('away') : force;
    clearTimeout(this.barsTimer);
    el('bar-top').classList.toggle('away', !show);
    el('bar-bottom').classList.toggle('away', !show);
  }

  flashBars(ms = 2500) {
    this.toggleBars(true);
    clearTimeout(this.barsTimer);
    this.barsTimer = setTimeout(() => this.toggleBars(false), ms);
  }

  /* -- library ------------------------------------------------------------ */

  async showLibrary() {
    await this.renderShelf();
    el('btn-close-library').hidden = !this.view.book;
    openSheet('library');
  }

  /* One pass over the shelf: folders first, then the books in this folder that
     match the chosen genre, in the order the user put them in. */
  async renderShelf() {
    const [books, folders, covers, positions] = await Promise.all([
      this.library.list(),
      this.library.folders(),
      this.library.covers(),
      this.positionsById(),
    ]);
    this.allBooks = books;

    for (const url of this.coverUrls) URL.revokeObjectURL(url);
    this.coverUrls = [];
    const coverUrl = (id) => {
      const blob = covers.get(id);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      this.coverUrls.push(url);
      return url;
    };

    const here = folders.filter((f) => (f.parentId || null) === this.folderId);
    const mine = books.filter((b) => (b.folderId || null) === this.folderId
      && (this.genre === 'all' || (b.genre || 'other') === this.genre));

    const folder = folders.find((f) => f.id === this.folderId);
    el('shelf-title').textContent = folder ? folder.name : '本棚';
    el('btn-folder-up').hidden = !this.folderId;
    el('edit-bar').hidden = !this.editingShelf;

    this.renderResume(books, covers, positions);

    const shelf = el('shelf');
    shelf.replaceChildren();
    shelf.classList.toggle('editing', this.editingShelf);
    el('shelf-empty').hidden = books.length > 0;

    for (const entry of here) shelf.appendChild(this.folderCard(entry, books));
    for (const record of mine) {
      shelf.appendChild(this.bookCard(record, coverUrl(record.id), positions.get(record.id), mine));
    }
  }

  async positionsById() {
    const books = await this.library.list();
    const pairs = await Promise.all(
      books.map(async (b) => [b.id, await this.library.positionFor(b.id)])
    );
    return new Map(pairs);
  }

  folderCard(folder, books) {
    const count = books.filter((b) => b.folderId === folder.id).length;
    const card = document.createElement('div');
    card.className = 'book folder';

    const open = document.createElement('button');
    open.className = 'cover folder-cover';
    open.textContent = '📁';
    open.addEventListener('click', () => {
      this.folderId = folder.id;
      this.renderShelf();
    });

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = folder.name;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${count} 冊`;

    card.append(open, name, meta);
    if (this.editingShelf) {
      const row = document.createElement('div');
      row.className = 'card-actions';
      row.append(
        this.smallButton('名前', async () => {
          const next = prompt('フォルダ名', folder.name);
          if (next && next.trim()) {
            await this.library.renameFolder(folder.id, next.trim());
            this.renderShelf();
          }
        }),
        this.smallButton('削除', async () => {
          if (!confirm(`フォルダ「${folder.name}」を削除します。中の本は残ります。`)) return;
          await this.library.removeFolder(folder.id);
          this.renderShelf();
        }),
      );
      card.appendChild(row);
    }
    return card;
  }

  bookCard(record, url, position, siblings) {
    const card = document.createElement('div');
    card.className = 'book';
    if (this.record && this.record.id === record.id) card.classList.add('current');

    const open = document.createElement('button');
    open.className = 'cover';
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      open.appendChild(img);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'placeholder';
      placeholder.textContent = record.title || record.fileName;
      open.appendChild(placeholder);
    }
    open.addEventListener('click', () => this.openRecord(record));
    open.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showBookMenu(record);
    });

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = record.title || record.fileName;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [];
    if (record.creator) parts.push(record.creator);
    if (position && position.fraction > 0.005) {
      parts.push(`${Math.round(position.fraction * 100)}%`);
    }
    meta.textContent = parts.join(' ・ ') || formatSize(record.size);

    card.append(open, name, meta);

    if (this.editingShelf) {
      const row = document.createElement('div');
      row.className = 'card-actions';
      row.append(
        this.smallButton('◀', () => this.moveBook(record, -1, siblings)),
        this.smallButton('…', () => this.showBookMenu(record)),
        this.smallButton('▶', () => this.moveBook(record, +1, siblings)),
      );
      card.appendChild(row);
    }
    return card;
  }

  smallButton(label, onClick) {
    const button = document.createElement('button');
    button.className = 'small';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  /* Moving is expressed against what is on screen -- swap with the neighbour
     you can see -- but written as a complete order, so a book filtered out of
     the current view keeps its place. */
  async moveBook(record, delta, siblings) {
    const at = siblings.findIndex((b) => b.id === record.id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= siblings.length) return;

    const all = this.allBooks.map((b) => b.id);
    const from = all.indexOf(record.id);
    const target = all.indexOf(siblings[to].id);
    if (from < 0 || target < 0) return;
    all.splice(from, 1);
    all.splice(target, 0, record.id);

    await this.library.reorder(all);
    await this.renderShelf();
  }

  renderResume(books, covers, positions) {
    const id = localStorage.getItem(LAST_BOOK_KEY);
    const record = books.find((b) => b.id === id);
    const showable = record && !this.folderId && this.genre === 'all' && !this.editingShelf;
    el('resume').hidden = !showable;
    if (!showable) return;

    const blob = covers.get(record.id);
    const image = el('resume-cover');
    if (blob) {
      const url = URL.createObjectURL(blob);
      this.coverUrls.push(url);
      image.src = url;
      image.hidden = false;
    } else {
      image.hidden = true;
    }
    el('resume-title').textContent = record.title || record.fileName;
    const position = positions.get(record.id);
    el('resume-meta').textContent = position && position.fraction > 0.005
      ? `${Math.round(position.fraction * 100)}%`
      : (record.creator || '');
    el('resume').onclick = () => this.openRecord(record);
  }

  toggleShelfEditing() {
    this.editingShelf = !this.editingShelf;
    el('btn-edit-shelf').textContent = this.editingShelf ? '完了' : '編集';
    this.renderShelf();
  }

  setGenre(genre) {
    this.genre = genre;
    for (const button of el('genre-tabs').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.genre === genre));
    }
    this.renderShelf();
  }

  async newFolder() {
    const name = prompt('フォルダ名');
    if (!name || !name.trim()) return;
    await this.library.addFolder(name.trim(), this.folderId);
    await this.renderShelf();
  }

  // -- one book's settings ---------------------------------------------------

  async showBookMenu(record) {
    this.menuRecord = record;
    el('book-menu-title').textContent = record.title || record.fileName;
    for (const button of el('book-genre').querySelectorAll('button')) {
      button.setAttribute('aria-pressed',
        String(button.dataset.genre === (record.genre || 'other')));
    }

    const folders = await this.library.folders();
    const list = el('folder-choices');
    list.replaceChildren();
    const choose = (id, label) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-current', String((record.folderId || null) === id));
      button.addEventListener('click', async () => {
        await this.library.update(record.id, { folderId: id });
        record.folderId = id;
        closeSheet('book-menu');
        await this.renderShelf();
        toast(id ? `「${label}」へ移動しました` : '本棚の直下へ移動しました');
      });
      li.appendChild(button);
      list.appendChild(li);
    };
    choose(null, '本棚の直下');
    for (const folder of folders) choose(folder.id, folder.name);

    openSheet('book-menu');
  }

  async setBookGenre(genre) {
    if (!this.menuRecord) return;
    await this.library.update(this.menuRecord.id, { genre });
    this.menuRecord.genre = genre;
    for (const button of el('book-genre').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.genre === genre));
    }
    await this.renderShelf();
    toast('ジャンルを変えました');
  }

  async moveFromMenu(delta) {
    if (!this.menuRecord) return;
    const record = this.menuRecord;
    const siblings = this.allBooks.filter((b) => (b.folderId || null) === (record.folderId || null)
      && (this.genre === 'all' || (b.genre || 'other') === this.genre));
    await this.moveBook(record, delta, siblings);
  }

  async removeRecord(record) {
    if (!confirm(`「${record.title || record.fileName}」を本棚から削除します。`)) return;
    if (this.record && this.record.id === record.id) {
      this.view.close();
      this.record = null;
      el('book-title').textContent = '';
      localStorage.removeItem(LAST_BOOK_KEY);
    }
    await this.library.remove(record.id);
    await this.renderShelf();
    toast('削除しました');
  }

  /* Importing is the one slow moment, so it reports progress: a hundred books
     picked at once is a perfectly reasonable thing to do from Dropbox. */
  async importFiles(fileList) {
    const files = Array.from(fileList || []);
    el('file-input').value = '';
    if (!files.length) return;

    let added = 0;
    const failed = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      busy(true, `取り込み中… ${i + 1}/${files.length}`);
      // Let the browser paint the counter before the next file blocks it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        if (!(await looksLikeEpub(file))) throw new Error('EPUB ではありません');
        const record = await this.describe(file);
        await this.library.add(file, record);
        added += 1;
      } catch (error) {
        failed.push(`${file.name}: ${error.message || error}`);
      }
    }
    busy(false);
    await this.renderShelf();

    if (failed.length) {
      toast(`${added} 冊を追加、${failed.length} 冊は失敗`);
      console.warn('取り込めなかったファイル:\n' + failed.join('\n'));
    } else {
      toast(`${added} 冊を追加しました`);
    }
  }

  /** Read just enough of a book to put it on the shelf. */
  async describe(file) {
    const book = await Epub.open(file, file.name);
    let cover = null;
    const href = book.coverHref && book.has(book.coverHref) ? book.coverHref : null;
    if (href) {
      cover = new Blob([await book.read(href)], { type: mimeFor(href) });
    } else {
      for (const item of book.spine.slice(0, 3)) {
        const images = await book.imagesIn(item.href);
        if (!images.length) continue;
        cover = new Blob([await book.read(images[0])], { type: mimeFor(images[0]) });
        break;
      }
    }
    return {
      title: book.metadata.title || file.name.replace(/\.epub$/i, ''),
      creator: book.metadata.creator || '',
      // A fixed-layout book is a picture book: manga, near enough to start
      // with. The genre is a shelf label, not a rendering decision, so a wrong
      // guess costs nothing and can be corrected from the book's own menu.
      genre: book.isFixedLayout ? 'manga' : 'novel',
      cover,
    };
  }

  /* -- opening ------------------------------------------------------------ */

  async openRecord(record) {
    busy(true, '本を開いています…');
    try {
      const file = await this.library.fileFor(record.id);
      if (!file) throw new Error('本のデータが見つかりません');
      const book = await Epub.open(file, record.fileName);
      const at = (await this.library.positionFor(record.id)) || {};
      this.record = record;
      await this.applySpreadForBook();
      await this.view.open(book, {
        spineIndex: at.spineIndex || 0,
        page: at.page || 0,
        ratio: typeof at.ratio === 'number' ? at.ratio : null,
      });
      localStorage.setItem(LAST_BOOK_KEY, record.id);
      el('book-title').textContent = book.metadata.title || record.fileName;
      this.buildContents(book);
      closeSheet('library');
      this.flashBars();
    } catch (error) {
      console.error(error);
      toast(`開けませんでした: ${error.message || error}`);
    } finally {
      busy(false);
    }
  }

  /* -- contents ------------------------------------------------------------ */

  buildContents(book) {
    const list = el('toc-list');
    list.replaceChildren();
    el('toc-empty').hidden = book.toc.length > 0;
    for (const entry of book.toc) {
      const li = document.createElement('li');
      li.className = `depth-${Math.min(2, entry.depth || 0)}`;
      li.dataset.href = entry.href;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = entry.label;
      button.addEventListener('click', async () => {
        closeSheet('contents');
        busy(true, '移動中…');
        try {
          await this.view.goToHref(entry.href, entry.fragment || '');
        } finally {
          busy(false);
        }
      });
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  showContents() {
    if (!this.view.book) { toast('本が開かれていません'); return; }
    this.markChapter(this.view.spineIndex);
    openSheet('contents');
    // Bring the current chapter into view without animating past everything.
    const current = el('toc-list').querySelector('[aria-current="true"]');
    if (current) current.scrollIntoView({ block: 'center' });
  }

  markChapter(spineIndex) {
    const book = this.view.book;
    if (!book) return;
    const href = book.spine[spineIndex] ? book.spine[spineIndex].href : '';
    for (const li of el('toc-list').children) {
      const hit = li.dataset.href === href;
      li.firstElementChild.setAttribute('aria-current', hit ? 'true' : 'false');
    }
  }

  /* -- position and progress ----------------------------------------------- */

  onPosition(state) {
    if (!this.view.book) {
      // The reader reports its state once while it is being set up, before
      // there is a book; showing "1/1" then is just noise.
      el('page-count').textContent = '';
      return;
    }
    const rtl = this.view.readsRightToLeft;
    const fraction = state.fraction;
    const seek = el('seek');
    const fill = seek.querySelector('.fill');
    const knob = seek.querySelector('.knob');
    const percent = Math.round(fraction * 100);

    // A right-bound book fills from the right, the way its pages turn.
    if (rtl) {
      fill.style.left = 'auto';
      fill.style.right = '0';
    } else {
      fill.style.right = 'auto';
      fill.style.left = '0';
    }
    fill.style.width = `${percent}%`;
    knob.style.left = `${rtl ? 100 - percent : percent}%`;
    seek.setAttribute('aria-valuenow', String(percent));

    const pages = Math.max(1, state.pages);
    el('page-count').textContent = state.fixed || state.isImagePair
      ? `${state.page + 1}/${pages}`
      : `${state.page + 1}/${pages}・${percent}%`;

    const canShift = this.view.spreadOnScreen;
    el('btn-shift-left').disabled = !canShift;
    el('btn-shift-right').disabled = !canShift;

    this.schedulePositionSave(state);
  }

  schedulePositionSave(state) {
    if (!this.record) return;
    const position = {
      spineIndex: state.spineIndex,
      page: state.page,
      // Where in the chapter, not which page: the page numbering changes with
      // the screen and the type size, the proportion does not.
      ratio: state.pages ? state.page / state.pages : 0,
      fraction: state.fraction,
    };
    this.position = position;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.library.savePosition(this.record.id, position).catch(() => {});
    }, 900);
  }

  savePositionNow() {
    if (!this.record || !this.position) return;
    clearTimeout(this.saveTimer);
    this.library.savePosition(this.record.id, this.position).catch(() => {});
  }

  bindSeek() {
    const seek = el('seek');
    let dragging = false;

    const fractionAt = (clientX) => {
      const rect = seek.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      return this.view.readsRightToLeft ? 1 - ratio : ratio;
    };

    const jump = async (clientX) => {
      if (!this.view.book) return;
      busy(true, '移動中…');
      try {
        await this.view.seekToFraction(fractionAt(clientX));
      } finally {
        busy(false);
      }
    };

    seek.addEventListener('pointerdown', (e) => {
      dragging = true;
      seek.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    // Only the release moves the book: re-paginating on every pointermove
    // would make the bar feel like it is fighting back.
    seek.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      jump(e.clientX);
    });
    seek.addEventListener('pointercancel', () => { dragging = false; });
  }

  /* -- page display -------------------------------------------------------- */

  /* Page display is remembered per genre, not for the app as a whole. Manga
     wants a spread and a novel usually does not, and on a tablet large enough
     for both the one setting was being pushed back and forth all day.

     An installation that predates this inherits whatever single mode it was
     using, so nothing changes underfoot. */
  normaliseSpreadModes() {
    const saved = this.settings.spreadByGenre;
    const modes = { novel: 'auto', manga: 'auto', other: 'auto' };
    for (const key of Object.keys(modes)) {
      if (saved && saved[key]) modes[key] = saved[key];
      else if (!saved && this.settings.spreadMode) modes[key] = this.settings.spreadMode;
    }
    this.settings.spreadByGenre = modes;
  }

  /** The genre whose page display is in force: the open book's, or 'other'. */
  get activeGenre() {
    return (this.record && this.record.genre) || 'other';
  }

  async setSpreadMode(mode) {
    this.settings.spreadMode = mode;
    this.settings.spreadByGenre[this.activeGenre] = mode;
    saveSettings(this.settings);
    this.syncSpreadButtons();
    await this.reader.configure(this.settings);
    await this.view.applySpreadMode();
    if (this.record) {
      const label = { novel: '小説', manga: '漫画', other: 'その他' }[this.activeGenre];
      toast(`${label}のページ表示として憶えました`);
    }
  }

  /** Put the open book's genre in charge of the page display. */
  async applySpreadForBook() {
    const wanted = this.settings.spreadByGenre[this.activeGenre] || 'auto';
    this.syncSpreadButtons(wanted);
    if (wanted === this.settings.spreadMode) return;
    this.settings.spreadMode = wanted;
    saveSettings(this.settings);
    await this.reader.configure(this.settings);
  }

  syncSpreadButtons(mode) {
    const wanted = mode || this.settings.spreadMode;
    for (const button of el('spread-modes').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === wanted));
    }
  }

  /* The arrows say which way the pages move on screen, not which way the story
     runs; in a right-bound book those are opposite. */
  shiftSpread(screenDirection) {
    if (!this.view.book) return;
    const forward = this.view.readsRightToLeft ? -1 : 1;
    this.view.shiftSpread(screenDirection * forward);
  }

  /* -- settings ------------------------------------------------------------ */

  buildSettingsForm() {
    const presets = el('bg-presets');
    for (const [colour, label] of BACKGROUND_PRESETS) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.style.background = colour;
      swatch.title = label;
      swatch.setAttribute('aria-label', label);
      swatch.addEventListener('click', () => this.change('backgroundColor', colour));
      presets.appendChild(swatch);
    }

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const input = el(`set-${key}`);
      if (!input) continue;
      const event = input.type === 'range' ? 'input' : 'change';
      input.addEventListener(event, () => {
        const value = input.type === 'range' ? Number(input.value) : input.value;
        this.change(key, value);
      });
    }

    el('btn-pick-bg').addEventListener('click', () => el('bg-input').click());
    el('bg-input').addEventListener('change', (e) => this.setBackgroundImage(e.target.files[0]));
    el('btn-clear-bg').addEventListener('click', () => this.setBackgroundImage(null));

    el('btn-diagnose').addEventListener('click', () => this.diagnose());
    el('btn-copy-diagnosis').addEventListener('click', () => {
      navigator.clipboard.writeText(el('diagnosis').textContent).then(
        () => toast('コピーしました'), () => toast('コピーできませんでした'));
    });

    el('version-note').textContent = `縦書きリーダー ${VERSION}`;
    this.syncSettingsForm();
    this.syncSpreadButtons();
  }

  syncSettingsForm() {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      const input = el(`set-${key}`);
      if (!input) continue;
      const value = this.settings[key];
      input.value = value === true ? 'on' : value === false ? '' : value;
      const readout = document.querySelector(`.value[data-for="set-${key}"]`);
      if (readout) readout.textContent = formatSetting(key, this.settings[key]);
    }
  }

  change(key, value) {
    this.settings[key] = value;
    saveSettings(this.settings);
    const readout = document.querySelector(`.value[data-for="set-${key}"]`);
    if (readout) readout.textContent = formatSetting(key, value);
    const input = el(`set-${key}`);
    if (input && input.value !== String(value)) input.value = value;

    this.applyPageColours();
    this.reader.configure(this.settings);
  }

  resetSettings() {
    const keepSpread = this.settings.spreadMode;
    const keepByGenre = this.settings.spreadByGenre;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, {
      spreadMode: keepSpread, spreadByGenre: keepByGenre,
    });
    saveSettings(this.settings);
    this.syncSettingsForm();
    this.applyPageColours();
    this.reader.configure(this.settings);
    toast('既定値に戻しました');
  }

  /* The page colour also has to reach the area behind the safe-area padding,
     which is outside the reader element. */
  applyPageColours() {
    const root = document.documentElement;
    root.style.setProperty('--page-bg', this.settings.backgroundColor);
    root.style.setProperty('--manga-bg', this.settings.mangaBackground);
  }

  async setBackgroundImage(file) {
    if (this.backgroundUrl) {
      URL.revokeObjectURL(this.backgroundUrl);
      this.backgroundUrl = null;
    }
    await this.library.setValue('background-image', file || null);
    this.showBackgroundImage(file || null);
    if (!file) toast('背景画像を外しました');
  }

  showBackgroundImage(blob) {
    const reader = el('reader');
    if (!blob) {
      reader.style.backgroundImage = '';
      el('bg-state').textContent = 'なし';
      return;
    }
    this.backgroundUrl = URL.createObjectURL(blob);
    reader.style.backgroundImage = `url("${this.backgroundUrl}")`;
    reader.style.backgroundSize = 'cover';
    reader.style.backgroundPosition = 'center';
    el('bg-state').textContent = 'あり';
  }

  /* What the reader thinks is going on, in one block of text that can be read
     off the phone. Guessing at a rendering fault from a description costs a
     round trip each time; this costs one. */
  diagnose() {
    const rd = this.reader;
    const lead = rd.frames[0];
    const doc = rd.paneDoc(lead);
    const book = this.view.book;
    const lines = [
      `版 ${VERSION}`,
      `画面 ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`,
      `visualViewport ${visualViewport ? Math.round(visualViewport.width) + 'x' + Math.round(visualViewport.height) : '-'}`,
      `stage ${rd.stage.clientWidth}x${rd.stage.clientHeight}`,
      `pane ${lead.clientWidth}x${lead.clientHeight} clip=${lead.style.clipPath || 'なし'}`,
      `ホーム画面から起動 ${navigator.standalone ? 'はい' : 'いいえ'}`,
      `mode=${rd.mode} vertical=${rd.vertical} spread=${rd.spread} loading=${rd.loading}`,
      `page ${rd.pageIndex + 1}/${rd.pageCount} extent=${Math.round(rd.contentExtent)} pageW=${Math.round(rd.pageW)}`,
      `pane文書 ${doc ? 'あり' : 'なし'}${doc && doc.body ? ' body=' + Math.round(doc.body.getBoundingClientRect().width) + 'px' : ''}`,
      `本 ${book ? book.metadata.title.slice(0, 30) : 'なし'}`,
      book ? `spine ${this.view.spineIndex + 1}/${book.spine.length} fixed=${book.isFixedLayout} rtl=${book.isRtl}` : '',
      `設定 size=${this.settings.fontSize} line=${this.settings.lineHeight} 余白=${this.settings.marginTop}/${this.settings.marginBottom}/${this.settings.marginLeft}/${this.settings.marginRight}`,
      `ページ送り ${this.settings.pageAnimation ? 'スライド' : '即時'} / 表示 ${this.settings.spreadMode}`,
      `ジャンル別表示 ${JSON.stringify(this.settings.spreadByGenre)} (いま ${this.activeGenre})`,
      `スワイプ 必要 ${Math.round(this.reader.swipeDistance)}px (${this.settings.swipeDepth})`,
      `影 追従 ${this.reader.turnTracks} 回 / 設定 ${this.settings.swipeHint || 'なし'}`,
      `影 ${this.hintState()}`,
      `SW ${navigator.serviceWorker && navigator.serviceWorker.controller ? '有効' : 'なし'}`,
    ].filter(Boolean);
    el('diagnosis').textContent = lines.join('\n');
    el('diagnosis').hidden = false;
    el('btn-copy-diagnosis').hidden = false;
  }

  /* What the hint actually computes to, asked of the browser rather than
     assumed. Drives it through one step of a swipe and reads the result. */
  hintState() {
    const hint = el('turn-hint');
    if (!hint) return '要素なし';
    const was = this.reader.settings.swipeHint;
    this.reader.settings.swipeHint = 'on';
    this.reader._trackTurn(this.reader.swipeDistance * 0.8);
    const style = getComputedStyle(hint);
    const box = hint.getBoundingClientRect();
    const out = `幅 ${Math.round(box.width)} 高 ${Math.round(box.height)}`
      + ` 不透明度 ${style.opacity} z ${style.zIndex}`
      + ` 表示 ${style.display}/${style.visibility}`;
    this.reader._clearTurn();
    this.reader.settings.swipeHint = was;
    return out;
  }

  async refreshStorageNote() {
    const estimate = await this.library.usage();
    el('storage-note').textContent = estimate
      ? `本棚が使っている容量 ${formatSize(estimate.usage || 0)}（この端末で使える上限の目安 ${formatSize(estimate.quota || 0)}）`
      : '';
  }
}

/* -- helpers --------------------------------------------------------------- */

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private browsing, nothing to be done */ }
}

function formatSetting(key, value) {
  if (key === 'letterSpacing' || key === 'textStroke') return `${Number(value).toFixed(2)}em`;
  if (key === 'lineHeight') return Number(value).toFixed(2);
  if (key === 'fontWeight') return String(value);
  if (typeof value === 'number') return `${value}px`;
  return '';
}

function formatSize(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/* The picker has no filter on it, so check the bytes. iOS also hands over
   files whose name has been mangled by the cloud provider, which is why the
   extension alone is not enough. */
async function looksLikeEpub(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b;   // "PK"
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} を読み込めません`);
  return response.text();
}

/* -- boot ------------------------------------------------------------------ */

async function boot() {
  try {
    // The ZIP reader is built on this; without it nothing can be opened, and
    // an explanation is more use than a stack trace. Safari gained it in 16.4.
    if (typeof DecompressionStream === 'undefined') {
      busy(true, 'この端末の Safari では動きません。iOS 16.4 以降が必要です。');
      return;
    }
    const [baseCss, library] = await Promise.all([
      fetchText('reader.css'),
      Library.open(),
    ]);
    const app = new App(library, baseCss);
    window.app = app;   // for the test harness and for poking at from Safari

    app.showBackgroundImage(await library.getValue('background-image'));
    await app.refreshStorageNote();

    // The shelf is the home screen; the book you were reading is one tap away
    // on the 「続きから」 card rather than something the app decides for you.
    await app.showLibrary();

    // Asking for persistence stops iOS reclaiming the shelf when storage runs
    // low. It is granted silently for an installed web app.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  } catch (error) {
    console.error(error);
    busy(true, `起動できませんでした: ${error.message || error}`);
  }
}

boot();
