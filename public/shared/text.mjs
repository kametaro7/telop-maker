// 日本語テロップの区切り位置を決める処理（サーバーとブラウザの両方で使う）

const NO_LINE_START = new Set(Array.from('、。，．,.・：；:;！？!?‼⁉）)］]｝}〕〉》」』】〙〗〟’”ーｰ〜～…‥ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ々〻ゝゞヽヾ'));
const NO_LINE_END = new Set(Array.from('（(［[｛{〔〈《「『【〘〖〝‘“'));
const SENTENCE_END = new Set(Array.from('。．！？!?‼⁉'));
const CLAUSE_END = new Set(Array.from('、，,'));
const SPACES = new Set([' ', '　']);
const ALNUM = /[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/;
const FORBIDDEN = -40;

// この語の後ろは区切りやすい
const AFTER_BONUS = new Map([
  ['て', 3], ['で', 2], ['ので', 3], ['から', 3], ['けど', 3], ['けれど', 3], ['けれども', 3], ['のに', 3],
  ['し', 2], ['ば', 2], ['たら', 3], ['なら', 2], ['ても', 3], ['でも', 2],
  ['は', 2.5], ['が', 2.5], ['を', 2.5], ['に', 2], ['へ', 2], ['と', 2], ['も', 2], ['や', 1.5],
  ['より', 2], ['まで', 2], ['には', 2.5], ['では', 2.5], ['とは', 2.5],
  ['ね', 2.5], ['よ', 2.5], ['よね', 2.5],
]);

// この語で行を始めたくない（助詞・助動詞など）
const BEFORE_PENALTY = new Set([
  'は', 'が', 'を', 'に', 'へ', 'と', 'も', 'で', 'の', 'や', 'て', 'た', 'だ', 'か', 'ね', 'よ', 'な', 'さ', 'わ', 'ぞ',
  'ます', 'ました', 'ません', 'です', 'でした', 'ない', 'なかった', 'たい', 'れる', 'られる', 'せる', 'させる',
  'ている', 'てる', 'ちゃう', 'ん', 'けど', 'から', 'ので', 'まで', 'より', 'こと', 'もの', 'よう', 'そう', 'みたい', 'らしい',
  // Intl.Segmenter は活用語尾を細かく切るので、その手前でも区切らない（例: 話|した、な|って|る）
  'る', 'った', 'って', 'い', 'し', 'み', 'した', 'して', 'する', 'され',
]);

let segmenter;
function segmentWords(text) {
  try {
    segmenter ??= new Intl.Segmenter('ja', { granularity: 'word' });
    return Array.from(segmenter.segment(text), s => s.segment);
  } catch {
    return Array.from(text);
  }
}

// score[i] は chars[i] の直前で区切ったときの良さ。大きいほど自然な区切り
export function breakScores(text) {
  const chars = Array.from(text);
  const n = chars.length;
  const score = new Array(n + 1).fill(-4);

  const words = segmentWords(text);
  let pos = 0;
  for (let w = 0; w < words.length; w++) {
    pos += Array.from(words[w]).length;
    if (pos <= 0 || pos >= n) continue;
    let s = AFTER_BONUS.get(words[w]) || 0;
    if (BEFORE_PENALTY.has(words[w + 1])) s -= 3;
    score[pos] = s;
  }

  for (let i = 1; i < n; i++) {
    const prev = chars[i - 1];
    const next = chars[i];
    if (SENTENCE_END.has(prev) && !SENTENCE_END.has(next)) score[i] = Math.max(score[i], 8);
    else if (CLAUSE_END.has(prev)) score[i] = Math.max(score[i], 5);
    else if (SPACES.has(prev) && !SPACES.has(next)) score[i] = Math.max(score[i], 4.5);

    if (NO_LINE_START.has(next) || NO_LINE_END.has(prev) || (ALNUM.test(prev) && ALNUM.test(next))) score[i] = FORBIDDEN;
    else if (SPACES.has(next)) score[i] = Math.min(score[i], -2);
  }
  score[0] = 0;
  score[n] = 0;
  return { chars, score };
}

const trimSpaces = s => s.replace(/^[\s　]+|[\s　]+$/g, '');

// 1枚のテロップに収まる文字数ごとに自然な位置で分ける。{ text, start, end }（start/end は文字位置）の配列
export function chunkText(text, maxChars) {
  const { chars, score } = breakScores(text);
  const n = chars.length;
  if (n <= maxChars) return n ? [{ text: trimSpaces(text), start: 0, end: n }] : [];

  const target = n / Math.ceil(n / maxChars);
  const minChars = Math.min(5, Math.floor(maxChars / 3));
  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let q = 1; q <= n; q++) {
    for (let p = q - 1; p >= Math.max(0, q - maxChars * 2); p--) {
      if (best[p] === Infinity) continue;
      const len = q - p;
      // 1枚ごとの固定コストで、細かく分けすぎないようにする
      let cost = 4.5 + ((len - target) / maxChars) ** 2 * 10;
      if (len > maxChars) cost += 30 + (len - maxChars) * 4;
      if (len < minChars) cost += 8;
      if (q < n) cost -= score[q];
      if (best[p] + cost < best[q]) {
        best[q] = best[p] + cost;
        from[q] = p;
      }
    }
  }

  const pieces = [];
  for (let q = n; q > 0; q = from[q]) pieces.push({ start: from[q], end: q });
  return pieces
    .reverse()
    .map(({ start, end }) => ({ text: trimSpaces(chars.slice(start, end).join('')), start, end }))
    .filter(piece => piece.text);
}

// 決められた幅に収まるように行を分ける。measureChar(ch) は1文字の幅
export function wrapText(text, maxWidth, measureChar) {
  const lines = [];
  for (const para of String(text).split('\n')) lines.push(...wrapParagraph(para, maxWidth, measureChar));
  return lines;
}

function wrapParagraph(text, maxWidth, measureChar) {
  const { chars, score } = breakScores(text);
  const n = chars.length;
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + measureChar(chars[i]);

  const widthOf = (p, q) => {
    while (p < q && SPACES.has(chars[p])) p++;
    while (q > p && SPACES.has(chars[q - 1])) q--;
    return prefix[q] - prefix[p];
  };
  const total = widthOf(0, n);
  if (!trimSpaces(text)) return [];
  if (total <= maxWidth) return [trimSpaces(text)];

  const target = total / Math.ceil(total / maxWidth);
  const best = new Array(n + 1).fill(Infinity);
  const from = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let q = 1; q <= n; q++) {
    for (let p = q - 1; p >= 0; p--) {
      if (best[p] === Infinity) continue;
      const w = widthOf(p, q);
      if (w > maxWidth && q - p > 1) break;
      let cost = 10 + ((w - target) / target) ** 2 * 8;
      if (q < n) cost -= score[q];
      if (best[p] + cost < best[q]) {
        best[q] = best[p] + cost;
        from[q] = p;
      }
    }
  }

  const lines = [];
  for (let q = n; q > 0; q = from[q]) lines.push(trimSpaces(chars.slice(from[q], q).join('')));
  return lines.reverse().filter(Boolean);
}

// 「、。」を消す設定のときの表示用テキスト
export function displayText(text, { removePunctuation = false } = {}) {
  let t = String(text ?? '').replace(/\r\n?/g, '\n');
  if (removePunctuation) t = t.replace(/[、，。．]+/g, '　').replace(/　{2,}/g, '　');
  return t
    .split('\n')
    .map(trimSpaces)
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}
