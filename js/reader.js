/* The reading surface: layout, pagination and page turning.
 *
 * A port of the desktop reader's shell. The logic is the part that took the
 * longest to get right, so it is carried over rather than rewritten: page
 * breaks land on measured line boundaries, overlapping rectangles are fused so
 * a ruby annotation cannot be mistaken for the end of a line, and each pane is
 * clipped to the page it actually holds. What changed is the plumbing --
 * callbacks instead of a Qt channel, and touches instead of a mouse.
 */

'use strict';

export const DEFAULT_SETTINGS = {
  fontFamily: '',            // empty = the platform's own serif
  fontSize: 19,
  fontWeight: 400,
  textStroke: 0,
  lineHeight: 1.9,
  letterSpacing: 0,
  marginTop: 28, marginRight: 26, marginBottom: 28, marginLeft: 26,
  writingMode: 'auto',       // auto | vertical | horizontal
  spreadMode: 'auto',        // auto | single | double
  spreadGap: 32,
  backgroundColor: '#f3ede1',
  textColor: '#1a1a1a',
  mangaFit: 'contain',
  mangaBackground: '#1c1c1c',
  pageAnimation: false,      // sliding page turns; off by default on a phone
  swipeDepth: 'normal',      // how far a swipe goes before the page turns
};

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

// Chapters with more text nodes than this fall back to the coarse grid, to
// keep one enormous single-file chapter from stalling the interface.
const MAX_TEXT_NODES = 30000;

const TAP_SLOP = 12;            // px of movement still counted as a tap

/* How far the finger travels before a swipe turns the page, as a share of the
   screen's width.

   A fixed number of pixels was the wrong measure: 45px is a twitch, and the
   page turned before the gesture felt like it had begun. A sheet of paper
   bends under the finger and goes over somewhere past the middle of the
   movement, so the distance is taken from the screen and the middle setting
   sits near a third of it -- about where the hand expects the paper to give. */
const SWIPE_SHARES = { shallow: 0.16, normal: 0.32, deep: 0.5 };
const SWIPE_MIN = 44;           // never ask for less than a deliberate flick
const SWIPE_MAX = 300;          // nor for a sweep across a tablet

/* Resolves when a picture can be painted -- or after a moment, whatever
   happened. A corrupt image rejects decode(), and waiting on it for ever would
   wedge the page turn that asked for it. */
function decoded(img) {
  const ready = img.decode
    ? img.decode().catch(() => {})
    : new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
  return Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
}

export class Reader {
  constructor(root, options = {}) {
    this.root = root;
    this.stage = root.querySelector('.stage');
    this.frames = [
      root.querySelector('.pane-lead'),
      root.querySelector('.pane-facing'),
    ];
    this.fixedLayer = root.querySelector('.fixed-layer');

    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.baseCss = options.baseCss || '';

    this.onPageChanged = options.onPageChanged || (() => {});
    this.onEdge = options.onEdge || (() => {});
    this.onLink = options.onLink || (() => {});
    this.onTapMiddle = options.onTapMiddle || (() => {});

    this.mode = 'reflow';
    this.vertical = true;
    this.rtl = true;
    this.bookVertical = true;
    this.spread = false;

    this.pageCount = 1;
    this.pageIndex = 0;
    this.pageParity = 0;
    this.pageOffsets = [0];
    this.contentExtent = 0;
    this.pageW = 0;
    this.pageH = 0;
    this.advance = 0;

    this.fixedToken = 0;
    this.warmed = new Map();   // recently decoded pictures, kept alive
    this.lastTouchAt = 0;
    this.lastStageW = 0;
    this.lastStageH = 0;

    this.currentUrl = '';
    this.loadToken = 0;
    this.loading = false;
    this.pending = null;

    this._bindShellEvents();
  }

  // -- helpers ------------------------------------------------------------

  /** True while the synthetic click that follows a tap is still to come. */
  afterTouch() {
    return Date.now() - this.lastTouchAt < 900;
  }

  paneDoc(el) {
    try {
      return el.contentDocument;
    } catch {
      return null;
    }
  }

  panes() {
    return this.spread && !this.frames[1].hidden ? this.frames : [this.frames[0]];
  }

  get step() {
    return this.spread ? 2 : 1;
  }

  /* Round a page down to the start of a spread. pageParity is what lets the
     reader nudge a spread by a single page: with it set, spreads pair 1-2, 3-4
     instead of 0-1, 2-3, which is how you fix a book whose cover throws the
     pairing out by one. */
  snap(index) {
    if (this.step === 1) return Math.max(0, index);
    const offset = Math.max(0, index - this.pageParity);
    return this.pageParity + Math.floor(offset / this.step) * this.step;
  }

  fontStack() {
    const stack = [];
    if (this.settings.fontFamily) {
      stack.push(`"${String(this.settings.fontFamily).replace(/"/g, '')}"`);
    }
    // Hiragino is what iOS actually has, and it is a fine vertical face.
    stack.push('"Hiragino Mincho ProN"', '"YuMincho"', '"Noto Serif JP"', 'serif');
    return stack.join(', ');
  }

  buildVars() {
    const size = Number(this.settings.fontSize) || 19;
    const advance = Math.max(1, Math.round(size * (Number(this.settings.lineHeight) || 1.9)));
    const weight = Number(this.settings.fontWeight) || 400;
    this.advance = advance;
    return ':root{'
      + `--rd-font-size:${size}px;`
      + `--rd-advance:${advance}px;`
      + `--rd-heading-advance:${advance * 2}px;`
      + `--rd-font-family:${this.fontStack()};`
      + `--rd-font-weight:${weight};`
      + `--rd-bold-weight:${Math.min(900, weight + 300)};`
      + `--rd-heading-weight:${Math.min(900, weight + 200)};`
      + `--rd-color:${this.settings.textColor};`
      + `--rd-stroke:${Number(this.settings.textStroke) || 0}px;`
      + `--rd-letter-spacing:${Number(this.settings.letterSpacing) || 0}em;`
      + `--rd-page-w:${Math.round(this.pageW)}px;`
      + `--rd-page-h:${Math.round(this.pageH)}px;`
      + '}';
  }

  // -- geometry -----------------------------------------------------------

  decideSpread() {
    if (this.mode === 'fixed') return false;
    const wanted = this.settings.spreadMode || 'auto';
    if (wanted === 'single') return false;
    if (wanted === 'double') return true;
    // Landscape on a phone is narrow but wide; require real width too, or a
    // spread ends up with columns too short to read.
    return this.stage.clientWidth >= this.stage.clientHeight
        && this.stage.clientWidth >= 700;
  }

  decideVertical() {
    if (this.settings.writingMode === 'vertical') return true;
    if (this.settings.writingMode === 'horizontal') return false;
    return !!this.bookVertical;
  }

  computeGeometry() {
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    const { marginLeft: ml, marginRight: mr, marginTop: mt, marginBottom: mb } = this.settings;

    const availW = Math.max(60, width - ml - mr);
    const availH = Math.max(60, height - mt - mb);
    this.advance = Math.max(1, Math.round(
      (Number(this.settings.fontSize) || 19) * (Number(this.settings.lineHeight) || 1.9)
    ));

    const gap = this.spread ? Math.max(0, Math.min(200, this.settings.spreadGap || 0)) : 0;
    // The page fills exactly the area the margins leave. Nothing needs
    // rounding to a line grid: breaks land on measured line boundaries.
    this.pageW = this.spread ? Math.max(40, (availW - gap) / 2) : availW;
    this.pageH = availH;

    const leftX = ml;
    const rightX = ml + this.pageW + gap;
    // Vertical Japanese reads right to left, so the earlier page of a spread
    // belongs on the right; horizontal text is the other way round.
    const leadOnRight = this.spread && this.vertical;
    this._place(this.frames[0], leadOnRight ? rightX : leftX, mt);
    if (this.spread) this._place(this.frames[1], leadOnRight ? leftX : rightX, mt);
  }

  _place(el, left, top) {
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.width = `${Math.round(this.pageW)}px`;
    el.style.height = `${Math.round(this.pageH)}px`;
  }

  measureExtent(doc) {
    if (!doc || !doc.body) return 0;
    if (this.vertical) {
      // Body is shrink-to-fit and anchored right, so its own width is exactly
      // how far the text reaches.
      return doc.body.getBoundingClientRect().width;
    }
    let marker = doc.getElementById('__rd_end__');
    if (!marker) {
      marker = doc.createElementNS(XHTML_NS, 'div');
      marker.id = '__rd_end__';
      marker.setAttribute('aria-hidden', 'true');
      marker.style.cssText = 'display:block;width:0;height:0;overflow:hidden;margin:0;padding:0;border:0;';
      doc.body.appendChild(marker);
    }
    const body = doc.body.getBoundingClientRect();
    const end = marker.getBoundingClientRect();
    return Math.max(body.width, end.right - body.left);
  }

  /* The block-axis span of every piece of laid-out content.

     Measured one text node at a time on purpose: a Range over the whole body
     also reports the boxes of the elements it contains, so a paragraph comes
     back as one rectangle covering all of its lines. Mixing those in with real
     line rectangles produced page breaks in the middle of a paragraph.
     Replaced content is added as one atomic span so a break can never land
     inside a picture. */
  contentSpans(doc, origin) {
    const spans = [];
    const range = doc.createRange();
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, null);
    let seen = 0;
    let node;

    const push = (box) => {
      if (box.width <= 0 && box.height <= 0) return;
      const near = this.vertical ? origin - box.right : box.left - origin;
      const far = this.vertical ? origin - box.left : box.right - origin;
      if (far - near > 0.01) spans.push([near, far]);
    };

    while ((node = walker.nextNode())) {
      if (!node.data || !/\S/.test(node.data)) continue;
      if (++seen > MAX_TEXT_NODES) return null;
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) push(rects[i]);
    }
    for (const el of doc.querySelectorAll('img, svg, video, canvas, table, hr')) {
      push(el.getBoundingClientRect());
    }
    return spans;
  }

  /* Fuse overlapping spans into whole line boxes.

     A ruby annotation sits beside its base text rather than inside it, so the
     two arrive as separate rectangles; taking the annotation's far edge as a
     line end is what used to slice the base text in half. Anything that
     overlaps belongs to the same unbreakable unit -- which also means a ruby
     that hangs over the previous line correctly welds the two together. */
  static mergeSpans(spans) {
    spans.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const merged = [];
    for (const span of spans) {
      const last = merged.length ? merged[merged.length - 1] : null;
      if (last && span[0] < last[1] - 0.05) {
        if (span[1] > last[1]) last[1] = span[1];
      } else {
        merged.push([span[0], span[1]]);
      }
    }
    return merged;
  }

  static boundariesFrom(spans) {
    const merged = Reader.mergeSpans(spans);
    const out = [];
    for (const [, far] of merged) {
      if (far <= 0.5) continue;
      if (!out.length || far - out[out.length - 1] > 0.5) out.push(far);
    }
    return out;
  }

  breakIntoPages(bounds) {
    const offsets = [0];
    let start = 0;
    let i = 0;
    while (i < bounds.length) {
      let last = start;
      while (i < bounds.length && bounds[i] <= start + this.pageW + 0.5) {
        last = bounds[i];
        i += 1;
      }
      if (i >= bounds.length) break;
      if (last <= start) {
        // One line is wider than the whole page (an oversized image, say):
        // give it its own page rather than looping forever.
        last = bounds[i];
        i += 1;
      }
      offsets.push(last);
      start = last;
    }
    return offsets;
  }

  uniformPages(extent) {
    // Only reached for a chapter too large to measure line by line. Step by a
    // whole number of line advances so even this crude path does not slice a
    // line down the middle.
    let step = this.pageW;
    if (this.vertical && this.advance > 0) {
      step = Math.max(1, Math.floor(this.pageW / this.advance)) * this.advance;
    }
    const count = Math.max(1, Math.ceil((extent - 2) / step));
    return Array.from({ length: count }, (_, i) => i * step);
  }

  computePages(doc) {
    if (!doc || !doc.body) return [0];
    const body = doc.body;
    const saved = body.style.transform;
    body.style.transition = 'none';
    body.style.transform = 'translateX(0px)';

    const rect = body.getBoundingClientRect();
    const origin = this.vertical ? rect.right : rect.left;

    const spans = this.contentSpans(doc, origin);
    // How far the content really reaches. The box-based measurements
    // under-report: a multicol body is only one page wide, and its end marker
    // can be fragmented before the last of the text.
    let extent = this.measureExtent(doc);
    if (spans) for (const [, far] of spans) if (far > extent) extent = far;
    this.contentExtent = extent;

    let offsets;
    if (this.vertical) {
      const bounds = spans ? Reader.boundariesFrom(spans) : null;
      offsets = bounds && bounds.length ? this.breakIntoPages(bounds) : this.uniformPages(extent);
    } else {
      // Horizontal pages are CSS columns and the engine already fragments
      // those at line boundaries, at exact multiples of the page width.
      offsets = this.uniformPages(extent);
    }

    body.style.transform = saved;
    void body.offsetWidth;
    body.style.transition = '';
    return offsets;
  }

  pageForDistance(distance) {
    for (let i = this.pageOffsets.length - 1; i >= 0; i--) {
      if (distance >= this.pageOffsets[i] - 0.5) return i;
    }
    return 0;
  }

  /* Trim a pane to what its page actually holds.

     A page ends at its break, but the pane is always a whole page wide, so the
     gap between the two showed the first line of the next page sliced down its
     length. The break was in the right place; the window was simply too big. */
  applyClip(el, page) {
    const start = this.pageOffsets[page] || 0;
    const end = page + 1 < this.pageOffsets.length
      ? this.pageOffsets[page + 1]
      : Math.max(this.contentExtent, start);
    const slack = this.pageW - Math.max(0, Math.min(this.pageW, end - start));
    if (slack < 0.5) {
      el.style.clipPath = '';
      return;
    }
    const inset = Math.round(slack * 100) / 100;
    el.style.clipPath = this.vertical
      ? `inset(0 0 0 ${inset}px)`
      : `inset(0 ${inset}px 0 0)`;
  }

  applyTransform(animate) {
    const panes = this.panes();
    for (let i = 0; i < panes.length; i++) {
      const el = panes[i];
      const doc = this.paneDoc(el);
      if (!doc || !doc.body) continue;
      const page = this.pageIndex + i;
      if (page >= this.pageCount) {
        // A spread whose second page does not exist: leave the facing page
        // blank rather than repeating the first.
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = '';
      if (!animate) doc.body.style.transition = 'none';
      const offset = this.pageOffsets[page] || 0;
      const x = this.vertical ? offset : -offset;
      doc.body.style.transform = `translateX(${Math.round(x * 100) / 100}px)`;
      if (!animate) {
        void doc.body.offsetWidth;
        doc.body.style.transition = '';
      }
      this.applyClip(el, page);
    }
  }

  report() {
    this.onPageChanged({
      page: this.pageIndex,
      pages: this.pageCount,
      spread: this.spread,
      mode: this.mode,
    });
  }

  // -- style injection ----------------------------------------------------

  injectStyles(doc) {
    if (!doc || !doc.documentElement) return;
    const head = doc.head || doc.documentElement;

    const makeStyle = (id) => {
      // createElementNS, not createElement: in a document parsed as XML the
      // latter yields a null-namespace element the engine ignores.
      const el = doc.createElementNS(XHTML_NS, 'style');
      el.setAttribute('type', 'text/css');
      el.id = id;
      head.appendChild(el);
      return el;
    };

    // Appended last so these rules beat the book's own stylesheets.
    const base = doc.getElementById('__rd_base__') || makeStyle('__rd_base__');
    if (base.textContent !== this.baseCss) base.textContent = this.baseCss;
    const vars = doc.getElementById('__rd_vars__') || makeStyle('__rd_vars__');
    vars.textContent = this.buildVars();

    doc.documentElement.classList.toggle('rd-v', this.vertical);
    doc.documentElement.classList.toggle('rd-h', !this.vertical);
    doc.documentElement.classList.toggle('rd-anim', !!this.settings.pageAnimation);
  }

  injectAll() {
    for (const el of this.panes()) this.injectStyles(this.paneDoc(el));
  }

  // -- loading ------------------------------------------------------------

  static imagesReady(doc) {
    const images = Array.from(doc.querySelectorAll('img'));
    const waits = images.filter((im) => !im.complete).map((im) => new Promise((resolve) => {
      im.addEventListener('load', resolve, { once: true });
      im.addEventListener('error', resolve, { once: true });
    }));
    if (!waits.length) return Promise.resolve();
    // Never block a page on a broken or very slow image.
    return Promise.race([
      Promise.all(waits),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  static assetsReady(doc) {
    const waits = [Reader.imagesReady(doc)];
    if (doc.fonts && doc.fonts.ready) waits.push(doc.fonts.ready);
    return Promise.all(waits);
  }

  /* Navigating a pane, defensively.

     location.replace is preferred because it keeps the iframe out of the
     history, so a back swipe leaves the book rather than walking through the
     chapters. But on iOS that navigation to a blob URL sometimes never fires
     load, and a pane that never finishes loading stays invisible -- a white
     page. So: try replace, retry once through src, and give up waiting after
     a few seconds and lay out whatever arrived. */
  _loadPane(el, url) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(retry);
        clearTimeout(giveUp);
        el.onload = null;
        resolve(this.paneDoc(el));
      };
      el.onload = finish;
      const retry = setTimeout(() => {
        if (!settled) el.src = url;
      }, 2500);
      const giveUp = setTimeout(finish, 8000);
      try {
        el.contentWindow.location.replace(url);
      } catch {
        el.src = url;
      }
    });
  }

  /** Show one reflowable document. */
  async load({ url, rtl = true, bookVertical = true, page = 0, fragment = '', ratio = null }) {
    this.mode = 'reflow';
    this.fixedLayer.hidden = true;
    this.rtl = rtl;
    this.bookVertical = bookVertical;
    this.currentUrl = url;
    this.pending = { page, fragment, ratio };

    const token = ++this.loadToken;
    // Measuring a chapter that is still arriving gives nonsense -- a novel
    // shipped as one large file paginated to a single page when a resize
    // landed mid-parse.
    this.loading = true;
    for (const el of this.frames) el.classList.add('loading');

    this.vertical = this.decideVertical();
    this.spread = this.decideSpread();
    this.frames[1].hidden = !this.spread;
    this.computeGeometry();

    // Whatever happens below, the panes must not be left invisible.
    clearTimeout(this._loadingGuard);
    this._loadingGuard = setTimeout(() => {
      if (this.loading && token === this.loadToken) {
        this.loading = false;
        for (const el of this.frames) el.classList.remove('loading');
        this.relayout(false);
        this.report();
      }
    }, 12000);

    const waits = [this._loadPane(this.frames[0], url)];
    if (this.spread) waits.push(this._loadPane(this.frames[1], url));
    const docs = await Promise.all(waits);
    if (token !== this.loadToken) return;

    // Read the book's own writing mode before overriding it.
    const lead = docs[0];
    if (lead) {
      try {
        const wm = this.frames[0].contentWindow.getComputedStyle(lead.documentElement).writingMode || '';
        if (wm.startsWith('vertical')) this.bookVertical = true;
      } catch { /* ignore */ }
    }
    this.vertical = this.decideVertical();
    this.computeGeometry();

    for (let i = 0; i < docs.length; i++) {
      if (!docs[i]) continue;
      this.injectStyles(docs[i]);
      this._bindContent(docs[i], this.frames[i]);
    }
    await Promise.all(docs.filter(Boolean).map((doc) => Reader.assetsReady(doc)));
    if (token !== this.loadToken) return;

    clearTimeout(this._loadingGuard);
    this.loading = false;
    this.relayout(false);
    this._applyPending(lead);
    for (const el of this.frames) el.classList.remove('loading');
    this.report();
  }

  _applyPending(doc) {
    let target = 0;
    const pending = this.pending;
    if (pending && doc) {
      if (pending.fragment) {
        let el = null;
        try {
          el = doc.getElementById(pending.fragment)
            || doc.querySelector(`[name="${CSS.escape(pending.fragment)}"]`);
        } catch { el = null; }
        if (el) target = this.pageOfElement(doc, el);
      } else if (pending.ratio !== null && pending.ratio !== undefined) {
        target = Math.round(pending.ratio * Math.max(0, this.pageCount - 1));
      } else if (pending.page === 'last') {
        target = this.pageCount - 1;
      } else {
        target = Number(pending.page) || 0;
      }
    }
    this.pending = null;
    this.pageParity = 0;   // a fresh chapter starts on its natural pairing
    this.pageIndex = Math.max(0, Math.min(this.snap(target), Math.max(0, this.pageCount - 1)));
    this.applyTransform(false);
  }

  pageOfElement(doc, el) {
    const body = doc.body;
    const saved = body.style.transform;
    body.style.transition = 'none';
    body.style.transform = 'translateX(0px)';
    const bodyRect = body.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const distance = this.vertical
      ? bodyRect.right - rect.right
      : rect.left - bodyRect.left;
    body.style.transform = saved;
    void body.offsetWidth;
    body.style.transition = '';
    if (!Number.isFinite(distance) || this.pageW <= 0) return 0;
    return Math.max(0, Math.min(this.pageForDistance(distance), Math.max(0, this.pageCount - 1)));
  }

  // -- layout / paging ----------------------------------------------------

  relayout(keepPosition) {
    if (this.loading) return;   // the load path lays it out once complete
    const doc = this.paneDoc(this.frames[0]);
    const ratio = keepPosition && this.pageCount > 0 ? this.pageIndex / this.pageCount : null;

    this.vertical = this.decideVertical();
    this.spread = this.decideSpread() && this.mode === 'reflow';
    this.frames[1].hidden = !this.spread;
    this.computeGeometry();
    if (!doc || !doc.body) { this.pageCount = 1; this.pageIndex = 0; return; }

    this.injectAll();
    this.pageOffsets = this.computePages(doc);
    this.pageCount = this.pageOffsets.length;

    const target = ratio === null ? this.pageIndex : Math.round(ratio * this.pageCount);
    this.pageIndex = Math.max(0, Math.min(this.snap(target), Math.max(0, this.pageCount - 1)));
    this.applyTransform(false);
  }

  /** Re-lay out after something that can change how many panes are shown. */
  async relayoutPanes(keepPosition) {
    const wanted = this.decideSpread() && this.mode === 'reflow';
    if (wanted && (this.frames[1].hidden || !this.paneDoc(this.frames[1])?.body) && this.currentUrl) {
      this.spread = true;
      this.frames[1].hidden = false;
      this.computeGeometry();
      const doc = await this._loadPane(this.frames[1], this.currentUrl);
      if (doc) {
        this.injectStyles(doc);
        this._bindContent(doc, this.frames[1]);
        await Reader.assetsReady(doc);
      }
    }
    this.relayout(keepPosition);
    this.report();
  }

  goToPage(n, animate = true) {
    if (this.mode !== 'reflow') return;
    this.pageParity = 0;
    const target = Math.max(0, Math.min(this.snap(Number(n) || 0), Math.max(0, this.pageCount - 1)));
    if (target === this.pageIndex) return;
    this.pageIndex = target;
    this.applyTransform(animate);
    this.report();
  }

  /** Move by a single page, re-pairing the spread around the new position. */
  shiftPage(delta) {
    if (this.mode !== 'reflow') return;
    const target = Math.max(0, Math.min(this.pageIndex + delta, Math.max(0, this.pageCount - 1)));
    if (target === this.pageIndex) return;
    this.pageIndex = target;
    this.pageParity = this.spread ? target % 2 : 0;
    this.applyTransform(true);
    this.report();
  }

  next() {
    if (this.mode === 'fixed') { this.onEdge('next'); return; }
    if (this.pageIndex + this.step < this.pageCount) {
      this.pageIndex += this.step;
      this.applyTransform(true);
      this.report();
    } else {
      this.onEdge('next');
    }
  }

  prev() {
    if (this.mode === 'fixed') { this.onEdge('prev'); return; }
    if (this.pageIndex > 0) {
      this.pageIndex = Math.max(0, this.pageIndex - this.step);
      this.applyTransform(true);
      this.report();
    } else {
      this.onEdge('prev');
    }
  }

  // -- fixed layout (pictures) --------------------------------------------

  /* Show one or two pictures.

     The page on screen is left alone until the new one is decoded and ready
     to paint. Swapping first and decoding afterwards leaves a gap in which the
     layer's own background shows through -- a black flash between every pair
     of manga pages, barely visible on a fast desktop and very visible on a
     phone, where decoding a full-size scan takes a moment. */
  async showFixed(urls, { rtl = true, fit = 'contain' } = {}) {
    this.mode = 'fixed';
    this.spread = false;
    this.pageCount = 1;
    this.pageIndex = 0;

    const token = ++this.fixedToken;
    const images = urls.map((src) => {
      const img = document.createElement('img');
      img.draggable = false;
      img.alt = '';
      img.src = src;
      return img;
    });
    await Promise.all(images.map(decoded));
    if (token !== this.fixedToken) return;   // a newer page turn overtook us

    for (const el of this.frames) {
      el.classList.add('loading');
      el.style.clipPath = '';
    }
    this.frames[1].hidden = true;
    this.fixedLayer.hidden = false;

    const classes = ['fixed-layer'];
    if (rtl) classes.push('rtl');
    if (urls.length > 1) classes.push('twin');
    if (fit === 'width') classes.push('fit-width');
    else if (fit === 'height') classes.push('fit-height');
    this.fixedLayer.className = classes.join(' ');

    this.fixedLayer.replaceChildren(...images);
  }

  /* Decode the pictures a reader is about to reach, so that when they get
     there the swap above costs nothing. The decoded images are held for a
     while: dropping the last reference invites the browser to throw the
     decoded form away, which is the cost we are trying to avoid. */
  prefetchImages(urls) {
    for (const src of urls) {
      if (!src || this.warmed.has(src)) continue;
      const img = new Image();
      img.src = src;
      this.warmed.set(src, img);
      decoded(img);
    }
    // A handful of pages either side is enough; the rest can go.
    while (this.warmed.size > 8) {
      this.warmed.delete(this.warmed.keys().next().value);
    }
  }

  // -- settings ------------------------------------------------------------

  async configure(next) {
    const before = this.settings.spreadMode;
    Object.assign(this.settings, next || {});
    this.root.style.setProperty('--page-bg', this.settings.backgroundColor);
    this.root.style.setProperty('--manga-bg', this.settings.mangaBackground);

    if (this.mode === 'fixed') {
      const classes = this.fixedLayer.className.replace(/fit-\w+/g, '').trim().split(/\s+/).filter(Boolean);
      if (this.settings.mangaFit === 'width') classes.push('fit-width');
      else if (this.settings.mangaFit === 'height') classes.push('fit-height');
      this.fixedLayer.className = classes.join(' ');
      return;
    }
    if (before !== this.settings.spreadMode) await this.relayoutPanes(true);
    else { this.relayout(true); this.report(); }
  }

  // -- input ---------------------------------------------------------------

  // Vertical Japanese always advances leftward; horizontal advances rightward
  // unless the spine says otherwise.
  get forwardIsLeft() {
    return this.vertical || (!this.vertical && this.rtl);
  }

  _anchorFor(node) {
    if (node && node.nodeType === 3) node = node.parentNode;
    if (node && node.closest) {
      const hit = node.closest('a[href], a[*|href]');
      if (hit) return hit;
    }
    while (node && node.nodeType === 1) {
      const name = (node.localName || node.tagName || '').toLowerCase();
      if (name === 'a' && node.getAttribute('href')) return node;
      node = node.parentNode;
    }
    return null;
  }

  _handleTap(clientX, target, paneEl) {
    const anchor = this._anchorFor(target);
    if (anchor) {
      const href = anchor.getAttribute('href')
        || anchor.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (href) { this.onLink(href, anchor.href || ''); return; }
    }
    const offset = paneEl ? paneEl.getBoundingClientRect().left : 0;
    const x = clientX + offset;
    const width = window.innerWidth || 1;
    if (x < width * 0.32) this.forwardIsLeft ? this.next() : this.prev();
    else if (x > width * 0.68) this.forwardIsLeft ? this.prev() : this.next();
    else this.onTapMiddle();
  }

  /** How far a finger must travel, on this screen, to turn the page. */
  get swipeDistance() {
    const share = SWIPE_SHARES[this.settings.swipeDepth] || SWIPE_SHARES.normal;
    const width = window.innerWidth || 320;
    return Math.max(SWIPE_MIN, Math.min(width * share, SWIPE_MAX));
  }

  _attachTouch(target, paneEl) {
    let startX = 0;
    let startY = 0;
    let moved = false;

    target.addEventListener('touchstart', (e) => {
      const touch = e.changedTouches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      moved = false;
    }, { passive: true });

    target.addEventListener('touchmove', (e) => {
      const touch = e.changedTouches[0];
      if (Math.abs(touch.clientX - startX) > TAP_SLOP
       || Math.abs(touch.clientY - startY) > TAP_SLOP) moved = true;
    }, { passive: true });

    target.addEventListener('touchend', (e) => {
      // iOS sends a click of its own after a tap. Both would be handled, and
      // the second undoes the first -- which is what made the bars flash and
      // vanish, and made the result depend on how long the tap lasted.
      this.lastTouchAt = Date.now();
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!moved) {
        this._handleTap(touch.clientX, e.target, paneEl);
        return;
      }
      if (Math.abs(dx) > this.swipeDistance && Math.abs(dx) > Math.abs(dy)) {
        // A swipe turns the page the way a hand does. In a right-bound book
        // the next page is the one lying on the left, so it is lifted and
        // carried rightward -- the finger travels left to right. A left-bound
        // book is the mirror of that, which is also how the tap zones work.
        //
        // Dragging the text itself, so that the next page slides in from the
        // side it lives on, is the other reading of a swipe, and it is the
        // opposite gesture. It belongs to scrolling, not to books.
        const rightward = dx > 0;
        if (rightward === this.forwardIsLeft) this.next(); else this.prev();
      }
    }, { passive: true });
  }

  _bindContent(doc, paneEl) {
    if (!doc || doc.__rdBound) return;
    doc.__rdBound = true;
    this._attachTouch(doc, paneEl);
    doc.addEventListener('click', (e) => {
      if (e.__rdSynthetic) return;
      const anchor = this._anchorFor(e.target);
      if (anchor) { e.preventDefault(); }
      // Pointer devices only: a touch already produced a tap above.
      if (e.pointerType === 'touch' || e.detail === 0) return;
      if (this.afterTouch()) return;
      e.preventDefault();
      this._handleTap(e.clientX, e.target, paneEl);
    }, true);
    doc.addEventListener('contextmenu', (e) => e.preventDefault());
    doc.addEventListener('dragstart', (e) => e.preventDefault());
    doc.addEventListener('keydown', (e) => this._handleKey(e), true);
  }

  _handleKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': this.forwardIsLeft ? this.next() : this.prev(); break;
      case 'ArrowRight': this.forwardIsLeft ? this.prev() : this.next(); break;
      case 'ArrowDown': case 'PageDown': this.next(); break;
      case 'ArrowUp': case 'PageUp': this.prev(); break;
      case ' ': e.shiftKey ? this.prev() : this.next(); break;
      case 'Home': this.goToPage(0); break;
      case 'End': this.goToPage(this.pageCount - 1); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  _bindShellEvents() {
    this._attachTouch(this.stage, null);
    this.stage.addEventListener('click', (e) => {
      if (e.pointerType === 'touch' || e.detail === 0) return;
      if (this.afterTouch()) return;
      if (e.target.closest && e.target.closest('.fixed-layer')) {
        this._handleTap(e.clientX, e.target, null);
      }
    });
    document.addEventListener('keydown', (e) => this._handleKey(e), true);

    let resizeTimer = 0;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // Safari fires resize whenever its toolbars slide, many times a
        // second, with the stage the same size throughout. Re-paginating on
        // each one meant the chapter was permanently being rebuilt, which is
        // what the flicker and the blank pages were.
        const w = this.stage.clientWidth;
        const h = this.stage.clientHeight;
        if (w === this.lastStageW && h === this.lastStageH) return;
        this.lastStageW = w;
        this.lastStageH = h;
        if (this.mode === 'reflow') this.relayoutPanes(true);
      }, 200);
    };
    window.addEventListener('resize', onResize);
    // iOS fires this on rotation before the resize settles.
    window.addEventListener('orientationchange', () => setTimeout(onResize, 250));
  }

  state() {
    return {
      page: this.pageIndex,
      pages: this.pageCount,
      mode: this.mode,
      spread: this.spread,
      vertical: this.vertical,
      advance: this.advance,
      pageW: Math.round(this.pageW),
      pageH: Math.round(this.pageH),
      offsets: this.pageOffsets.slice(),
      contentExtent: Math.round(this.contentExtent),
    };
  }
}
