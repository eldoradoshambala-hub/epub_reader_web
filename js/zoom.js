/* Looking closely at a picture.
 *
 * A novel's illustrations are drawn for a page far larger than a phone's, and
 * the detail in them is lost at the size the page can give them. Pinching one
 * opens it here, over everything, at exactly the size and place it had on the
 * page -- so the same two fingers carry straight on into zooming it, with
 * nothing jumping under them.
 *
 * From there: pinch to zoom, one finger to move around, double-tap to zoom in
 * on a spot or back out. A tap, the ✕, or pinching it back down past the size
 * it fits the screen at puts the page back.
 */

'use strict';

const MAX_ZOOM = 6;           // times the size that fits the screen
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_ZOOM = 2.5;
const TAP_SLOP = 10;
const SETTLE_MS = 200;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function pointsOf(touches) {
  return Array.from(touches).map((t) => ({ x: t.clientX, y: t.clientY }));
}

/* Resolves once the picture can be painted, or would never be. */
function ready(img) {
  const loaded = img.decode
    ? img.decode().catch(() => {})
    : new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });
  return loaded;
}

export class PictureZoom {
  constructor(root) {
    this.root = root;
    this.image = root.querySelector('img');
    this.closeButton = root.querySelector('.zoom-close');

    // The picture is laid out at its own pixel size and drawn at `scale`,
    // with its top left corner at (x, y) on the screen.
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.fit = 1;              // the scale at which it just fits the screen
    this.naturalW = 1;
    this.naturalH = 1;

    this.isOpen = false;
    this.token = 0;
    this.gesture = null;       // what the fingers on the picture are doing
    this.lastTap = null;
    this.tapTimer = 0;

    this._bind();
  }

  /* Open a picture from the page.

     `picture` is what the reader found under the fingers: its address, where
     it sat on screen, and where the two fingers were. Returns the handle the
     reader feeds the rest of that pinch through -- the fingers went down on
     the page, so their movements keep arriving there, not here. */
  show({ src, rect = null, points = null }) {
    const token = ++this.token;
    this.isOpen = true;
    clearTimeout(this.tapTimer);
    this.gesture = null;
    this.root.hidden = false;
    this.root.classList.remove('shown');
    this.image.classList.remove('settling');
    this.image.style.visibility = 'hidden';
    this.image.src = src;

    const pinch = points && points.length >= 2
      ? { start: points, latest: points, ended: false, opening: true }
      : null;

    ready(this.image).then(() => {
      if (token !== this.token) return;
      if (!this.image.naturalWidth) { this.close(); return; }
      this.naturalW = this.image.naturalWidth || 1;
      this.naturalH = this.image.naturalHeight || 1;
      this._measureFit();
      if (rect && rect.width > 0 && rect.height > 0) {
        const scale = Math.min(rect.width / this.naturalW, rect.height / this.naturalH);
        this._set(
          scale,
          rect.left + (rect.width - this.naturalW * scale) / 2,
          rect.top + (rect.height - this.naturalH * scale) / 2,
        );
      } else {
        this._set(this.fit, (this._screenW() - this.naturalW * this.fit) / 2,
          (this._screenH() - this.naturalH * this.fit) / 2);
      }
      this.image.style.visibility = '';
      void this.root.offsetHeight;
      this.root.classList.add('shown');

      if (pinch) {
        this._beginPinch(pinch.start, true);
        this._movePinch(pinch.latest);
        if (pinch.ended) this._endGesture();
      } else {
        this._settle(true);
      }
    });

    return {
      move: (points) => {
        if (!pinch) return;
        pinch.latest = points;
        if (this.gesture && this.gesture.kind === 'pinch') this._movePinch(points);
      },
      end: () => {
        if (!pinch) return;
        pinch.ended = true;
        if (this.gesture) this._endGesture();
      },
    };
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.token += 1;
    this.gesture = null;
    clearTimeout(this.tapTimer);
    this.root.classList.remove('shown');
    setTimeout(() => {
      if (this.isOpen) return;
      this.root.hidden = true;
      this.image.removeAttribute('src');
    }, SETTLE_MS);
  }

  // -- geometry ------------------------------------------------------------

  _screenW() { return this.root.clientWidth || window.innerWidth || 1; }
  _screenH() { return this.root.clientHeight || window.innerHeight || 1; }

  _measureFit() {
    this.fit = Math.min(this._screenW() / this.naturalW, this._screenH() / this.naturalH);
  }

  _set(scale, x, y) {
    this.scale = scale;
    this.x = x;
    this.y = y;
    this.image.style.width = `${this.naturalW}px`;
    this.image.style.height = `${this.naturalH}px`;
    this.image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  /* Where the picture belongs once the fingers let go: no smaller than fits
     the screen, no larger than the limit, and with no gap at an edge that the
     picture could be covering. A picture smaller than the screen in one
     direction is centred in it. */
  _settle(animate) {
    const scale = clamp(this.scale, this.fit, this.fit * MAX_ZOOM);
    // Keep the middle of the screen on the same spot of the picture.
    const cx = this._screenW() / 2;
    const cy = this._screenH() / 2;
    let x = cx - (cx - this.x) * (scale / this.scale);
    let y = cy - (cy - this.y) * (scale / this.scale);
    const w = this.naturalW * scale;
    const h = this.naturalH * scale;
    x = w <= this._screenW() ? (this._screenW() - w) / 2 : clamp(x, this._screenW() - w, 0);
    y = h <= this._screenH() ? (this._screenH() - h) / 2 : clamp(y, this._screenH() - h, 0);
    this.image.classList.toggle('settling', !!animate);
    this._set(scale, x, y);
  }

  _zoomAround(point, scale) {
    const k = scale / this.scale;
    this._set(scale, point.x - (point.x - this.x) * k, point.y - (point.y - this.y) * k);
  }

  // -- gestures ------------------------------------------------------------

  _beginPinch(points, opening = false) {
    const [a, b] = points;
    this.image.classList.remove('settling');
    this.gesture = {
      kind: 'pinch',
      opening,
      distance: Math.max(1, distance(a, b)),
      mid: midpoint(a, b),
      scale: this.scale,
      x: this.x,
      y: this.y,
    };
  }

  _movePinch(points) {
    const g = this.gesture;
    if (!g || g.kind !== 'pinch' || points.length < 2) return;
    const [a, b] = points;
    const mid = midpoint(a, b);
    const scale = clamp(g.scale * distance(a, b) / g.distance,
      this.fit * 0.3, this.fit * MAX_ZOOM * 1.3);
    // The spot of the picture that was between the fingers stays between
    // them, wherever they go.
    const px = (g.mid.x - g.x) / g.scale;
    const py = (g.mid.y - g.y) / g.scale;
    this._set(scale, mid.x - px * scale, mid.y - py * scale);
  }

  _beginPan(point) {
    this.image.classList.remove('settling');
    this.gesture = { kind: 'pan', start: point, x: this.x, y: this.y, moved: false };
  }

  _movePan(point) {
    const g = this.gesture;
    if (!g || g.kind !== 'pan') return;
    const dx = point.x - g.start.x;
    const dy = point.y - g.start.y;
    if (!g.moved && Math.hypot(dx, dy) <= TAP_SLOP) return;
    g.moved = true;
    this._set(this.scale, g.x + dx, g.y + dy);
  }

  _endGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.kind === 'pinch') {
      // Pinched smaller than it started: the opening pinch was a mistake, or
      // the picture is being put back.
      const putBack = g.opening
        ? this.scale < g.scale * 0.9
        : this.scale < this.fit * 0.75;
      if (putBack) { this.close(); return; }
      this._settle(true);
      return;
    }
    if (g.kind === 'pan' && !g.moved) {
      this._tap(g.start);
      return;
    }
    this._settle(true);
  }

  /* A tap at the fitted size puts the page back; a second tap close behind
     it zooms instead. The first has to wait to find out which it is. */
  _tap(point) {
    const now = Date.now();
    const last = this.lastTap;
    if (last && now - last.at < DOUBLE_TAP_MS && distance(last.point, point) < 40) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      this.image.classList.add('settling');
      if (this.scale > this.fit * 1.05) {
        this._zoomAround(point, this.fit);
      } else {
        this._zoomAround(point, this.fit * DOUBLE_TAP_ZOOM);
      }
      this._settle(true);
      return;
    }
    this.lastTap = { at: now, point };
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      this.lastTap = null;
      if (this.scale <= this.fit * 1.05) this.close();
    }, DOUBLE_TAP_MS);
  }

  _bind() {
    const root = this.root;
    const onButton = (e) => e.target.closest && e.target.closest('.zoom-close');

    root.addEventListener('touchstart', (e) => {
      if (onButton(e)) return;
      // Nothing of the browser's own: no page zoom, no image callout, and no
      // click synthesised after the tap, which this handles itself.
      e.preventDefault();
      const points = pointsOf(e.touches);
      if (points.length >= 2) this._beginPinch(points);
      else this._beginPan(points[0]);
    }, { passive: false });

    root.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const points = pointsOf(e.touches);
      if (!this.gesture) return;
      if (this.gesture.kind === 'pinch') this._movePinch(points);
      else this._movePan(points[0]);
    }, { passive: false });

    const lift = (e) => {
      if (onButton(e)) return;
      const left = pointsOf(e.touches);
      if (left.length === 1 && this.gesture && this.gesture.kind === 'pinch') {
        // One finger of the pinch lifted: carry on moving with the other.
        this._beginPan(left[0]);
        this.gesture.moved = true;
        return;
      }
      if (left.length === 0) this._endGesture();
    };
    root.addEventListener('touchend', lift, { passive: true });
    root.addEventListener('touchcancel', lift, { passive: true });

    // A mouse or trackpad, as on an iPad with one attached, or the desktop.
    root.addEventListener('click', (e) => {
      if (onButton(e) || e.detail === 0) return;
      if (e.target === this.image) this._tap({ x: e.clientX, y: e.clientY });
      else this.close();
    });
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = clamp(this.scale * Math.exp(-e.deltaY / 300), this.fit, this.fit * MAX_ZOOM);
      this.image.classList.remove('settling');
      this._zoomAround({ x: e.clientX, y: e.clientY }, scale);
      this._settle(false);
    }, { passive: false });

    this.closeButton.addEventListener('click', () => this.close());

    // While a picture is open, keys belong to it, not to the page underneath.
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') this.close();
      e.preventDefault();
      e.stopPropagation();
    }, true);

    window.addEventListener('resize', () => {
      if (!this.isOpen || this.gesture) return;
      const wasFitted = this.scale <= this.fit * 1.05;
      this._measureFit();
      if (wasFitted) this.scale = this.fit;
      this._settle(false);
    });
  }
}
