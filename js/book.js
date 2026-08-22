/* What to show, and where we are in the book.
 *
 * The Reader knows how to lay a document out and how many pages that becomes.
 * This decides which document that should be: walking the spine, pairing the
 * colour plates a novel marks as a double-page illustration, and keeping the
 * progress figure honest. It is the port of the desktop reader's viewer.py.
 */

'use strict';

import { DOCUMENT_TYPES } from './epub.js';
import { ResourceScope } from './resources.js';

export class BookView {
  constructor(reader, options = {}) {
    this.reader = reader;
    this.book = null;
    this.scope = null;

    this.spineIndex = 0;
    this.page = 0;
    this.pages = 1;
    this.spread = false;
    this.pair = null;         // two illustration pages shown together
    this.pairOffset = null;   // null = the book's own pairing, else 0/1
    this.views = [];             // fixed layout: groups of spine indices
    this.viewToken = 0;          // which page turn owns the screen
    this.viewIndex = 0;
    this.offSpine = null;
    this.weights = { sizes: [], before: [], total: 1 };

    this.onPosition = options.onPosition || (() => {});
    this.onChapter = options.onChapter || (() => {});
    this.onMessage = options.onMessage || (() => {});

    reader.onEdge = (which) => this._onEdge(which);
    reader.onLink = (href, absolute) => this._onLink(href, absolute);
    reader.onPageChanged = (state) => this._onPageChanged(state);
  }

  // -- opening -------------------------------------------------------------

  /* ratio wins over page when both are given: how far into the chapter you
     were survives a rotation or a change of type size, where a page number
     does not -- the chapter is simply a different number of pages long. */
  async open(book, { spineIndex = 0, page = 0, ratio = null } = {}) {
    this.close();
    this.book = book;
    this.scope = new ResourceScope(book);
    this.weights = book.weights();
    this.views = book.isFixedLayout ? await this._buildViews() : [];
    this.pairOffset = null;
    await this.showSpine(
      Math.max(0, Math.min(spineIndex, book.spine.length - 1)), { page, ratio }
    );
  }

  close() {
    if (this.scope) this.scope.revoke();
    this.scope = null;
    this.book = null;
    this.pair = null;
    this.offSpine = null;
    this.views = [];
    this.viewIndex = 0;
    this.spineIndex = 0;
  }

  get spreadEnabled() {
    const mode = this.reader.settings.spreadMode || 'auto';
    if (mode === 'single') return false;
    if (mode === 'double') return true;
    const stage = this.reader.stage;
    return stage.clientWidth >= stage.clientHeight && stage.clientWidth >= 700;
  }

  get readsRightToLeft() {
    if (!this.book) return false;
    return this.book.isRtl || (!this.book.isFixedLayout && this.book._vertical !== false);
  }

  get spreadOnScreen() {
    if (!this.book) return false;
    if (this.book.isFixedLayout) {
      return !!this.views.length && this.views[this.viewIndex].length > 1;
    }
    return this.pair !== null || this.spread;
  }

  // -- illustration spreads -------------------------------------------------

  /* The (right, left) spine pair an illustration belongs to, if any.
     Only pairs pages the book itself marked with page-spread properties;
     guessing from adjacency would happily glue a cover to a frontispiece. */
  async _spreadPartner(index) {
    const book = this.book;
    if (!book || book.isFixedLayout || !this.spreadEnabled) return null;
    if (!(await book.isImagePage(index))) return null;
    const lead = book.isRtl ? 'right' : 'left';
    const side = book.spine[index].spreadSide;
    if (side === 'center' || side === null) return null;
    if (side === lead && index + 1 < book.spine.length) {
      const next = book.spine[index + 1].spreadSide;
      if (next && next !== lead && next !== 'center' && await book.isImagePage(index + 1)) {
        return [index, index + 1];
      }
    }
    if (side !== lead && index > 0) {
      if (book.spine[index - 1].spreadSide === lead && await book.isImagePage(index - 1)) {
        return [index - 1, index];
      }
    }
    return null;
  }

  async _showImagePair(pair) {
    const urls = [];
    for (const index of pair) {
      const images = await this.book.imagesIn(this.book.spine[index].href);
      if (!images.length) return false;
      const url = await this.scope.urlFor(images[0]);
      if (!url) return false;
      urls.push(url);
    }
    this.pair = pair;
    this.offSpine = null;
    this.spineIndex = pair[0];
    await this.reader.showFixed(urls, {
      rtl: this.book.isRtl,
      fit: this.reader.settings.mangaFit,
    });
    this.page = 0;
    this.pages = 1;
    this.spread = true;
    this.onChapter(this.spineIndex);
    this._emitPosition();
    return true;
  }

  /* Read ahead. Turning a page is the one moment a reader notices a delay, so
     the pictures either side of this one are fetched and decoded now, while
     nothing is waiting on them. */
  async _warmNeighbours() {
    const wanted = [this.viewIndex + 1, this.viewIndex - 1, this.viewIndex + 2];
    const urls = [];
    for (const at of wanted) {
      const group = this.views[at];
      if (!group) continue;
      for (const index of group) {
        const item = this.book.spine[index];
        if (!item) continue;
        try {
          const images = await this.book.imagesIn(item.href);
          if (!images.length) continue;
          const url = await this.scope.urlFor(images[0]);
          if (url) urls.push(url);
        } catch {
          // A page that will not load is the page turn's problem, not ours.
        }
      }
    }
    this.reader.prefetchImages(urls);
  }

  // -- fixed layout grouping -----------------------------------------------

  _parityViews(offset) {
    const count = this.book.spine.length;
    const views = [];
    let index = 0;
    if (offset && count) { views.push([0]); index = 1; }
    while (index < count) {
      if (index + 1 < count) { views.push([index, index + 1]); index += 2; }
      else { views.push([index]); index += 1; }
    }
    return views;
  }

  async _buildViews() {
    const spine = this.book.spine;
    const count = spine.length;
    if (!this.spreadEnabled) return spine.map((_, i) => [i]);
    if (this.pairOffset !== null) return this._parityViews(this.pairOffset);

    const lead = this.book.isRtl ? 'right' : 'left';
    const hasSides = spine.some((item) => item.spreadSide);
    const views = [];
    let index = 0;
    if (!hasSides && count > 1) {
      // No hints at all: the near-universal convention is a lone cover
      // followed by spreads.
      views.push([0]);
      index = 1;
    }
    while (index < count) {
      const side = spine[index].spreadSide;
      if (side === 'center') { views.push([index]); index += 1; continue; }
      if (index + 1 < count) {
        const next = spine[index + 1].spreadSide;
        const pairs = (side === lead && next && next !== lead && next !== 'center')
                   || (side === null && next === null);
        if (pairs) { views.push([index, index + 1]); index += 2; continue; }
      }
      views.push([index]);
      index += 1;
    }
    return views;
  }

  _viewContaining(spineIndex) {
    const at = this.views.findIndex((group) => group.includes(spineIndex));
    return at < 0 ? 0 : at;
  }

  async _showView(viewIndex) {
    if (!this.views.length) return;
    // Waiting for a picture to decode means two quick taps can be in flight at
    // once; the later one owns the screen.
    const token = ++this.viewToken;
    this.viewIndex = Math.max(0, Math.min(viewIndex, this.views.length - 1));
    const group = this.views[this.viewIndex];
    this.spineIndex = group[0];
    this.pair = null;

    const urls = [];
    for (const index of group) {
      const images = await this.book.imagesIn(this.book.spine[index].href);
      if (!images.length) { urls.length = 0; break; }
      const url = await this.scope.urlFor(images[0]);
      if (!url) { urls.length = 0; break; }
      urls.push(url);
    }

    if (urls.length) {
      await this.reader.showFixed(urls, {
        rtl: this.book.isRtl,
        fit: this.reader.settings.mangaFit,
      });
      if (token !== this.viewToken) return;
      this._warmNeighbours();
    } else {
      // A fixed-layout page that is markup rather than a single image; fall
      // back to rendering it like a normal chapter.
      const item = this.book.spine[group[0]];
      if (DOCUMENT_TYPES.has(item.mediaType)) {
        await this.reader.load({
          url: await this.scope.documentUrl(item.href),
          rtl: this.book.isRtl,
          bookVertical: false,
        });
      }
    }
    if (token !== this.viewToken) return;
    this.page = this.viewIndex;
    this.pages = this.views.length;
    this.spread = group.length > 1;
    this.onChapter(this.spineIndex);
    this._emitPosition();
  }

  // -- navigation -----------------------------------------------------------

  async showSpine(index, { page = 0, fragment = '', ratio = null } = {}) {
    const book = this.book;
    if (!book) return;
    index = Math.max(0, Math.min(index, book.spine.length - 1));

    if (book.isFixedLayout) {
      await this._showView(this._viewContaining(index));
      return;
    }

    const pair = await this._spreadPartner(index);
    if (pair && await this._showImagePair(pair)) return;

    this.pair = null;
    this.offSpine = null;
    this.spineIndex = index;
    const item = book.spine[index];
    this.onChapter(index);
    await this.reader.load({
      url: await this.scope.documentUrl(item.href),
      rtl: book.isRtl,
      // Per document, not per book: a copyright notice set horizontally
      // inside an otherwise vertical novel should stay horizontal.
      bookVertical: await book.documentVertical(item.href),
      page,
      fragment,
      ratio,
    });
  }

  async goToHref(href, fragment = '') {
    const book = this.book;
    if (!book) return;
    const index = book.indexOf(href);
    if (index >= 0) { await this.showSpine(index, { fragment }); return; }

    // Some books list a page in the contents that the spine leaves out -- a
    // cover, typically. It is real content sitting in the archive, so show it
    // rather than refusing.
    const item = book.byHref.get(href);
    if (item && DOCUMENT_TYPES.has(item.mediaType)) {
      this.offSpine = href;
      this.pair = null;
      await this.reader.load({
        url: await this.scope.documentUrl(href),
        rtl: book.isRtl,
        bookVertical: await book.documentVertical(href),
        fragment,
      });
      return;
    }
    this.onMessage('リンク先が見つかりません');
  }

  async shiftSpread(delta) {
    const book = this.book;
    if (!book) return;
    if (book.isFixedLayout) {
      if (!this.views.length) return;
      const first = this.views[this.viewIndex][0];
      const target = Math.max(0, Math.min(first + delta, book.spine.length - 1));
      if (target === first) return;
      this.pairOffset = target % 2;
      this.views = await this._buildViews();
      await this._showView(this._viewContaining(target));
      return;
    }
    if (this.pair) {
      const first = this.pair[0] + delta;
      if (first >= 0 && first + 1 < book.spine.length
          && await book.isImagePage(first) && await book.isImagePage(first + 1)) {
        await this._showImagePair([first, first + 1]);
      } else {
        await this.showSpine(Math.max(0, first));
      }
      return;
    }
    this.reader.shiftPage(delta);
  }

  /** Re-render for a changed page-display choice, immediately. Pushing the
      setting to the reader covers running text, but the picture paths are
      grouped here, so they have to be regrouped here too. */
  async applySpreadMode() {
    const book = this.book;
    if (!book) return;
    this.pairOffset = null;
    if (book.isFixedLayout) {
      const current = this.spineIndex;
      this.views = await this._buildViews();
      await this._showView(this._viewContaining(current));
      return;
    }
    if (this.pair) await this.showSpine(this.pair[0]);
    else if (await book.isImagePage(this.spineIndex)) await this.showSpine(this.spineIndex);
  }

  async _onEdge(which) {
    const book = this.book;
    if (!book) return;
    const forward = which === 'next';

    if (this.pair) {
      const [first, last] = this.pair;
      if (forward) {
        if (last + 1 < book.spine.length) await this.showSpine(last + 1);
        else this.onMessage('最後のページです');
      } else if (first > 0) {
        await this.showSpine(first - 1, { page: 'last' });
      } else {
        this.onMessage('最初のページです');
      }
      return;
    }
    if (this.offSpine !== null) {
      if (forward) await this.showSpine(0);
      else this.onMessage('最初のページです');
      return;
    }
    if (book.isFixedLayout) {
      const next = this.viewIndex + (forward ? 1 : -1);
      if (next >= 0 && next < this.views.length) await this._showView(next);
      else this.onMessage(forward ? '最後のページです' : '最初のページです');
      return;
    }
    if (forward) {
      if (this.spineIndex + 1 < book.spine.length) await this.showSpine(this.spineIndex + 1);
      else this.onMessage('最後のページです');
    } else if (this.spineIndex > 0) {
      // Land on the last page of the previous chapter, not its first.
      await this.showSpine(this.spineIndex - 1, { page: 'last' });
    } else {
      this.onMessage('最初のページです');
    }
  }

  async _onLink(href, absolute) {
    const book = this.book;
    if (!book) return;
    if (/^(https?|mailto):/i.test(href)) {
      this.onMessage('外部リンクは開きません');
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('blob:')) {
      // kindle:embed: and friends, left behind by conversions.
      this.onMessage('この本のリンクは開けません');
      return;
    }
    // The href was rewritten to a blob URL when the chapter was prepared, so
    // resolve against the chapter's own path instead of the document base.
    const current = this.book.spine[this.spineIndex];
    const base = current ? current.href.replace(/[^/]*$/, '') : '';
    const [path, fragment = ''] = href.split('#');
    if (!path) {
      // Same-document anchor: jump within the chapter.
      const doc = this.reader.paneDoc(this.reader.frames[0]);
      const target = doc && doc.getElementById(fragment);
      if (target) this.reader.goToPage(this.reader.pageOfElement(doc, target));
      return;
    }
    const { resolvePath } = await import('./epub.js');
    await this.goToHref(resolvePath(base, decodeURIComponent(path)), fragment);
  }

  _onPageChanged(state) {
    if (this.book && this.book.isFixedLayout) return;   // numbering is ours
    if (this.pair !== null) return;
    this.page = state.page;
    this.pages = state.pages;
    this.spread = state.spread;
    this._emitPosition();
  }

  _emitPosition() {
    this.onPosition({
      page: this.page,
      pages: this.pages,
      spread: this.spread,
      spineIndex: this.spineIndex,
      spineCount: this.book ? this.book.spine.length : 0,
      isImagePair: this.pair !== null,
      fixed: !!(this.book && this.book.isFixedLayout),
      fraction: this.progressFraction(),
    });
  }

  // -- progress -------------------------------------------------------------

  /** How far through the book we are, from 0 to 1. Weighted by document size:
      counting chapters would make a two-page afterword look as long as a
      forty-page chapter. */
  progressFraction() {
    const book = this.book;
    if (!book) return 0;
    if (book.isFixedLayout) {
      return this.views.length ? (this.viewIndex + 0.5) / this.views.length : 0;
    }
    const { sizes, before, total } = this.weights;
    if (!sizes.length) return 0;
    const index = Math.max(0, Math.min(this.spineIndex, sizes.length - 1));
    const within = this.pages ? this.page / this.pages : 0;
    return Math.max(0, Math.min(1, (before[index] + within * sizes[index]) / total));
  }

  async seekToFraction(fraction) {
    const book = this.book;
    if (!book) return;
    fraction = Math.max(0, Math.min(1, fraction));
    if (book.isFixedLayout) {
      if (!this.views.length) return;
      await this._showView(Math.round(fraction * (this.views.length - 1)));
      return;
    }
    const { sizes, before, total } = this.weights;
    if (!sizes.length) return;
    const target = fraction * total;
    let index = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] <= target) index = i; else break;
    }
    const within = (target - before[index]) / Math.max(1, sizes[index]);
    await this.showSpine(index, { ratio: within });
  }
}
