import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkText, displayText, wrapText } from '../public/shared/text.mjs';

// 半角は 5、全角は 10 の幅として測る
const width = ch => (/[\x20-\x7e]/.test(ch) ? 5 : 10);

test('短い文はそのまま1枚にする', () => {
  assert.deepEqual(chunkText('これがテストです', 26).map(p => p.text), ['これがテストです']);
});

test('長い文は文末の「。」で分ける', () => {
  assert.deepEqual(chunkText('こんにちは。今日はテロップメーカーのテストをしています。', 24).map(p => p.text), ['こんにちは。', '今日はテロップメーカーのテストをしています。']);
});

test('句読点がない長い文は「〜して」のあとで分ける', () => {
  const pieces = chunkText('この動画はパソコンの中だけで文字起こしをして字幕を自動でつけることができます。', 26).map(p => p.text);
  assert.deepEqual(pieces, ['この動画はパソコンの中だけで文字起こしをして', '字幕を自動でつけることができます。']);
});

test('分けた結果はどれも最大文字数以内で、元の文を失わない', () => {
  const text = '長い文章を話した時に字幕がきちんと2行に分かれるかどうかも確認したいので少し長めに話してみますね。';
  const pieces = chunkText(text, 26);
  assert.ok(pieces.length >= 2);
  for (const p of pieces) assert.ok(Array.from(p.text).length <= 26, p.text);
  assert.equal(pieces.map(p => p.text).join(''), text);
});

test('英数字の途中では分けない', () => {
  const pieces = chunkText('iPhone15Proで撮った4K動画ですよね', 12).map(p => p.text);
  assert.ok(pieces.some(p => p.includes('iPhone15Pro')), pieces.join('|'));
  assert.ok(pieces.some(p => p.includes('4K')), pieces.join('|'));
});

test('幅に収まるように行を分け、行頭に句読点や小さい文字を置かない', () => {
  const text = 'この動画はパソコンの中だけで文字起こしをして字幕を自動でつけることができます。';
  const lines = wrapText(text, 100, width);
  assert.ok(lines.length >= 4);
  assert.equal(lines.join(''), text);
  for (const line of lines) {
    assert.ok(Array.from(line).reduce((sum, ch) => sum + width(ch), 0) <= 100, line);
    assert.ok(!/^[、。っゃゅょー]/.test(line), line);
  }
});

test('収まる文は1行のまま、明示的な改行は残す', () => {
  assert.deepEqual(wrapText('こんにちは', 1000, width), ['こんにちは']);
  assert.deepEqual(wrapText('一行目\n二行目', 1000, width), ['一行目', '二行目']);
});

test('「、。」を消す設定では全角スペースにする', () => {
  assert.equal(displayText('こんにちは。今日は、晴れ。', { removePunctuation: true }), 'こんにちは　今日は　晴れ');
  assert.equal(displayText('こんにちは。', { removePunctuation: false }), 'こんにちは。');
});
