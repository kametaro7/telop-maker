import { clamp, formatTime } from './util.mjs';

const RULER_H = 18;
const WAVE_TOP = 20;
const WAVE_H = 50;
const BLOCK_TOP = 76;
const BLOCK_H = 34;
const EDGE = 6;
const MIN_DURATION = 0.2;

// 波形とテロップの帯を表示し、クリックで移動・ドラッグで表示時間を変える
export class Timeline {
  constructor(editor, { scroll, spacer, canvas, zoom }) {
    this.editor = editor;
    this.scroll = scroll;
    this.spacer = spacer;
    this.canvas = canvas;
    this.zoom = zoom;
    this.ctx = canvas.getContext('2d');
    this.drag = null;
    this.pps = 50;
    this.listeners = [];

    this.on(canvas, 'pointerdown', e => this.onPointerDown(e));
    this.on(canvas, 'pointermove', e => this.onPointerMove(e));
    this.on(canvas, 'pointerup', e => this.onPointerUp(e));
    this.on(canvas, 'pointercancel', e => this.onPointerUp(e));
    this.on(canvas, 'dblclick', e => this.onDoubleClick(e));
    this.on(scroll, 'scroll', () => this.draw());
    this.on(scroll, 'wheel', e => this.onWheel(e), { passive: false });
    this.on(zoom, 'input', () => this.applyZoom());
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(scroll);
  }

  on(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this.listeners.push(() => target.removeEventListener(type, fn, options));
  }

  destroy() {
    this.listeners.forEach(off => off());
    this.resizeObserver.disconnect();
  }

  get viewWidth() {
    return this.scroll.clientWidth;
  }

  // 拡大スライダー（0〜100）を「全体が入る倍率」〜「1秒 400px」の対数スケールに対応させる
  pixelsPerSecond(value = Number(this.zoom.value)) {
    const duration = this.editor.duration || 1;
    const fit = Math.max(1, (this.viewWidth - 16) / duration);
    const max = Math.max(fit, 400);
    return fit * (max / fit) ** (value / 100);
  }

  applyZoom(anchorTime = this.editor.currentTime, anchorX = null) {
    const x = anchorX ?? anchorTime * this.pps - this.scroll.scrollLeft;
    this.pps = this.pixelsPerSecond();
    this.spacer.style.width = `${Math.ceil((this.editor.duration || 0) * this.pps + 16)}px`;
    this.scroll.scrollLeft = Math.max(0, anchorTime * this.pps - x);
    this.draw();
  }

  layout() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.viewWidth;
    const h = this.canvas.clientHeight || 116;
    this.canvas.style.width = `${w}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.applyZoom();
  }

  timeAt(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    return clamp((clientX - rect.left + this.scroll.scrollLeft) / this.pps, 0, this.editor.duration || 0);
  }

  // 再生中に再生位置が画面の外へ出そうなら追いかける
  follow(time) {
    const x = time * this.pps - this.scroll.scrollLeft;
    if (x < 0 || x > this.viewWidth * 0.9) this.scroll.scrollLeft = Math.max(0, time * this.pps - this.viewWidth * 0.15);
  }

  hitTest(e) {
    const rect = this.canvas.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (y < BLOCK_TOP - 4 || y > BLOCK_TOP + BLOCK_H + 4) return null;
    const x = e.clientX - rect.left + this.scroll.scrollLeft;
    const caps = this.editor.captions;
    for (let i = caps.length - 1; i >= 0; i--) {
      const c = caps[i];
      const x0 = c.start * this.pps;
      const x1 = c.end * this.pps;
      if (x < x0 - EDGE || x > x1 + EDGE) continue;
      const edge = Math.min(EDGE, (x1 - x0) / 3);
      if (Math.abs(x - x0) <= edge) return { index: i, mode: 'start' };
      if (Math.abs(x - x1) <= edge) return { index: i, mode: 'end' };
      if (x >= x0 && x <= x1) return { index: i, mode: 'move' };
    }
    return null;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    const hit = this.hitTest(e);
    const t = this.timeAt(e.clientX);
    this.canvas.setPointerCapture(e.pointerId);
    if (!hit) {
      this.drag = { mode: 'scrub' };
      this.editor.seek(t);
      return;
    }
    const cap = this.editor.captions[hit.index];
    this.editor.select(cap.id, { scroll: true });
    this.drag = { ...hit, id: cap.id, grabTime: t, orig: { start: cap.start, end: cap.end }, moved: false };
  }

  onPointerMove(e) {
    if (!this.drag) {
      const hit = this.hitTest(e);
      this.canvas.style.cursor = !hit ? 'text' : hit.mode === 'move' ? 'grab' : 'ew-resize';
      return;
    }
    const t = this.timeAt(e.clientX);
    if (this.drag.mode === 'scrub') {
      this.editor.seek(t);
      return;
    }
    const caps = this.editor.captions;
    const index = caps.findIndex(c => c.id === this.drag.id);
    if (index < 0) return;
    const prevEnd = index > 0 ? caps[index - 1].end : 0;
    const nextStart = index < caps.length - 1 ? caps[index + 1].start : this.editor.duration;
    const { orig } = this.drag;
    let { start, end } = orig;
    if (this.drag.mode === 'start') start = clamp(this.snap(t), prevEnd, orig.end - MIN_DURATION);
    else if (this.drag.mode === 'end') end = clamp(this.snap(t), orig.start + MIN_DURATION, nextStart);
    else {
      const length = orig.end - orig.start;
      start = clamp(orig.start + (t - this.drag.grabTime), prevEnd, Math.max(prevEnd, nextStart - length));
      end = start + length;
    }
    if (!this.drag.moved && Math.abs(t - this.drag.grabTime) * this.pps < 3) return;
    if (!this.drag.moved) this.editor.beginEdit();
    this.drag.moved = true;
    this.canvas.style.cursor = this.drag.mode === 'move' ? 'grabbing' : 'ew-resize';
    this.editor.setCaptionTimes(this.drag.id, start, end, { live: true });
  }

  onPointerUp(e) {
    if (!this.drag) return;
    const { moved, mode, id } = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (moved) this.editor.endEdit();
    else if (mode === 'move') {
      const cap = this.editor.captions.find(c => c.id === id);
      if (cap) this.editor.seek(cap.start + 0.001);
    }
  }

  onDoubleClick(e) {
    if (this.hitTest(e)) return;
    const rect = this.canvas.getBoundingClientRect();
    if (e.clientY - rect.top < BLOCK_TOP - 4) return;
    this.editor.addCaptionAt(this.timeAt(e.clientX));
  }

  onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const time = this.timeAt(e.clientX);
      this.zoom.value = String(clamp(Number(this.zoom.value) - e.deltaY * 0.15, 0, 100));
      this.applyZoom(time, x);
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      this.scroll.scrollLeft += e.deltaY;
    }
  }

  // 再生位置の近くに来たら吸いつかせる
  snap(t) {
    const playhead = this.editor.currentTime;
    return Math.abs(playhead - t) * this.pps < 6 ? playhead : t;
  }

  draw() {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const left = this.scroll.scrollLeft;
    const pps = this.pps;
    const duration = this.editor.duration || 0;
    const t0 = left / pps;
    const t1 = (left + w) / pps;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#16191f';
    ctx.fillRect(0, 0, w, h);
    const endX = duration * pps - left;
    if (endX < w) {
      ctx.fillStyle = '#0f1115';
      ctx.fillRect(Math.max(0, endX), 0, w, h);
    }

    // 目盛り
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
    const step = steps.find(s => s * pps >= 80) || 3600;
    ctx.font = '10px -apple-system, "Hiragino Sans", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#6f7684';
    ctx.strokeStyle = '#2e333d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round(t * pps - left) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, RULER_H);
      ctx.fillText(formatTime(t, step < 1 ? 1 : 0), x + 3, 3);
    }
    ctx.stroke();

    // 波形
    const peaks = this.editor.peaks;
    if (peaks) {
      ctx.fillStyle = '#3d4a5c';
      const mid = WAVE_TOP + WAVE_H / 2;
      for (let x = 0; x < Math.min(w, endX); x++) {
        const a = Math.floor(((x + left) / pps) * peaks.rate);
        const b = Math.max(a + 1, Math.floor(((x + 1 + left) / pps) * peaks.rate));
        let m = 0;
        for (let i = a; i < b && i < peaks.data.length; i++) if (peaks.data[i] > m) m = peaks.data[i];
        const hh = Math.max(1, (m / 255) * (WAVE_H / 2));
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    }

    // テロップの帯
    const caps = this.editor.captions;
    const selected = this.editor.selectedId;
    const active = this.editor.activeId;
    ctx.textBaseline = 'middle';
    ctx.font = '12px -apple-system, "Hiragino Sans", sans-serif';
    for (const c of caps) {
      if (c.end < t0 || c.start > t1) continue;
      const x = c.start * pps - left;
      const bw = Math.max(2, (c.end - c.start) * pps);
      const isSel = c.id === selected;
      ctx.fillStyle = isSel ? '#ffb020' : c.id === active ? '#5a4a26' : c.low ? '#4d4526' : '#343a46';
      roundRect(ctx, x + 0.5, BLOCK_TOP, bw - 1, BLOCK_H, 4);
      ctx.fill();
      if (bw > 14) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 5, BLOCK_TOP, bw - 10, BLOCK_H);
        ctx.clip();
        ctx.fillStyle = isSel ? '#1b1400' : '#dfe3ea';
        ctx.fillText(c.text.replace(/\n/g, ' ') || '（空）', x + 6, BLOCK_TOP + BLOCK_H / 2);
        ctx.restore();
      }
      if (isSel) {
        ctx.fillStyle = '#1b1400';
        ctx.fillRect(x + 2, BLOCK_TOP + 9, 2, BLOCK_H - 18);
        ctx.fillRect(x + bw - 4, BLOCK_TOP + 9, 2, BLOCK_H - 18);
      }
    }

    // 再生位置
    const px = Math.round(this.editor.currentTime * pps - left) + 0.5;
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.fillStyle = '#ff5a5a';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 7);
      ctx.fill();
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
