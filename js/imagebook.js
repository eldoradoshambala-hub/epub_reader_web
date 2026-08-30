/* A ZIP of pictures, or a handful of picked pictures, read as a book.
 *
 * The reader already knows how to show one or two pictures side by side, pair
 * them into spreads, seek through them and remember where you were: that is
 * the fixed-layout path, and it is driven entirely by the book object BookView
 * is handed. So a pile of JPEGs is wrapped in something that answers the same
 * questions an `Epub` does, and nothing downstream has to know the difference.
 * It is the port of the desktop reader's imagebook.py.
 *
 * Two ways in, matching how pictures actually arrive on a phone:
 *
 *   * a ZIP (or .cbz) picked from Files -- Dropbox, Synology Drive, iCloud --
 *     read in place, exactly as an EPUB is;
 *   * several pictures picked at once, which is what iOS offers instead of
 *     "a folder": the selection is one volume.
 *
 * Page order is the one thing a picture book has instead of a spine, so it is
 * taken seriously: names sort the way a person reads them (2 before 10), and
 * archive entries written by Japanese Windows tools are decoded out of CP932
 * rather than left as mojibake.
 */

'use strict';

import { ZipArchive } from './zip.js';

export const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif',
  'png', 'gif', 'webp', 'avif', 'bmp', 'dib', 'ico', 'svg',
  'tif', 'tiff', 'jxl', 'heic', 'heif', 'jp2',
]);

export const ARCHIVE_EXTENSIONS = new Set(['zip', 'cbz']);

// Named so a refusal can say what it is rather than "unsupported file".
export const FOREIGN_ARCHIVES = {
  rar: 'RAR', cbr: 'RAR', '7z': '7-Zip', cb7: '7-Zip',
  lzh: 'LZH', lha: 'LZH', tar: 'TAR', cbt: 'TAR',
};

const SKIP_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store', 'picasa.ini']);
const SKIP_DIRS = ['__macosx/', '.git/', '.thumbnails/'];

/* A page wider than it is tall is already a two-page spread that was scanned
   in one piece, so it must not be paired with a neighbour. 1.05 rather than
   1.0: a page trimmed slightly square is still a single page. */
const WIDE_RATIO = 1.05;

/* How much of a file is read to find its pixel dimensions. Everything but
   JPEG puts them in the first few dozen bytes; JPEG hides them behind however
   much EXIF the scanner wrote, and 64 KiB covers an embedded thumbnail. */
const PROBE_BYTES = 65536;

/* Above this many pages the dimension probe is skipped and pages are paired by
   position. Opening should stay quick on a phone. */
const MAX_PROBE_PAGES = 1200;

/* The contents list is a page list here. Past this it stops being a list
   anyone reads and starts being a few seconds of building rows. */
const MAX_TOC_ENTRIES = 2000;

export class ImageBookError extends Error {}

// -- names and order --------------------------------------------------------

export function extensionOf(name) {
  const at = (name || '').lastIndexOf('.');
  return at < 0 ? '' : name.slice(at + 1).toLowerCase();
}

export function isImageName(name) {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isArchiveName(name) {
  return ARCHIVE_EXTENSIONS.has(extensionOf(name));
}

function isSkipped(path) {
  const lower = path.toLowerCase();
  if (SKIP_NAMES.has(lower.split('/').pop())) return true;
  if (lower.startsWith('.') || lower.includes('/.')) return true;
  return SKIP_DIRS.some((prefix) => lower.startsWith(prefix));
}

/* Sort key that reads numbers as numbers, so 2 comes before 10. Every element
   is the same shape because a plain mix of numbers and text cannot be compared
   once two names differ in whether the same position holds digits -- which is
   exactly what a folder holding both `p1.jpg` and `cover.jpg` does. */
export function naturalKey(text) {
  const parts = String(text).toLowerCase().split(/(\d+)/).filter(Boolean);
  return parts.map((part) => (/^\d+$/.test(part)
    ? [0, Number(part), '']
    : [1, 0, part]));
}

function compareKeys(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    const left = a[i];
    const right = b[i];
    for (let j = 0; j < 3; j++) {
      if (left[j] < right[j]) return -1;
      if (left[j] > right[j]) return 1;
    }
  }
  return a.length - b.length;
}

/* Order a whole path one component at a time. Comparing the joined string
   would sort `ch2/001.jpg` before `ch10/001.jpg` correctly but put
   `ch2/index.jpg` before `ch2/001.jpg` only by accident. */
export function comparePaths(a, b) {
  const left = a.split('/').filter(Boolean);
  const right = b.split('/').filter(Boolean);
  const limit = Math.min(left.length, right.length);
  for (let i = 0; i < limit; i++) {
    const verdict = compareKeys(naturalKey(left[i]), naturalKey(right[i]));
    if (verdict) return verdict;
  }
  return left.length - right.length;
}

// -- pixel dimensions -------------------------------------------------------

function jpegSize(view, length) {
  let at = 2;
  while (at + 9 < length) {
    if (view.getUint8(at) !== 0xff) { at += 1; continue; }
    const marker = view.getUint8(at + 1);
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const segment = view.getUint16(at + 2);
    // SOF0..SOF15, minus the marker numbers that are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.getUint16(at + 5);
      const width = view.getUint16(at + 7);
      return (width && height) ? [width, height] : null;
    }
    if (segment < 2) return null;
    at += 2 + segment;
  }
  return null;
}

function webpSize(bytes, view) {
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return [width, height];
  }
  if (chunk === 'VP8 ' && bytes.length >= 30
      && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = view.getUint32(21, true);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  return null;
}

/* [width, height] read out of an image header, or null.

   Deliberately header-only: the reason for asking is to decide whether a page
   is a scanned double spread, and decoding a few hundred full-size pictures to
   answer that would make opening an archive take longer than reading it -- on
   a phone, considerably longer. */
export function parseSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR') {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return [view.getUint16(6, true), view.getUint16(8, true)];
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    const width = Math.abs(view.getInt32(18, true));
    const height = Math.abs(view.getInt32(22, true));
    return (width && height) ? [width, height] : null;
  }
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
      && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    return webpSize(bytes, view);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(view, bytes.length);
  }
  return null;
}

// -- the book ---------------------------------------------------------------

/* Short ASCII addresses stand in for the entries. The real name goes nowhere
   near the address: archive entries carry names in whatever encoding the tool
   that wrote them felt like, and a page's address has to survive being handed
   round as a key. The real name is kept beside it, for the page list. */
function hrefFor(index, displayName) {
  const extension = extensionOf(displayName) || 'jpg';
  return `page/${String(index).padStart(5, '0')}.${extension}`;
}

const MEDIA_BY_EXTENSION = {
  png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif', jp2: 'image/jp2', jxl: 'image/jxl',
};

function mediaTypeOf(name) {
  return MEDIA_BY_EXTENSION[extensionOf(name)] || 'image/jpeg';
}

export class ImageBook {
  constructor(name, sourceKind) {
    this.fileName = name || '';
    this.sourceKind = sourceKind;            // 'archive' | 'files'
    this.metadata = {
      title: '', creator: '', language: 'ja',
      layout: 'pre-paginated', spread: 'auto', orientation: 'auto',
    };
    this.manifest = new Map();
    this.byHref = new Map();
    this.spine = [];
    this.toc = [];
    this.direction = 'rtl';   // Japanese manga is right-bound; the bar flips it
    this.opfDir = '';
    this.coverHref = null;

    this.labels = [];         // display name per spine item
    this.sizes = [];          // [width, height] per spine item, [0,0] unknown
    this.wideAlone = true;    // a landscape page is a scanned spread already

    this._sources = new Map();  // href -> {zipName} | {file}
    this._archive = null;
  }

  // -- opening -------------------------------------------------------------

  /** A ZIP of pictures, or an array of picked picture files. */
  static async open(source, name, options = {}) {
    const many = Array.isArray(source)
      || (source && typeof source.length === 'number' && typeof source.slice === 'function'
          && typeof source.arrayBuffer !== 'function');
    return many
      ? ImageBook.openFiles(Array.from(source), name, options)
      : ImageBook.openArchive(source, name, options);
  }

  /* `source` may be an archive that is already open: importing looks inside a
     ZIP to decide whether it is a book or a pile of pictures, and reading the
     whole file a second time to build the book is a real wait on a phone. */
  static async openArchive(source, name, { rtl = true, wideAlone = true } = {}) {
    const zip = (source && typeof source.names === 'function')
      ? source
      : await ZipArchive.open(source);
    const found = [];
    for (const entry of zip.names()) {
      const path = entry.replace(/\\/g, '/');
      if (path.endsWith('/') || isSkipped(path) || !isImageName(path)) continue;
      found.push([path, entry]);
    }
    if (!found.length) {
      throw new ImageBookError('画像が入っていません');
    }
    found.sort((a, b) => comparePaths(a[0], b[0]));

    const book = new ImageBook(name, 'archive');
    book._archive = zip;
    book.direction = rtl ? 'rtl' : 'ltr';
    book.wideAlone = wideAlone;
    book._build(found.map(([path, entry]) => [path, { zipName: entry }]));
    book.metadata.title = (name || '').replace(/\.(zip|cbz)$/i, '') || '(無題)';
    await book._probeSizes();
    return book;
  }

  static async openFiles(files, name, { rtl = true, wideAlone = true } = {}) {
    const found = [];
    for (const file of files) {
      const path = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/');
      if (!path || isSkipped(path) || !isImageName(path)) continue;
      found.push([path, { file }]);
    }
    if (!found.length) {
      throw new ImageBookError('画像がありません');
    }
    found.sort((a, b) => comparePaths(a[0], b[0]));

    const book = new ImageBook(name, 'files');
    book.direction = rtl ? 'rtl' : 'ltr';
    book.wideAlone = wideAlone;
    book._build(found);
    book.metadata.title = name || '(無題)';
    await book._probeSizes();
    return book;
  }

  _build(entries) {
    entries.forEach(([display, source], index) => {
      const href = hrefFor(index, display);
      const id = `p${String(index).padStart(5, '0')}`;
      const item = {
        id,
        href,
        mediaType: mediaTypeOf(display),
        properties: new Set(),
      };
      this.manifest.set(id, item);
      this.byHref.set(href, item);
      this.spine.push({
        idref: id,
        href,
        mediaType: item.mediaType,
        linear: true,
        properties: item.properties,
        // No hints of any kind: the pairing convention decides, the same way
        // it does for a manga EPUB that declares nothing.
        spreadSide: null,
      });
      this.labels.push(display);
      this.sizes.push([0, 0]);
      this._sources.set(href, source);
    });
    this.coverHref = this.spine.length ? this.spine[0].href : null;
    this.metadata.creator = `${this.spine.length} 枚`;
    this.toc = this._buildToc();
  }

  /* A page list, grouped by folder when the archive has folders: an archive
     split into chapter folders gets a two-level list, a flat one stays flat
     rather than growing a pointless single root. */
  _buildToc() {
    if (this.spine.length > MAX_TOC_ENTRIES) return [];
    const nested = this.labels.some((label) => label.includes('/'));
    const entries = [];
    let currentDir = null;
    this.labels.forEach((label, index) => {
      const at = label.lastIndexOf('/');
      const directory = at < 0 ? '' : label.slice(0, at);
      const base = at < 0 ? label : label.slice(at + 1);
      const href = this.spine[index].href;
      if (nested && directory !== currentDir) {
        currentDir = directory;
        entries.push({ label: directory || '（直下）', href, fragment: '', depth: 0 });
      }
      entries.push({ label: base, href, fragment: '', depth: nested ? 1 : 0 });
    });
    return entries;
  }

  async _probeSizes() {
    if (this.spine.length > MAX_PROBE_PAGES) return;
    for (let index = 0; index < this.spine.length; index++) {
      let head = null;
      try {
        head = await this._head(this.spine[index].href, PROBE_BYTES);
      } catch {
        head = null;
      }
      const size = head ? parseSize(head) : null;
      if (size) this.sizes[index] = size;
    }
  }

  async _head(href, limit) {
    const source = this._sources.get(href);
    if (!source) return null;
    if (source.file) {
      return new Uint8Array(await source.file.slice(0, limit).arrayBuffer());
    }
    // A stored entry -- which is what a JPEG in an archive almost always is --
    // is a view into bytes already in memory, so this costs nothing.
    const data = await this._archive.read(source.zipName);
    return data.subarray(0, limit);
  }

  // -- what the reader asks -------------------------------------------------

  get isFixedLayout() { return true; }

  get isRtl() { return this.direction === 'rtl'; }

  /** A shim so code written for an archive-backed book keeps working. */
  get zip() {
    if (this._archive) return this._archive;
    const book = this;
    return {
      names: () => Array.from(book._sources.keys()),
      has: (href) => book._sources.has(href),
      sizeOf: (href) => {
        const source = book._sources.get(href);
        return source && source.file ? source.file.size : 0;
      },
      read: (href) => book.read(href),
    };
  }

  has(href) {
    return this._sources.has(href);
  }

  indexOf(href) {
    return this.spine.findIndex((item) => item.href === href);
  }

  async read(href) {
    const source = this._sources.get(href);
    if (!source) throw new ImageBookError(`ページがありません: ${href}`);
    if (source.file) return new Uint8Array(await source.file.arrayBuffer());
    return this._archive.read(source.zipName);
  }

  async readText(href) {
    return new TextDecoder('utf-8').decode(await this.read(href));
  }

  async imagesIn(href) {
    return this.has(href) ? [href] : [];
  }

  async looksVertical() { return false; }

  async documentVertical() { return false; }

  async isImagePage() { return true; }

  async isWellFormed() { return true; }

  /** A page wider than it is tall is a spread already; leave it alone. */
  standsAlone(index) {
    if (!this.wideAlone) return false;
    const size = this.sizes[index];
    if (!size) return false;
    const [width, height] = size;
    return !!(width && height) && width > height * WIDE_RATIO;
  }

  weights() {
    const sizes = this.spine.map((item) => Math.max(1, this.zip.sizeOf(item.href)));
    const before = [];
    let running = 0;
    for (const size of sizes) { before.push(running); running += size; }
    return { sizes, before, total: Math.max(1, running) };
  }

  labelOf(index) {
    return this.labels[index] || '';
  }
}
