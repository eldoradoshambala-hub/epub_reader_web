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
  sheet.hidden = false;
  sheet.classList.add('away');
  requestAnimationFrame(() => sheet.classList.remove('away'));
}

function closeSheet(id) {
  const sheet = el(id);
  sheet.classList.add('away');
  // Only take it out of the layout if it is still on its way out: opening the
  // same sheet again during the slide would otherwise be undone by this timer.
  setTimeout(() => {
    if (sheet.classList.contains('away')) sheet.hidden = true;
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
    this.record = null;         // shelf entry of the open book
    this.editingShelf = false;
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

  async renderShelf() {
    const books = await this.library.list();
    const shelf = el('shelf');
    for (const url of this.coverUrls) URL.revokeObjectURL(url);
    this.coverUrls = [];
    shelf.replaceChildren();
    el('shelf-empty').hidden = books.length > 0;

    for (const record of books) {
      const card = document.createElement('div');
      card.className = 'book';

      const open = document.createElement('button');
      open.className = 'cover';
      if (record.cover) {
        const url = URL.createObjectURL(record.cover);
        this.coverUrls.push(url);
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

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = record.title || record.fileName;

      const meta = document.createElement('div');
      meta.className = 'meta';
      const parts = [];
      if (record.creator) parts.push(record.creator);
      if (record.position && record.position.fraction > 0.005) {
        parts.push(`${Math.round(record.position.fraction * 100)}%`);
      }
      meta.textContent = parts.join(' ・ ') || formatSize(record.size);

      card.append(open, name, meta);

      if (this.editingShelf) {
        const remove = document.createElement('button');
        remove.className = 'remove';
        remove.textContent = '削除';
        remove.addEventListener('click', () => this.removeRecord(record));
        card.appendChild(remove);
      }
      shelf.appendChild(card);
    }
  }

  toggleShelfEditing() {
    this.editingShelf = !this.editingShelf;
    el('btn-edit-shelf').textContent = this.editingShelf ? '完了' : '編集';
    this.renderShelf();
  }

  async removeRecord(record) {
    if (!confirm(`「${record.title || record.fileName}」を本棚から削除します。`)) return;
    if (this.record && this.record.id === record.id) {
      this.view.close();
      this.record = null;
      el('book-title').textContent = '';
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
      fixed: book.isFixedLayout,
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
      const at = record.position || {};
      await this.view.open(book, {
        spineIndex: at.spineIndex || 0,
        page: at.page || 0,
        ratio: typeof at.ratio === 'number' ? at.ratio : null,
      });
      this.record = record;
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
    this.record.position = position;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.library.savePosition(this.record.id, position).catch(() => {});
    }, 900);
  }

  savePositionNow() {
    if (!this.record || !this.record.position) return;
    clearTimeout(this.saveTimer);
    this.library.savePosition(this.record.id, this.record.position).catch(() => {});
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

  async setSpreadMode(mode) {
    this.settings.spreadMode = mode;
    saveSettings(this.settings);
    this.syncSpreadButtons();
    await this.reader.configure(this.settings);
    await this.view.applySpreadMode();
  }

  syncSpreadButtons() {
    for (const button of el('spread-modes').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === this.settings.spreadMode));
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, { spreadMode: keepSpread });
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
      `SW ${navigator.serviceWorker && navigator.serviceWorker.controller ? '有効' : 'なし'}`,
    ].filter(Boolean);
    el('diagnosis').textContent = lines.join('\n');
    el('diagnosis').hidden = false;
    el('btn-copy-diagnosis').hidden = false;
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

    const books = await library.list();
    const lastId = localStorage.getItem(LAST_BOOK_KEY);
    const last = books.find((record) => record.id === lastId);
    if (last) await app.openRecord(last);
    else await app.showLibrary();

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
