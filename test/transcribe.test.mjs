import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCaptions, dropHallucinations, finalizeTiming, isHallucinationText, mapTime, placeChars, planRegions, readSegments } from '../lib/transcribe.mjs';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('声の区間に余白を足し、短いすき間はつなげる', () => {
  assert.deepEqual(planRegions([[1, 2], [2.5, 3], [5, 6]], 10), [{ start: 0.75, end: 3.25 }, { start: 4.75, end: 6.25 }]);
});

test('無音を詰めた後の時刻を元の時刻に戻す', () => {
  const map = [{ procStart: 0, procEnd: 2, origStart: 5 }, { procStart: 2.4, procEnd: 4.4, origStart: 10 }];
  near(mapTime(map, 1), 6);
  near(mapTime(map, 2.1), 7); // 詰めた無音の中（前の区間に近い）
  near(mapTime(map, 2.35), 10); // 詰めた無音の中（次の区間に近い）
  near(mapTime(map, 3), 10.6);
  near(mapTime(map, 9), 12);
});

test('UTF-8 の途中で切れたトークンもつなげて文字にする', () => {
  const bytes = Buffer.from('漢字です', 'utf8');
  const tok = (b, from, to, p = 0.9) => ({ text: b.toString('latin1'), offsets: { from, to }, p });
  const json = {
    transcription: [{
      offsets: { from: 1000, to: 3000 },
      tokens: [
        { text: '[_BEG_]', offsets: { from: 1000, to: 1000 }, p: 1 },
        tok(bytes.subarray(0, 2), 1000, 1200),
        tok(bytes.subarray(2, 6), 1200, 2000),
        tok(bytes.subarray(6), 2000, 3000, 0.5),
        { text: '[_TT_150]', offsets: { from: 3000, to: 3000 }, p: 1 },
      ],
    }],
  };
  const [seg] = readSegments(json);
  assert.equal(seg.chars.map(c => c.ch).join(''), '漢字です');
  near(seg.start, 1);
  near(seg.end, 3);
  near(seg.chars[0].t0, 1);
  near(seg.chars[2].t0, 2);
});

test('whisper 内蔵 VAD の時刻はセグメントの範囲に比例配分する', () => {
  const seg = { start: 1.95, end: 6.01, chars: [{ ch: 'あ', t0: 0.05, t1: 1, p: 1 }, { ch: 'い', t0: 1, t1: 3.99, p: 1 }] };
  placeChars(seg, 'internal-vad', t => t);
  near(seg.chars[0].t0, 1.95);
  near(seg.chars[1].t1, 6.01);
});

test('長いセグメントを分けたときの区切りの時刻は文字の時刻から決まる', () => {
  const text = 'こんにちは。今日はテロップメーカーのテストをしています。';
  const list = Array.from(text);
  const n = list.length;
  const chars = list.map((ch, i) => ({ ch, t0: 1 + (i * 4) / n, t1: 1 + ((i + 1) * 4) / n, p: 0.95 }));
  const captions = buildCaptions([{ start: 1, end: 5, chars }], { maxChars: 24 });
  assert.deepEqual(captions.map(c => c.text), ['こんにちは。', '今日はテロップメーカーのテストをしています。']);
  near(captions[0].start, 1);
  near(captions[0].end, captions[1].start);
  near(captions[0].end, 1 + (6 * 4) / n, 0.001);
  near(captions[1].end, 5);
  assert.equal(captions.some(c => c.low), false);
});

test('短いすき間を詰め、重なりをなくし、短すぎる表示は伸ばす', () => {
  const caps = finalizeTiming([
    { start: 0, end: 1.9, text: 'a' },
    { start: 2.0, end: 2.1, text: 'b' },
    { start: 2.2, end: 4, text: 'c' },
    { start: 5, end: 5.2, text: 'd' },
  ], 10);
  assert.deepEqual(caps.map(c => [c.start, c.end]), [[0, 2], [2, 2.2], [2.2, 4], [5, 5.6]]);
});

test('はっきりした声がない所の決まり文句（whisper の幻聴）だけを捨てる', () => {
  const seg = (text, start, end) => ({ start, end, chars: Array.from(text).map(ch => ({ ch, t0: start, t1: end, p: 0.9 })) });
  const clearSpeech = [[0, 5]];
  const kept = dropHallucinations([
    seg('こんにちは', 1, 2),
    seg('ご視聴ありがとうございました', 1, 3), // 声がはっきりある所なので本当に言っている
    seg('ご視聴ありがとうございました。', 8, 10), // BGM だけの所
    seg('字幕を自動でつけます', 8, 10),
  ], clearSpeech);
  assert.deepEqual(kept.map(s => `${s.chars.map(c => c.ch).join('')}@${s.start}`), ['こんにちは@1', 'ご視聴ありがとうございました@1', '字幕を自動でつけます@8']);
  assert.equal(isHallucinationText('（拍手）'), true);
  assert.equal(isHallucinationText('チャンネル登録よろしくお願いします'), true);
  assert.equal(isHallucinationText('今日はいい天気ですね'), false);
});
