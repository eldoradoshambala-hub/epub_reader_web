/* EPUB container parsing.
 *
 * A port of the desktop reader's epubfile.py, including everything it learned
 * from being run over a real 1,277-book library: books whose only statement of
 * writing direction is a class name, tables of contents that only parse once
 * you stop caring about tag case, chapters that are not well-formed XML, and
 * covers that point at a file nobody packed.
 *
 * Nothing is unpacked eagerly. Entries come out of the ZIP as they are asked
 * for, which matters on a phone where a manga volume can be tens of megabytes.
 */

'use strict';

import { ZipArchive } from './zip.js';

export const CONTAINER_PATH = 'META-INF/container.xml';
export const DOCUMENT_TYPES = new Set(['application/xhtml+xml', 'text/html']);

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const OPS_NS = 'http://www.idpf.org/2007/ops';

// Matches the modern property and both vendor-prefixed forms.
const VERTICAL_RE = /(?:-epub-|-webkit-)?writing-mode\s*:\s*vertical-(?:rl|lr)/i;

/* Japanese publishing toolchains mark the writing direction with a class on
   <html>: 'vrtl' for vertical right-to-left, 'hltr' for horizontal. Plenty of
   books carry only this and no writing-mode rule at all. */
const VERTICAL_CLASSES = new Set(['vrtl', 'vertical-rl', 'vertical', 'tate']);
const HORIZONTAL_CLASSES = new Set(['hltr', 'horizontal-tb', 'horizontal', 'yoko']);

const HEAD_BYTES = 4096;
const ROOT_TAG_RE = /<\s*(?:html|body)\b[^>]*>/gi;
const CLASS_ATTR_RE = /\bclass\s*=\s*(["'])(.*?)\1/is;

export class EpubError extends Error {}

// -- small helpers ---------------------------------------------------------

function dirname(path) {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function basename(path) {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

/** Resolve an href against a directory inside the ZIP. */
export function resolvePath(baseDir, href) {
  const cleaned = href.replace(/\\/g, '/');
  const parts = (baseDir && !cleaned.startsWith('/') ? `${baseDir}/${cleaned}` : cleaned).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function localName(el) {
  return (el.localName || el.tagName || '').toLowerCase();
}

function properties(value) {
  return new Set((value || '').split(/\s+/).filter(Boolean));
}

/* Parse markup that may or may not be well-formed XML.
   Returns {doc, wellFormed}. The flag decides how a chapter is later served:
   as XHTML, or handed to the forgiving HTML parser because one stray attribute
   would otherwise replace the whole chapter with an error page. */
function parseMarkup(text) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, 'application/xhtml+xml');
  if (!xml.querySelector('parsererror')) return { doc: xml, wellFormed: true };
  return { doc: parser.parseFromString(text, 'text/html'), wellFormed: false };
}

/* The epub:type of an element, whichever namespace the book declared.
   The specification says .../2007/ops, but real books also use .../2011/epub.
   Checking the declared namespaces rather than one fixed URI is what tells the
   real table of contents apart from the landmarks nav. */
function epubType(el) {
  for (const attr of el.attributes) {
    if (attr.name === 'epub:type') return attr.value;
    if (attr.localName === 'type' && (attr.namespaceURI || '').includes('idpf.org')) {
      return attr.value;
    }
  }
  return null;
}

function classDirection(head) {
  ROOT_TAG_RE.lastIndex = 0;
  let match;
  while ((match = ROOT_TAG_RE.exec(head)) !== null) {
    const found = CLASS_ATTR_RE.exec(match[0]);
    if (!found) continue;
    const names = found[2].toLowerCase().split(/\s+/).filter(Boolean);
    if (names.some((n) => VERTICAL_CLASSES.has(n))) return true;
    if (names.some((n) => HORIZONTAL_CLASSES.has(n))) return false;
  }
  return null;
}

// -- the book --------------------------------------------------------------

export class Epub {
  constructor(zip, name) {
    this.zip = zip;
    this.fileName = name || '';
    this.metadata = {
      title: '', creator: '', language: '',
      layout: 'reflowable', spread: 'auto', orientation: 'auto',
    };
    this.manifest = new Map();   // id -> {id, href, mediaType, properties}
    this.byHref = new Map();     // href -> manifest item
    this.spine = [];             // {idref, href, mediaType, linear, properties, spreadSide}
    this.toc = [];               // {label, href, fragment, depth}
    this.direction = 'ltr';
    this.opfDir = '';
    this.coverHref = null;

    this._vertical = null;
    this._perDocument = new Map();
    this._imageOnly = new Map();
    this._wellFormed = new Map();
  }

  static async open(source, name) {
    return Epub.fromArchive(await ZipArchive.open(source), name);
  }

  /* For a caller that has already opened the archive -- importing looks inside
     to decide whether a ZIP is a book or a pile of pictures, and reading the
     whole file twice to answer that is a real wait on a phone. */
  static async fromArchive(zip, name) {
    const book = new Epub(zip, name);
    await book._parse();
    return book;
  }

  get isFixedLayout() {
    return this.metadata.layout === 'pre-paginated';
  }

  get isRtl() {
    return this.direction === 'rtl';
  }

  indexOf(href) {
    return this.spine.findIndex((item) => item.href === href);
  }

  /* Whether a fixed-layout page refuses to be paired into a spread. Always
     false for an EPUB: a book that cares says so with the OPF's page-spread
     properties. A picture book has no OPF, so it answers by looking at the
     shape of the page instead. */
  standsAlone() {
    return false;
  }

  read(href) {
    return this.zip.read(href);
  }

  readText(href) {
    return this.zip.readText(href);
  }

  has(href) {
    return this.zip.has(href);
  }

  // -- parsing ------------------------------------------------------------

  async _parse() {
    let containerXml;
    try {
      containerXml = await this.zip.readText(CONTAINER_PATH);
    } catch {
      throw new EpubError('META-INF/container.xml がありません（EPUB ではありません）');
    }

    const container = new DOMParser().parseFromString(containerXml, 'application/xml');
    const rootfile = Array.from(container.getElementsByTagName('*'))
      .find((el) => localName(el) === 'rootfile' && el.getAttribute('full-path'));
    if (!rootfile) throw new EpubError('container.xml に rootfile がありません');

    const opfPath = rootfile.getAttribute('full-path').replace(/\\/g, '/').replace(/^\/+/, '');
    this.opfDir = dirname(opfPath);

    let packageDoc;
    try {
      packageDoc = new DOMParser().parseFromString(await this.zip.readText(opfPath), 'application/xml');
    } catch (err) {
      throw new EpubError(`OPF を読めません: ${err.message}`);
    }
    if (packageDoc.querySelector('parsererror')) {
      throw new EpubError('OPF が XML として壊れています');
    }

    const props = this._parseMetadata(packageDoc);
    this._parseManifest(packageDoc);
    this._parseSpine(packageDoc);
    await this._parseToc(packageDoc);
    this._findCover(props);

    if (!this.metadata.title) {
      this.metadata.title = this.fileName.replace(/\.epub$/i, '') || '(無題)';
    }
  }

  _parseMetadata(packageDoc) {
    const props = new Map();
    for (const node of packageDoc.getElementsByTagName('*')) {
      const name = localName(node);
      const text = (node.textContent || '').trim();
      if (name === 'title' && !this.metadata.title) this.metadata.title = text;
      else if (name === 'creator' && !this.metadata.creator) this.metadata.creator = text;
      else if (name === 'language' && !this.metadata.language) this.metadata.language = text;
      else if (name === 'meta') {
        const property = node.getAttribute('property');
        if (property) props.set(property.trim(), text);
        const legacy = node.getAttribute('name');   // EPUB 2 style
        if (legacy && !props.has(legacy.trim())) {
          props.set(legacy.trim(), (node.getAttribute('content') || '').trim());
        }
      }
    }
    this.metadata.layout = props.get('rendition:layout') || 'reflowable';
    this.metadata.spread = props.get('rendition:spread') || 'auto';
    this.metadata.orientation = props.get('rendition:orientation') || 'auto';
    return props;
  }

  _parseManifest(packageDoc) {
    for (const node of packageDoc.getElementsByTagName('*')) {
      if (localName(node) !== 'item') continue;
      const id = node.getAttribute('id');
      const href = node.getAttribute('href');
      if (!id || !href) continue;
      const item = {
        id,
        href: resolvePath(this.opfDir, decodeURIComponent(href)),
        mediaType: (node.getAttribute('media-type') || '').trim(),
        properties: properties(node.getAttribute('properties')),
      };
      this.manifest.set(id, item);
      this.byHref.set(item.href, item);
    }
  }

  _parseSpine(packageDoc) {
    const spineEl = Array.from(packageDoc.getElementsByTagName('*'))
      .find((el) => localName(el) === 'spine');
    if (!spineEl) throw new EpubError('OPF に spine がありません');

    const direction = (spineEl.getAttribute('page-progression-direction') || 'ltr').toLowerCase();
    this.direction = (direction === 'rtl') ? 'rtl' : 'ltr';
    this.ncxId = spineEl.getAttribute('toc');

    for (const node of spineEl.children) {
      if (localName(node) !== 'itemref') continue;
      const item = this.manifest.get(node.getAttribute('idref') || '');
      if (!item) continue;
      const props = properties(node.getAttribute('properties'));
      let spreadSide = null;
      if (props.has('page-spread-left')) spreadSide = 'left';
      else if (props.has('page-spread-right')) spreadSide = 'right';
      else if (props.has('rendition:page-spread-center')) spreadSide = 'center';
      this.spine.push({
        idref: item.id,
        href: item.href,
        mediaType: item.mediaType,
        linear: (node.getAttribute('linear') || 'yes').toLowerCase() !== 'no',
        properties: props,
        spreadSide,
      });
    }
    if (!this.spine.length) throw new EpubError('spine が空です（表示するものがありません）');
  }

  async _parseToc(packageDoc) {
    for (const item of this.manifest.values()) {
      if (item.properties.has('nav')) {
        this.toc = await this._parseNav(item.href);
        if (this.toc.length) return;
      }
    }
    if (this.ncxId && this.manifest.has(this.ncxId)) {
      this.toc = await this._parseNcx(this.manifest.get(this.ncxId).href);
      if (this.toc.length) return;
    }
    for (const item of this.manifest.values()) {
      if (item.mediaType === 'application/x-dtbncx+xml') {
        this.toc = await this._parseNcx(item.href);
        if (this.toc.length) return;
      }
    }
  }

  async _parseNav(href) {
    let text;
    try {
      text = await this.zip.readText(href);
    } catch {
      return [];
    }
    const { doc } = parseMarkup(text);
    const base = dirname(href);

    const navs = Array.from(doc.getElementsByTagName('*')).filter((el) => localName(el) === 'nav');
    let nav = navs.find((el) => epubType(el) === 'toc');
    if (!nav) nav = navs[0];   // landmarks nav, but better than nothing
    if (!nav) return [];

    const entries = [];
    const walk = (list, depth) => {
      for (const li of list.children) {
        if (localName(li) !== 'li') continue;
        const anchor = Array.from(li.getElementsByTagName('*'))
          .find((el) => ['a', 'span'].includes(localName(el)));
        let childList = null;
        for (const child of li.children) {
          if (localName(child) === 'ol') { childList = child; break; }
        }
        if (anchor) {
          const target = anchor.getAttribute('href') || '';
          const label = (anchor.textContent || '').trim();
          if (target && label) {
            const [path, fragment = ''] = target.split('#');
            entries.push({
              label,
              href: resolvePath(base, decodeURIComponent(path)),
              fragment,
              depth,
            });
          }
        }
        if (childList) walk(childList, depth + 1);
      }
    };
    for (const child of nav.children) {
      if (localName(child) === 'ol') walk(child, 0);
    }
    return entries;
  }

  /* EPUB 2 tables of contents.

     Matched case-insensitively and navMap is searched for at any depth: an
     unescaped '<' in a book title makes the NCX invalid XML, it falls through
     to the HTML parser, and that lowercases every name and wraps the lot in
     <html><body>. Matching 'navPoint' exactly against a child of the root
     silently produced an empty contents list for those books. */
  async _parseNcx(href) {
    let text;
    try {
      text = await this.zip.readText(href);
    } catch {
      return [];
    }
    const { doc } = parseMarkup(text);
    const base = dirname(href);
    const entries = [];

    const walk = (parent, depth) => {
      for (const navPoint of parent.children) {
        if (localName(navPoint) !== 'navpoint') continue;
        let label = '';
        let target = '';
        for (const child of navPoint.children) {
          const name = localName(child);
          if (name === 'navlabel') label = (child.textContent || '').trim();
          else if (name === 'content') target = child.getAttribute('src') || '';
        }
        if (label && target) {
          const [path, fragment = ''] = target.split('#');
          entries.push({
            label,
            href: resolvePath(base, decodeURIComponent(path)),
            fragment,
            depth,
          });
        }
        walk(navPoint, depth + 1);
      }
    };

    const navMap = Array.from(doc.getElementsByTagName('*'))
      .find((el) => localName(el) === 'navmap');
    if (navMap) walk(navMap, 0);
    return entries;
  }

  _findCover(props) {
    for (const item of this.manifest.values()) {
      if (item.properties.has('cover-image')) { this.coverHref = item.href; return; }
    }
    const coverId = props.get('cover');
    if (coverId && this.manifest.has(coverId)) {
      this.coverHref = this.manifest.get(coverId).href;
    }
  }

  // -- writing direction ---------------------------------------------------

  async _head(href, size = HEAD_BYTES) {
    try {
      return await this.zip.readHead(href, size);
    } catch {
      return '';
    }
  }

  /** The book's overall writing direction. */
  async looksVertical() {
    if (this._vertical === null) this._vertical = await this._decideVertical();
    return this._vertical;
  }

  /** Direction for one document, falling back to the book's default.
      Front matter such as a copyright notice is often set horizontally in an
      otherwise vertical book, and it carries its own class. */
  async documentVertical(href) {
    if (this._perDocument.has(href)) return this._perDocument.get(href);
    const own = classDirection(await this._head(href));
    const result = (own === null) ? await this.looksVertical() : own;
    this._perDocument.set(href, result);
    return result;
  }

  async _decideVertical() {
    // Weighted by document size, not counted per file: a novel can open with
    // a dozen tiny horizontal image pages before the first real chapter.
    let vertical = 0;
    let horizontal = 0;
    for (const item of this.spine) {
      if (!DOCUMENT_TYPES.has(item.mediaType)) continue;
      const declared = classDirection(await this._head(item.href));
      if (declared === null) continue;
      const weight = Math.max(1, this.zip.sizeOf(item.href));
      if (declared) vertical += weight; else horizontal += weight;
    }
    if (vertical || horizontal) return vertical > horizontal;

    for (const item of this.manifest.values()) {
      if (item.mediaType !== 'text/css') continue;
      let css;
      try { css = await this.zip.readText(item.href); } catch { continue; }
      if (VERTICAL_RE.test(css)) return true;
    }

    for (const item of this.spine.slice(0, 4)) {
      if (!DOCUMENT_TYPES.has(item.mediaType)) continue;
      if (VERTICAL_RE.test(await this._head(item.href, HEAD_BYTES * 4))) return true;
    }

    // Nothing declares anything, which happens with rough conversions.
    // Japanese prose is set vertically unless someone says otherwise.
    return this._looksJapanese();
  }

  async _looksJapanese() {
    if ((this.metadata.language || '').toLowerCase().startsWith('ja')) return true;
    // dc:language is unreliable in converted files -- 'en' on a book that is
    // Japanese throughout is common -- so count kana and kanji instead.
    let found = 0;
    for (const item of this.spine.slice(0, 6)) {
      if (!DOCUMENT_TYPES.has(item.mediaType)) continue;
      const text = await this._head(item.href, HEAD_BYTES * 4);
      for (const char of text) {
        const code = char.codePointAt(0);
        if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x4e00 && code <= 0x9fff)) {
          if (++found >= 200) return true;
        }
      }
    }
    return false;
  }

  // -- documents -----------------------------------------------------------

  /** Whether a chapter parses as XML, deciding how it should be served. */
  async isWellFormed(href) {
    if (this._wellFormed.has(href)) return this._wellFormed.get(href);
    let ok = true;
    try {
      const doc = new DOMParser().parseFromString(await this.zip.readText(href), 'application/xhtml+xml');
      ok = !doc.querySelector('parsererror');
    } catch {
      ok = false;
    }
    this._wellFormed.set(href, ok);
    return ok;
  }

  /** Every image a spine document references, in document order. */
  async imagesIn(href) {
    let text;
    try {
      text = await this.zip.readText(href);
    } catch {
      return [];
    }
    const { doc } = parseMarkup(text);
    const base = dirname(href);
    const found = [];
    for (const el of doc.getElementsByTagName('*')) {
      const name = localName(el);
      let src = null;
      if (name === 'img') src = el.getAttribute('src');
      else if (name === 'image') src = el.getAttributeNS(XLINK_NS, 'href') || el.getAttribute('href');
      else continue;
      if (!src || /^(data|https?):/i.test(src)) continue;
      const resolved = resolvePath(base, decodeURIComponent(src.split('#')[0]));
      if (resolved && !found.includes(resolved)) found.push(resolved);
    }
    return found;
  }

  /** Whether a spine item is a single full-page picture and nothing else.
      Novels carry their colour plates as ordinary reflowable spine items,
      often tagged page-spread-right/left just like a manga. */
  async isImagePage(index) {
    if (this._imageOnly.has(index)) return this._imageOnly.get(index);
    const item = this.spine[index];
    let result = false;
    if (item && DOCUMENT_TYPES.has(item.mediaType) && this.zip.sizeOf(item.href) < 8192) {
      const images = await this.imagesIn(item.href);
      if (images.length === 1) {
        const text = await this.zip.readText(item.href);
        result = text.replace(/<[^>]*>/g, '').trim().length < 40;
      }
    }
    this._imageOnly.set(index, result);
    return result;
  }

  /** Byte size of each spine item, so progress can reflect text read rather
      than chapter count. */
  weights() {
    const sizes = this.spine.map((item) => Math.max(1, this.zip.sizeOf(item.href)));
    const before = [];
    let running = 0;
    for (const size of sizes) { before.push(running); running += size; }
    return { sizes, before, total: Math.max(1, running) };
  }
}

export { basename, dirname };
