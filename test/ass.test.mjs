import assert from 'node:assert/strict';
import test from 'node:test';
import { assColor, assTime, buildAss, buildSrt, escapeAssText } from '../lib/ass.mjs';
import { applyPreset, DEFAULT_STYLE, normalizeStyle } from '../public/shared/fonts.mjs';
import { lineBottoms, playResFor } from '../public/shared/layout.mjs';

test('色を ASS の &HAABBGGRR にする', () => {
  assert.equal(assColor('#ff8000'), '&H000080FF');
  assert.equal(assColor('#000000', 0.6), '&H66000000');
  assert.equal(assColor('#ffffff', 1, 0.75), '&H00BFBFBF');
});

test('時刻を H:MM:SS.cc にする', () => {
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(3723.456), '1:02:03.46');
});

test('字幕の座標は短い辺を 1080 にそろえる', () => {
  assert.deepEqual(playResFor(3840, 2160), { w: 1920, h: 1080 });
  assert.deepEqual(playResFor(1080, 1920), { w: 1080, h: 1920 });
});

test('下寄せでは最後の行（黒帯なら帯）の下端が余白の位置に来る', () => {
  const style = normalizeStyle(DEFAULT_STYLE); // size 64, margin 56
  assert.deepEqual(lineBottoms(style, 2, { w: 1920, h: 1080 }), [960, 1024]);
  const band = applyPreset(DEFAULT_STYLE, 'band'); // size 56, padding 14, margin 48
  assert.deepEqual(lineBottoms(band, 2, { w: 1920, h: 1080 }), [934, 1018]);
});

test('ASS は行ごとに位置を指定したイベントになる', () => {
  const style = normalizeStyle(DEFAULT_STYLE);
  const ass = buildAss({ playRes: { w: 1920, h: 1080 }, style, captions: [{ start: 1, end: 2.5, lines: ['一行目', '二行目{x}'] }] });
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /Style: Default,Hiragino Sans,64,&H00FFFFFF,&H000000FF,&H00000000,&H66000000,700,/);
  assert.ok(ass.includes('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an2\\pos(960,960)}一行目'), ass);
  assert.ok(ass.includes('{\\an2\\pos(960,1024)}二行目｛x｝'), ass);
});

test('ASS で特別な意味を持つ文字は全角に置き換える', () => {
  assert.equal(escapeAssText('a{b}\\N'), 'a｛b｝＼N');
});

test('SRT を作る（空や長さ0のテロップは入れない）', () => {
  assert.equal(
    buildSrt([{ start: 1.2, end: 3, lines: ['こんにちは', '世界'] }, { start: 4, end: 4, lines: ['x'] }, { start: 5, end: 6, lines: [] }]),
    '1\n00:00:01,200 --> 00:00:03,000\nこんにちは\n世界\n',
  );
});
