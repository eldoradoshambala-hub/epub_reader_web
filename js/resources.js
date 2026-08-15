/* Turning a chapter inside the ZIP into something an iframe can load.
 *
 * The desktop reader registered an `epub://` scheme with Chromium and answered
 * requests straight from the archive. A browser has no such hook, and the
 * obvious replacement -- a Service Worker -- is the wrong tool here: on iOS a
 * worker attached to a standalone web app gets terminated freely, and a reader
 * that stops being able to fetch its own pictures halfway through a chapter is
 * worse than one that takes a moment longer to open one.
 *
 * So each chapter is rewritten instead: references are resolved against the
 * ZIP and replaced with blob URLs, and the document itself becomes a blob.
 * A blob document inherits this page's origin, which is what keeps the iframe
 * same-origin so the reader can still inject styles into it and measure the
 * text it laid out.
 */

'use strict';

import { resolvePath, dirname, DOCUMENT_TYPES } from './epub.js';

const MIME_BY_EXTENSION = {
  xhtml: 'application/xhtml+xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ncx: 'application/x-dtbncx+xml',
  xml: 'application/xml',
  txt: 'text/plain',
};

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;

export function mimeFor(path) {
  const ext = path.split('.').pop().toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

/** Holds every blob URL made for one chapter so they can all be released. */
export class ResourceScope {
  constructor(book) {
    this.book = book;
    this.urls = new Map();   // zip path -> blob URL
    this.cssDepth = 0;
  }

  revoke() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  /* Find an entry, tolerating the loose referencing real books use: an extra
     directory level, a leading "./", or a percent-encoded name. Falls back to
     matching on file name alone, which is what the desktop reader did. */
  _find(path) {
    if (this.book.has(path)) return path;
    const decoded = (() => {
      try { return decodeURIComponent(path); } catch { return path; }
    })();
    if (decoded !== path && this.book.has(decoded)) return decoded;

    const wanted = decoded.split('/').pop();
    for (const name of this.book.zip.names()) {
      if (name.split('/').pop() === wanted) return name;
    }
    return null;
  }

  async urlFor(path) {
    const found = this._find(path);
    if (!found) return null;
    if (this.urls.has(found)) return this.urls.get(found);

    let data = await this.book.read(found);
    let mime = mimeFor(found);

    // Stylesheets reference fonts and images of their own, and those have to
    // be rewritten before the sheet is any use.
    if (mime === 'text/css') {
      data = new TextEncoder().encode(await this._rewriteCss(await this.book.readText(found), found));
    }

    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    this.urls.set(found, url);
    return url;
  }

  async _rewriteCss(text, cssPath) {
    if (this.cssDepth > 4) return text;   // @import loops are not our problem
    this.cssDepth += 1;
    const base = dirname(cssPath);
    try {
      const replace = async (match, quote, target) => {
        if (!target || /^(data|https?|blob):/i.test(target)) return match;
        const url = await this.urlFor(resolvePath(base, target.split('#')[0]));
        if (!url) return match;
        return match.startsWith('@import')
          ? `@import ${quote}${url}${quote}`
          : `url(${quote}${url}${quote})`;
      };
      text = await replaceAsync(text, CSS_IMPORT_RE, replace);
      text = await replaceAsync(text, CSS_URL_RE, replace);
      return text;
    } finally {
      this.cssDepth -= 1;
    }
  }

  /* Build a loadable document for one spine item.

     Chapters that are not well-formed XML are re-serialised as HTML: strict
     XML parsing turns one duplicated attribute into a parser-error page
     instead of a chapter, and books really do ship those. */
  async documentUrl(href) {
    const text = await this.book.readText(href);
    const wellFormed = await this.book.isWellFormed(href);
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      text, wellFormed ? 'application/xhtml+xml' : 'text/html'
    );
    const base = dirname(href);

    await this._rewriteElements(doc, base);

    const serialised = new XMLSerializer().serializeToString(doc);
    const mime = wellFormed ? 'application/xhtml+xml' : 'text/html';
    const url = URL.createObjectURL(new Blob([serialised], { type: mime }));
    this.urls.set(`__doc__:${href}`, url);
    return url;
  }

  async _rewriteElements(doc, base) {
    const jobs = [];

    const swap = (el, attr, ns) => {
      const raw = ns ? el.getAttributeNS(ns, attr) : el.getAttribute(attr);
      if (!raw || /^(data|https?|blob|#):/i.test(raw) || raw.startsWith('#')) return;
      const [path, fragment] = raw.split('#');
      if (!path) return;
      jobs.push((async () => {
        const url = await this.urlFor(resolvePath(base, decodeURIComponent(path)));
        if (!url) return;
        const value = fragment ? `${url}#${fragment}` : url;
        if (ns) el.setAttributeNS(ns, attr, value);
        else el.setAttribute(attr, value);
      })());
    };

    for (const el of doc.getElementsByTagName('*')) {
      const name = (el.localName || el.tagName || '').toLowerCase();
      if (name === 'img' || name === 'source' || name === 'video' || name === 'audio') {
        swap(el, 'src');
      } else if (name === 'image') {
        if (el.getAttributeNS(XLINK_NS, 'href')) swap(el, 'href', XLINK_NS);
        else swap(el, 'href');
      } else if (name === 'link') {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (rel.includes('stylesheet')) swap(el, 'href');
      } else if (name === 'script') {
        // Book scripts are dropped: they cannot do anything useful here and
        // an inline one can rewrite the layout out from under the paginator.
        el.parentNode?.removeChild(el);
      }
    }
    await Promise.all(jobs);
  }
}

async function replaceAsync(text, pattern, replacer) {
  const jobs = [];
  text.replace(pattern, (...args) => {
    jobs.push(replacer(...args));
    return '';
  });
  if (!jobs.length) return text;
  const values = await Promise.all(jobs);
  let index = 0;
  return text.replace(pattern, () => values[index++]);
}
