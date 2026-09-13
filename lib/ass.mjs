import { getFace } from '../public/shared/fonts.mjs';
import { lineBottoms } from '../public/shared/layout.mjs';

const hex2 = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
const num = n => String(Math.round(n * 100) / 100);
const pad2 = n => String(n).padStart(2, '0');

// '#rrggbb' と不透明度を ASS の &HAABBGGRR にする。gain は HDR 書き出しで白を明るくしすぎないための係数
export function assColor(hex, opacity = 1, gain = 1) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '') || [null, 'ff', 'ff', 'ff'];
  const [r, g, b] = [m[1], m[2], m[3]].map(h => parseInt(h, 16) * gain);
  return `&H${hex2(255 * (1 - opacity))}${hex2(b)}${hex2(g)}${hex2(r)}`;
}

export function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${pad2(Math.floor(cs / 6000) % 60)}:${pad2(Math.floor(cs / 100) % 60)}.${pad2(cs % 100)}`;
}

// ASS で特別な意味を持つ文字を、見た目が近い全角文字に置き換える
export function escapeAssText(text) {
  return String(text).replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/[\r\n]+/g, ' ');
}

// captions: [{ start, end, lines: [...] }]。行ごとに位置を指定したイベントにする（プレビューと同じ配置になる）
export function buildAss({ playRes, style, captions, colorGain = 1 }) {
  const { font, face } = getFace(style);
  const box = !!style.box;
  const styleFields = [
    'Default',
    font.family,
    num(style.size),
    assColor(style.color, 1, colorGain),
    '&H000000FF',
    box ? assColor(style.boxColor, style.boxOpacity, colorGain) : assColor(style.outlineColor, 1, colorGain),
    assColor(style.shadowColor, style.shadowOpacity, colorGain),
    face.weight,
    0, 0, 0, 100, 100, 0, 0,
    box ? 3 : 1,
    num(box ? style.boxPadding : style.outlineWidth),
    num(style.shadow),
    2, 0, 0, 0, 1,
  ];
  const out = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playRes.w}`,
    `PlayResY: ${playRes.h}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleFields.join(',')}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const cx = num(playRes.w / 2);
  for (const cap of captions) {
    const lines = (cap.lines || []).map(l => String(l)).filter(Boolean);
    if (!lines.length || !(cap.end > cap.start)) continue;
    const bottoms = lineBottoms(style, lines.length, playRes);
    lines.forEach((line, i) => {
      out.push(`Dialogue: 0,${assTime(cap.start)},${assTime(cap.end)},Default,,0,0,0,,{\\an2\\pos(${cx},${num(bottoms[i])})}${escapeAssText(line)}`);
    });
  }
  return `${out.join('\n')}\n`;
}

export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad2(Math.floor(ms / 3600000))}:${pad2(Math.floor(ms / 60000) % 60)}:${pad2(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, '0')}`;
}

export function buildSrt(captions) {
  return captions
    .map(c => ({ ...c, lines: (c.lines || []).map(String).filter(Boolean) }))
    .filter(c => c.lines.length && c.end > c.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join('\n')}\n`)
    .join('\n');
}
