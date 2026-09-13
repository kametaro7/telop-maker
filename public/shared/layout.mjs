import { getFace } from './fonts.mjs';
import { displayText, wrapText } from './text.mjs';

// 字幕の座標系。短い辺を 1080 にそろえるので、サイズ類は「1080p の動画での px」として扱える
export function playResFor(width, height) {
  if (!width || !height) return { w: 1920, h: 1080 };
  if (width >= height) return { w: Math.round((1080 * width) / height), h: 1080 };
  return { w: 1080, h: Math.round((1080 * height) / width) };
}

// libass と同じ計算: em の大きさ = size × upm / (winAscent + winDescent)、行の高さ = size
export function faceMetrics(style) {
  const { font, face } = getFace(style);
  const unitsHeight = face.winAsc + face.winDesc;
  return {
    font,
    face,
    em: (style.size * face.upm) / unitsHeight,
    ascent: (style.size * face.winAsc) / unitsHeight,
    descent: (style.size * face.winDesc) / unitsHeight,
  };
}

export function maxLineWidth(style, playRes) {
  const side = Math.round(playRes.w * 0.05);
  const edge = style.box ? style.boxPadding : style.outlineWidth + style.shadow;
  return Math.max(50, playRes.w - 2 * side - 2 * edge);
}

// 各行の下端（ベースライン + descent）の Y 座標。書き出しでは {\an2\pos(x,y)} にそのまま使う
export function lineBottoms(style, lineCount, playRes) {
  const lineHeight = style.size;
  const padY = style.box ? style.boxPadding : 0;
  // 黒帯は帯どうしが重なると濃くなるので、ちょうど接する間隔にする
  const pitch = lineHeight + 2 * padY;
  const blockHeight = lineCount * lineHeight + (lineCount - 1) * 2 * padY;
  let top;
  if (style.position === 'top') top = style.margin + padY;
  else if (style.position === 'middle') top = (playRes.h - blockHeight) / 2;
  else top = playRes.h - style.margin - padY - blockHeight;
  return Array.from({ length: lineCount }, (_, i) => top + lineHeight + i * pitch);
}

// テロップの文字列を、画面に収まる行に分ける（measureChar は字幕座標での1文字の幅）
export function layoutLines(text, style, playRes, measureChar) {
  return wrapText(displayText(text, style), maxLineWidth(style, playRes), measureChar);
}
