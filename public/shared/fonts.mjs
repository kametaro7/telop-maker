// テロップに使えるフォント（この Mac に入っているもの）。
// libass はフォントサイズを usWinAscent + usWinDescent の高さとして扱うため、
// プレビューを書き出しと同じ大きさにするのに書体ごとの値を持っておく（単位はフォント内部の units）
export const FONTS = [
  {
    id: 'hiragino-sans',
    label: 'ヒラギノ角ゴシック',
    family: 'Hiragino Sans',
    faces: [
      { weight: 300, label: '細い (W3)', upm: 1000, winAsc: 1000, winDesc: 234 },
      { weight: 400, label: 'ふつう (W4)', upm: 1000, winAsc: 1015, winDesc: 242 },
      { weight: 600, label: 'やや太い (W6)', upm: 1000, winAsc: 1058, winDesc: 274 },
      { weight: 700, label: '太い (W7)', upm: 1000, winAsc: 1090, winDesc: 297 },
      { weight: 800, label: 'とても太い (W8)', upm: 1000, winAsc: 1125, winDesc: 324 },
      { weight: 900, label: '極太 (W9)', upm: 1000, winAsc: 1167, winDesc: 355 },
    ],
  },
  {
    id: 'toppan-midashi-gothic',
    label: '凸版文久見出しゴシック',
    family: 'Toppan Bunkyu Midashi Gothic',
    faces: [{ weight: 900, label: '極太', upm: 1000, winAsc: 1150, winDesc: 290 }],
  },
  {
    id: 'tsukushi-a-round',
    label: '筑紫A丸ゴシック',
    family: 'Tsukushi A Round Gothic',
    faces: [
      { weight: 400, label: 'ふつう', upm: 1000, winAsc: 1127, winDesc: 264 },
      { weight: 700, label: '太い', upm: 1000, winAsc: 1152, winDesc: 279 },
    ],
  },
  {
    id: 'hiragino-maru',
    label: 'ヒラギノ丸ゴ',
    family: 'Hiragino Maru Gothic ProN',
    faces: [{ weight: 400, label: 'ふつう', upm: 1000, winAsc: 1029, winDesc: 249 }],
  },
  {
    id: 'yu-gothic',
    label: '游ゴシック',
    family: 'YuGothic',
    faces: [
      { weight: 500, label: 'ふつう', upm: 1000, winAsc: 1292, winDesc: 306 },
      { weight: 700, label: '太い', upm: 1000, winAsc: 1306, winDesc: 345 },
    ],
  },
  {
    id: 'biz-ud-gothic',
    label: 'BIZ UDゴシック',
    family: 'BIZ UDGothic',
    faces: [
      { weight: 400, label: 'ふつう', upm: 2048, winAsc: 1802, winDesc: 246 },
      { weight: 700, label: '太い', upm: 2048, winAsc: 1802, winDesc: 246 },
    ],
  },
  {
    id: 'hiragino-mincho',
    label: 'ヒラギノ明朝',
    family: 'Hiragino Mincho ProN',
    faces: [
      { weight: 300, label: 'ふつう (W3)', upm: 1000, winAsc: 985, winDesc: 182 },
      { weight: 600, label: '太い (W6)', upm: 1000, winAsc: 1001, winDesc: 203 },
    ],
  },
  {
    id: 'klee',
    label: 'クレー（手書き風）',
    family: 'Klee',
    faces: [
      { weight: 500, label: 'ふつう', upm: 1000, winAsc: 942, winDesc: 211 },
      { weight: 600, label: '太い', upm: 1000, winAsc: 946, winDesc: 214 },
    ],
  },
];

export const DEFAULT_STYLE = {
  preset: 'youtube',
  fontId: 'hiragino-sans',
  weight: 700,
  size: 64,
  color: '#ffffff',
  outlineColor: '#000000',
  outlineWidth: 5,
  shadow: 0,
  shadowColor: '#000000',
  shadowOpacity: 0.6,
  box: false,
  boxColor: '#000000',
  boxOpacity: 0.6,
  boxPadding: 14,
  position: 'bottom',
  margin: 56,
  removePunctuation: true,
};

export const PRESETS = [
  {
    id: 'youtube',
    label: 'YouTube字幕風',
    style: { fontId: 'hiragino-sans', weight: 700, size: 64, color: '#ffffff', outlineColor: '#000000', outlineWidth: 5, shadow: 0, box: false, margin: 56 },
  },
  {
    id: 'variety',
    label: 'バラエティ風',
    style: { fontId: 'toppan-midashi-gothic', weight: 900, size: 80, color: '#ffe433', outlineColor: '#1a1a1a', outlineWidth: 9, shadow: 4, shadowColor: '#000000', shadowOpacity: 0.55, box: false, margin: 60 },
  },
  {
    id: 'pop',
    label: 'ポップ',
    style: { fontId: 'tsukushi-a-round', weight: 700, size: 72, color: '#ffffff', outlineColor: '#ff5c9a', outlineWidth: 8, shadow: 0, box: false, margin: 60 },
  },
  {
    id: 'band',
    label: '黒帯',
    style: { fontId: 'hiragino-sans', weight: 600, size: 56, color: '#ffffff', shadow: 0, box: true, boxColor: '#000000', boxOpacity: 0.6, boxPadding: 14, margin: 48 },
  },
  {
    id: 'cinema',
    label: '映画字幕風',
    style: { fontId: 'hiragino-mincho', weight: 600, size: 58, color: '#ffffff', outlineColor: '#000000', outlineWidth: 2.5, shadow: 2, shadowColor: '#000000', shadowOpacity: 0.7, box: false, margin: 60 },
  },
  {
    id: 'handwriting',
    label: '手書き風',
    style: { fontId: 'klee', weight: 600, size: 68, color: '#ffffff', outlineColor: '#4a3423', outlineWidth: 6, shadow: 0, box: false, margin: 60 },
  },
];

export function getFont(fontId) {
  return FONTS.find(f => f.id === fontId) || FONTS[0];
}

export function getFace(style) {
  const font = getFont(style.fontId);
  const face = font.faces.reduce((a, b) => (Math.abs(b.weight - style.weight) < Math.abs(a.weight - style.weight) ? b : a));
  return { font, face };
}

export function applyPreset(style, presetId) {
  const preset = PRESETS.find(p => p.id === presetId);
  if (!preset) return normalizeStyle(style);
  return normalizeStyle({ ...DEFAULT_STYLE, position: style?.position ?? DEFAULT_STYLE.position, removePunctuation: style?.removePunctuation ?? true, ...preset.style, preset: presetId });
}

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const color = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);

export function normalizeStyle(input) {
  const s = { ...DEFAULT_STYLE, ...(input || {}) };
  const font = getFont(s.fontId);
  const { face } = getFace({ fontId: font.id, weight: clamp(s.weight, 100, 900, 700) });
  return {
    preset: typeof s.preset === 'string' ? s.preset : 'custom',
    fontId: font.id,
    weight: face.weight,
    size: clamp(s.size, 16, 240, DEFAULT_STYLE.size),
    color: color(s.color, DEFAULT_STYLE.color),
    outlineColor: color(s.outlineColor, DEFAULT_STYLE.outlineColor),
    outlineWidth: clamp(s.outlineWidth, 0, 30, DEFAULT_STYLE.outlineWidth),
    shadow: clamp(s.shadow, 0, 20, 0),
    shadowColor: color(s.shadowColor, DEFAULT_STYLE.shadowColor),
    shadowOpacity: clamp(s.shadowOpacity, 0, 1, DEFAULT_STYLE.shadowOpacity),
    box: !!s.box,
    boxColor: color(s.boxColor, DEFAULT_STYLE.boxColor),
    boxOpacity: clamp(s.boxOpacity, 0, 1, DEFAULT_STYLE.boxOpacity),
    boxPadding: clamp(s.boxPadding, 0, 60, DEFAULT_STYLE.boxPadding),
    position: ['bottom', 'top', 'middle'].includes(s.position) ? s.position : 'bottom',
    margin: clamp(s.margin, 0, 800, DEFAULT_STYLE.margin),
    removePunctuation: !!s.removePunctuation,
  };
}
