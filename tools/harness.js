/* Automated checks for the web reader, run from a browser console.
 *
 *   const h = await import('/tools/harness.js');
 *   await h.importFolder();          // pulls every book from /books/
 *   await h.sweep();                 // paginates a sample and checks the ink
 *
 * The point of checkChapter is that it does not trust the paginator: it reads
 * the clip window the pane is actually wearing, measures the lines itself, and
 * reports any line that straddles the edge of that window. A check written in
 * terms of the paginator's own merge logic would agree with it by definition.
 */

'use strict';

import { Epub, resolvePath } from '/js/epub.js';

const EPSILON = 1.5;   // px: sub-pixel rounding is not a cut line

export function checkChapter() {
  const rd = window.app.reader;
  const frame = rd.frames[0];
  const doc = rd.paneDoc(frame);
  if (!doc || !doc.body) return { pages: 0, cut: 0, strayRuby: 0, lines: 0, samples: [] };

  // Measure once with the page offset removed; re-measuring per page turns the
  // sweep quadratic and tells you nothing extra.
  const saved = doc.body.style.transform;
  doc.body.style.transition = 'none';
  doc.body.style.transform = 'translateX(0px)';
  void doc.body.offsetWidth;

  const rects = [];
  const samples = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 0.5 || rect.height < 0.5) continue;
      rects.push([rect.left, rect.right, node.nodeValue.trim().slice(0, 10)]);
    }
  }

  // A ruby can sit wholly inside a page and still be on the wrong one: the
  // annotation left at the end of the page before its base. Nothing above is
  // cut, so it has to be asked for separately.
  let strayRuby = 0;
  if (rd.vertical) {
    const origin = doc.body.getBoundingClientRect().right;
    const middle = (nodes) => {
      range.setStartBefore(nodes[0]);
      range.setEndAfter(nodes[nodes.length - 1]);
      const box = range.getBoundingClientRect();
      return origin - (box.left + box.right) / 2;
    };
    for (const rt of doc.querySelectorAll('ruby > rt')) {
      const base = [];
      for (let n = rt.previousSibling; n && n.localName !== 'rt'; n = n.previousSibling) {
        base.unshift(n);
      }
      if (!base.length) continue;
      if (rd.pageForDistance(middle(base)) !== rd.pageForDistance(middle([rt]))) {
        strayRuby += 1;
        if (samples.length < 3) samples.push({ strayRuby: rt.parentNode.textContent });
      }
    }
  }
  doc.body.style.transform = saved;
  void doc.body.offsetWidth;
  doc.body.style.transition = '';

  const width = frame.clientWidth;
  let cut = 0;
  for (let page = 0; page < rd.pageCount; page++) {
    const start = rd.pageOffsets[page] || 0;
    const end = page + 1 < rd.pageOffsets.length
      ? rd.pageOffsets[page + 1]
      : Math.max(rd.contentExtent, start);
    const slack = rd.pageW - Math.max(0, Math.min(rd.pageW, end - start));
    const inset = slack < 0.5 ? 0 : Math.round(slack * 100) / 100;
    const left = (rd.vertical ? inset : 0) - start;
    const right = (rd.vertical ? width : width - inset) - start;
    let bad = 0;
    for (const [l, r, text] of rects) {
      const inside = l >= left - EPSILON && r <= right + EPSILON;
      const outside = r <= left + EPSILON || l >= right - EPSILON;
      if (!inside && !outside) {
        bad += 1;
        if (samples.length < 3) {
          samples.push({ page, l: +l.toFixed(1), r: +r.toFixed(1),
                         window: [+left.toFixed(1), +right.toFixed(1)], text });
        }
      }
    }
    if (bad) cut += 1;
  }
  return { pages: rd.pageCount, cut, strayRuby, lines: rects.length, samples };
}

/** Every internal link in the book, resolved the way the reader resolves it. */
export async function checkLinks(book) {
  let total = 0;
  const broken = [];
  for (const item of book.spine) {
    let text;
    try { text = await book.readText(item.href); } catch { continue; }
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const base = item.href.replace(/[^/]*$/, '');
    for (const anchor of doc.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href') || '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;   // http:, kindle:, ...
      const hash = href.indexOf('#');
      const path = hash < 0 ? href : href.slice(0, hash);
      const fragment = hash < 0 ? '' : href.slice(hash + 1);
      total += 1;
      if (!path) {
        if (fragment && !doc.getElementById(fragment)) {
          broken.push({ from: item.href, href, why: 'anchor' });
        }
        continue;
      }
      let target;
      try { target = resolvePath(base, decodeURIComponent(path)); }
      catch { target = resolvePath(base, path); }
      if (book.indexOf(target) < 0 && !book.byHref.has(target)) {
        broken.push({ from: item.href, href, target, why: 'missing' });
      }
    }
  }
  return { total, broken };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sweepBook(recordId, samples = 6) {
  const app = window.app;
  const record = (await app.library.list()).find((r) => r.id === recordId);
  const file = await app.library.fileFor(recordId);
  const book = await Epub.open(file, record.fileName);
  const links = await checkLinks(book);

  await app.openRecord(record);
  await wait(400);

  const view = app.view;
  const count = view.book.spine.length;
  const step = Math.max(1, Math.floor(count / samples));
  let pages = 0, cut = 0, strayRuby = 0, chapters = 0, images = 0;
  const cutSamples = [];
  for (let i = 0; i < count; i += step) {
    await view.showSpine(i);
    await wait(350);
    if (app.reader.mode === 'fixed') { images += 1; continue; }
    const result = checkChapter();
    chapters += 1;
    pages += result.pages;
    cut += result.cut;
    strayRuby += result.strayRuby;
    if (result.samples.length && cutSamples.length < 3) {
      cutSamples.push(Object.assign({ spine: i }, result.samples[0]));
    }
  }
  return {
    title: record.title, spine: count, chapters, pages, cut, strayRuby, images,
    links: links.total, broken: links.broken.length,
    brokenSample: links.broken.slice(0, 3),
    toc: view.book.toc.length, fixed: view.book.isFixedLayout,
    cutSamples,
  };
}

/** Import every EPUB the test server publishes at /books/. */
export async function importFolder(prefix = '/books/') {
  const listing = await (await fetch(prefix)).text();
  const names = Array.from(listing.matchAll(/href="([^"]+\.epub)"/g))
    .map((m) => decodeURIComponent(m[1]));
  const files = [];
  for (const name of names) {
    const blob = await (await fetch(prefix + encodeURIComponent(name))).blob();
    files.push(new File([blob], name, { type: 'application/epub+zip' }));
  }
  await window.app.importFiles(files);
  return names.length;
}

export async function sweep(from = 0, to = 99, samples = 6) {
  const books = await window.app.library.list();
  const results = [];
  for (const record of books.slice(from, to)) {
    results.push(await sweepBook(record.id, samples));
  }
  return results;
}

export function summarise(results) {
  const sum = (key) => results.reduce((total, r) => total + r[key], 0);
  return {
    books: results.length,
    chapters: sum('chapters'),
    pages: sum('pages'),
    cut: sum('cut'),
    strayRuby: sum('strayRuby'),
    links: sum('links'),
    broken: sum('broken'),
    noToc: results.filter((r) => !r.toc && !r.fixed).length,
  };
}
