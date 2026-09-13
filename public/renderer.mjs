import { getFace } from './shared/fonts.mjs';
import { faceMetrics, layoutLines, lineBottoms } from './shared/layout.mjs';

const measureCtx = document.createElement('canvas').getContext('2d');
const widthCache = new Map();

// 字幕座標での1文字の幅を返す関数（100px で測って縮尺する）
export function charMeasurer(style) {
  const { font, face } = getFace(style);
  const key = `${face.weight} 100px "${font.family}"`;
  if (!widthCache.has(key)) widthCache.set(key, new Map());
  const cache = widthCache.get(key);
  const { em } = faceMetrics(style);
  return ch => {
    let w = cache.get(ch);
    if (w === undefined) {
      measureCtx.font = key;
      w = measureCtx.measureText(ch).width;
      cache.set(ch, w);
    }
    return (w * em) / 100;
  };
}

// そのフォントがこのブラウザで使えるか（代わりのフォントと幅が変わるかで判断する）
export function fontAvailable(family) {
  const sample = 'あア漢字テロップWwMmIil10';
  return ['monospace', 'serif'].some(fallback => {
    measureCtx.font = `100px ${fallback}`;
    const a = measureCtx.measureText(sample).width;
    measureCtx.font = `100px "${family}", ${fallback}`;
    return Math.abs(measureCtx.measureText(sample).width - a) > 0.5;
  });
}

function rgba(hex, alpha = 1) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// 1つのテロップ（行の配列）の形を描く。書き出し（libass）と同じ寸法になるようにしている
function drawShapes(ctx, lines, style, bottoms, cx, { fill, stroke, box }) {
  const { descent } = faceMetrics(style);
  for (let i = 0; i < lines.length; i++) {
    const baseline = bottoms[i] - descent;
    if (style.box) {
      const w = ctx.measureText(lines[i]).width;
      const pad = style.boxPadding;
      ctx.fillStyle = box;
      ctx.fillRect(cx - w / 2 - pad, bottoms[i] - style.size - pad, w + pad * 2, style.size + pad * 2);
      ctx.fillStyle = fill;
      ctx.fillText(lines[i], cx, baseline);
    } else {
      if (style.outlineWidth > 0) {
        ctx.lineWidth = style.outlineWidth * 2;
        ctx.strokeStyle = stroke;
        ctx.strokeText(lines[i], cx, baseline);
      }
      ctx.fillStyle = fill;
      ctx.fillText(lines[i], cx, baseline);
    }
  }
}

const shadowCanvas = document.createElement('canvas');

function prepare(ctx, style, scale) {
  const { font, face, em } = faceMetrics(style);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.font = `${face.weight} ${em}px "${font.family}"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
}

// items: [{ lines }]。canvas 全体を動画の表示範囲として描く
export function drawCaptions(canvas, items, style, playRes) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const visible = items.filter(it => it.lines.length);
  if (!visible.length) return;
  const scale = canvas.height / playRes.h;
  const cx = playRes.w / 2;

  if (style.shadow > 0 && style.shadowOpacity > 0) {
    // 影は形をいったん不透明で描いてから、まとめて半透明で重ねる（重なった所だけ濃くならないように）
    shadowCanvas.width = canvas.width;
    shadowCanvas.height = canvas.height;
    const sctx = shadowCanvas.getContext('2d');
    prepare(sctx, style, scale);
    sctx.translate(style.shadow, style.shadow);
    const solid = rgba(style.shadowColor);
    for (const it of visible) drawShapes(sctx, it.lines, style, lineBottoms(style, it.lines.length, playRes), cx, { fill: solid, stroke: solid, box: solid });
    ctx.globalAlpha = style.shadowOpacity;
    ctx.drawImage(shadowCanvas, 0, 0);
    ctx.globalAlpha = 1;
  }

  prepare(ctx, style, scale);
  for (const it of visible) {
    drawShapes(ctx, it.lines, style, lineBottoms(style, it.lines.length, playRes), cx, {
      fill: rgba(style.color),
      stroke: rgba(style.outlineColor),
      box: rgba(style.boxColor, style.boxOpacity),
    });
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// 動画の上に重ねるプレビュー。行分けの結果は書き出しにもそのまま使う
export class CaptionRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.cache = new Map();
    this.key = '';
    this.style = null;
    this.playRes = { w: 1920, h: 1080 };
  }

  setStyle(style, playRes) {
    const key = JSON.stringify([style, playRes]);
    if (key === this.key) return;
    this.key = key;
    this.cache.clear();
    this.style = style;
    this.playRes = playRes;
  }

  linesFor(text) {
    let lines = this.cache.get(text);
    if (!lines) {
      lines = layoutLines(text, this.style, this.playRes, charMeasurer(this.style));
      if (this.cache.size > 5000) this.cache.clear();
      this.cache.set(text, lines);
    }
    return lines;
  }

  resize(cssWidth, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  draw(captions) {
    if (!this.style) return;
    drawCaptions(this.canvas, captions.map(c => ({ lines: this.linesFor(c.text) })), this.style, this.playRes);
  }
}

// デザインの見本（プリセットのボタンなど）に使う小さな描画
export function drawSample(canvas, style, text = 'テロップ') {
  const playRes = { w: 1000, h: Math.round((1000 * canvas.height) / canvas.width) };
  const measure = charMeasurer(style);
  const width = Array.from(text).reduce((sum, ch) => sum + measure(ch), 0);
  const edge = style.box ? style.boxPadding : style.outlineWidth + style.shadow;
  const fit = Math.min((playRes.w * 0.86) / (width + edge * 2), (playRes.h * 0.62) / (style.size + edge * 2));
  const scaled = { ...style, size: style.size * fit, outlineWidth: style.outlineWidth * fit, shadow: style.shadow * fit, boxPadding: style.boxPadding * fit, position: 'middle', margin: 0 };
  drawCaptions(canvas, [{ lines: [text] }], scaled, playRes);
}
