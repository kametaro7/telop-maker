import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chunkText } from '../public/shared/text.mjs';
import { tools } from './config.mjs';
import { analyzeAudio, normalizeAudio } from './media.mjs';
import { run } from './proc.mjs';

const RATE = 16000;
const PAD = 0.25; // 声の前後に残す余白（秒）
const MERGE_GAP = 0.8; // これより短い無音は詰めずに残す（秒）
const JOIN_GAP = 0.4; // 詰めた区間のあいだに入れる無音（秒）
// 声のある区間を決めるしきい値。既定の 0.5 だと小声や BGM の下の声を落とすので下げる
const VAD_THRESHOLD = 0.35;
// 幻聴かどうかを判断するときの「はっきりした声」のしきい値
const CLEAR_SPEECH_THRESHOLD = 0.5;

// 声のある区間を [開始秒, 終了秒] の配列で返す
export async function detectSpeech(wavPath, { signal, threshold = 0.5 } = {}) {
  const { stdout } = await run(tools.vadTool, ['-f', wavPath, '-vm', tools.vadModel, '-vt', String(threshold)], { signal, captureStdout: true });
  const regions = [];
  for (const m of stdout.matchAll(/start\s*=\s*([\d.]+)\s*,\s*end\s*=\s*([\d.]+)/g)) {
    regions.push([Number(m[1]) / 100, Number(m[2]) / 100]); // 単位は 10ms
  }
  return regions;
}

export function planRegions(speech, totalSec) {
  const regions = [];
  for (const [s0, e0] of speech) {
    const start = Math.max(0, s0 - PAD);
    const end = Math.min(totalSec || Infinity, e0 + PAD);
    const last = regions.at(-1);
    if (last && start - last.end < MERGE_GAP) last.end = Math.max(last.end, end);
    else regions.push({ start, end });
  }
  return regions;
}

function wavHeader(samples) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + samples * 2, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(samples * 2, 40);
  return h;
}

// 長い無音を詰めた WAV を作り、詰めた後の時刻 → 元の時刻の対応表を返す。
// whisper 内蔵の VAD を使うと単語ごとの時刻が元の時刻に戻されないため、自分で詰めて対応表を持つ
export async function writeSpeechWav(analysis, regions, outPath) {
  const pieces = [];
  const map = [];
  const gap = Buffer.alloc(Math.round(JOIN_GAP * RATE) * 2);
  let total = 0;
  for (const r of regions) {
    const s = Math.floor(r.start * RATE);
    const e = Math.min(analysis.sampleCount, Math.ceil(r.end * RATE));
    if (e <= s) continue;
    if (pieces.length) {
      pieces.push(gap);
      total += gap.length / 2;
    }
    map.push({ procStart: total / RATE, procEnd: (total + e - s) / RATE, origStart: s / RATE });
    pieces.push(analysis.buffer.subarray(analysis.dataOffset + s * 2, analysis.dataOffset + e * 2));
    total += e - s;
  }
  await fs.writeFile(outPath, Buffer.concat([wavHeader(total), ...pieces]));
  return map;
}

export function mapTime(map, t) {
  if (!map?.length) return t;
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map[mid].procStart <= t) lo = mid;
    else hi = mid - 1;
  }
  const m = map[lo];
  const regionEnd = m.origStart + (m.procEnd - m.procStart);
  if (t <= m.procEnd) return m.origStart + Math.max(0, t - m.procStart);
  const next = map[lo + 1];
  if (!next) return regionEnd;
  // 詰めた無音の中に落ちた時刻は、近いほうの区間の端に寄せる
  return t - m.procEnd < next.procStart - t ? regionEnd : next.origStart;
}

const isSpecial = tok => /^\[_.*\]$/.test(tok.text);

// whisper の JSON（latin1 で読み込んだもの）から、文字ごとの時刻つきのセグメントを作る。
// トークンは UTF-8 のバイト列の途中で切れることがあるので、まとめてから文字に直す
export function readSegments(json, segmentTime = t => t) {
  const segments = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const seg of json.transcription || []) {
    const start = segmentTime(seg.offsets.from / 1000);
    const end = Math.max(start, segmentTime(seg.offsets.to / 1000));
    const chars = [];
    let pending = [];
    const flush = force => {
      if (!pending.length) return;
      const bytes = Buffer.from(pending.map(t => t.text).join(''), 'latin1');
      let decoded;
      try {
        decoded = decoder.decode(bytes);
      } catch {
        if (!force && pending.length < 4) return;
        decoded = bytes.toString('utf8');
      }
      const list = Array.from(decoded);
      const t0 = pending[0].offsets.from / 1000;
      const t1 = Math.max(t0, pending.at(-1).offsets.to / 1000);
      const p = pending.reduce((sum, t) => sum + t.p, 0) / pending.length;
      list.forEach((ch, k) => chars.push({ ch, t0: t0 + ((t1 - t0) * k) / list.length, t1: t0 + ((t1 - t0) * (k + 1)) / list.length, p }));
      pending = [];
    };
    for (const tok of seg.tokens || []) {
      if (isSpecial(tok)) continue;
      pending.push(tok);
      flush(false);
    }
    flush(true);
    while (chars.length && /\s/.test(chars[0].ch)) chars.shift();
    while (chars.length && /\s/.test(chars.at(-1).ch)) chars.pop();
    if (chars.length) segments.push({ start, end, chars });
  }
  return segments;
}

// トークンの時刻を元の動画の時刻に直し、セグメントの範囲内で前後が逆転しないようにする
export function placeChars(seg, mode, toOriginal) {
  const { chars } = seg;
  if (mode === 'mapped') {
    for (const c of chars) {
      c.t0 = toOriginal(c.t0);
      c.t1 = toOriginal(c.t1);
    }
  } else if (mode === 'internal-vad') {
    // whisper 内蔵 VAD のときトークン時刻は詰めた後の時刻のまま。セグメント内で比例配分する
    const a = chars[0].t0;
    const b = chars.at(-1).t1;
    const k = b > a ? (seg.end - seg.start) / (b - a) : 0;
    for (const c of chars) {
      c.t0 = seg.start + (c.t0 - a) * k;
      c.t1 = seg.start + (c.t1 - a) * k;
    }
  }
  let last = seg.start;
  for (const c of chars) {
    c.t0 = Math.min(seg.end, Math.max(last, c.t0));
    c.t1 = Math.min(seg.end, Math.max(c.t0, c.t1));
    last = c.t0;
  }
}

// whisper が声のない所（BGM だけの所など）で作り出しがちな決まり文句
const HALLUCINATION = /ご視聴(いただき)?(まことに)?ありがとうございま|ご覧いただき(まことに)?ありがとうございま|チャンネル登録|高評価|字幕(作成|提供|制作)|^[(（【［[][^)）】］\]]*[)）】］\]]$|^[♪〜~]+$/;

export const isHallucinationText = text => HALLUCINATION.test(String(text).replace(/\s/g, ''));

// 決まり文句で、しかもはっきりした声がほとんどない所にあるセグメントだけを、幻聴として捨てる
export function dropHallucinations(segments, clearSpeech) {
  return segments.filter(seg => {
    if (!isHallucinationText(seg.chars.map(c => c.ch).join(''))) return true;
    const covered = clearSpeech.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, seg.end) - Math.max(a, seg.start)), 0);
    return covered / Math.max(0.01, seg.end - seg.start) >= 0.3;
  });
}

// 区切りの時刻を、近くでいちばん静かなところに寄せる
export function snapToQuiet(t, energy, rate = 100, windowSec = 0.3) {
  if (!energy?.length) return t;
  const center = Math.round(t * rate);
  const w = Math.round(windowSec * rate);
  let best = center;
  let bestValue = Infinity;
  for (let i = Math.max(2, center - w); i <= Math.min(energy.length - 3, center + w); i++) {
    const v = (energy[i - 2] + energy[i - 1] + energy[i] + energy[i + 1] + energy[i + 2]) / 5 + Math.abs(i - center) * 0.00002;
    if (v < bestValue) {
      bestValue = v;
      best = i;
    }
  }
  return best / rate;
}

// 区切りの時刻を、VAD が見つけた「声と声のすき間」に寄せる（トークンの時刻は数百ms ずれることがあるため）
export function snapToPause(t, pauses, { windowSec = 0.8, min = -Infinity, max = Infinity } = {}) {
  let best = null;
  let bestDist = Infinity;
  for (const p of pauses || []) {
    const mid = (p.start + p.end) / 2;
    const dist = Math.abs(mid - t);
    if (mid <= min || mid >= max) continue;
    if (dist <= windowSec + (p.end - p.start) / 2 && dist < bestDist) {
      best = mid;
      bestDist = dist;
    }
  }
  return best;
}

export const newCaptionId = () => `c_${crypto.randomBytes(5).toString('hex')}`;

export function buildCaptions(segments, { maxChars = 24, energy, energyRate = 100, duration, pauses } = {}) {
  const captions = [];
  for (const seg of segments) {
    const pieces = chunkText(seg.chars.map(c => c.ch).join(''), maxChars);
    const boundary = i => {
      const t = (seg.chars[i - 1].t1 + seg.chars[i].t0) / 2;
      return snapToPause(t, pauses, { min: seg.start + 0.2, max: seg.end - 0.2 }) ?? snapToQuiet(t, energy, energyRate);
    };
    pieces.forEach((piece, k) => {
      const cs = seg.chars.slice(piece.start, piece.end);
      const avg = cs.reduce((sum, c) => sum + c.p, 0) / cs.length;
      const min = Math.min(...cs.map(c => c.p));
      captions.push({
        id: newCaptionId(),
        start: k === 0 ? seg.start : boundary(piece.start),
        end: k === pieces.length - 1 ? seg.end : boundary(piece.end),
        text: piece.text,
        low: avg < 0.65 || min < 0.08,
      });
    });
  }
  return finalizeTiming(captions, duration);
}

export function finalizeTiming(captions, duration) {
  captions.sort((a, b) => a.start - b.start);
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    const next = captions[i + 1];
    c.start = Math.max(0, c.start);
    if (next && (c.end > next.start || next.start - c.end < 0.3)) c.end = next.start; // 重なりと短いすき間をなくす
    if (c.end - c.start < 0.6) c.end = next ? Math.max(c.end, Math.min(c.start + 0.6, next.start)) : c.start + 0.6;
    if (duration) c.end = Math.min(c.end, duration);
    c.start = Math.round(c.start * 1000) / 1000;
    c.end = Math.round(c.end * 1000) / 1000;
  }
  return captions.filter(c => c.end - c.start > 0.05);
}

export function applyReplacements(captions, rules = []) {
  const valid = rules.filter(r => r && typeof r.from === 'string' && r.from && typeof r.to === 'string');
  if (!valid.length) return captions;
  for (const c of captions) for (const r of valid) c.text = c.text.split(r.from).join(r.to);
  return captions;
}

export async function transcribe({ workDir, wavPath, duration, maxChars, signal, onProgress, onPartial }) {
  const normWav = path.join(workDir, 'audio-norm.wav');
  const speechWav = path.join(workDir, 'speech.wav');
  try {
    // 声が小さい動画だと VAD が声を見落とし、その部分が文字起こしに渡らない。音量をそろえた音声で判定・文字起こしする
    let source = wavPath;
    try {
      await normalizeAudio(wavPath, normWav, { signal });
      source = normWav;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
    const analysis = await analyzeAudio(source);

    let mode = 'plain';
    let input = source;
    let toOriginal = t => t;
    let pauses = [];
    let clearSpeech = null;
    if (tools.vadTool && tools.vadModel) {
      const speech = await detectSpeech(source, { signal, threshold: VAD_THRESHOLD });
      if (!speech.length) return [];
      clearSpeech = await detectSpeech(source, { signal, threshold: CLEAR_SPEECH_THRESHOLD });
      pauses = speech.slice(1).map(([start], i) => ({ start: speech[i][1], end: start })).filter(p => p.end - p.start >= 0.08);
      const map = await writeSpeechWav(analysis, planRegions(speech, duration), speechWav);
      toOriginal = t => mapTime(map, t);
      input = speechWav;
      mode = 'mapped';
    } else if (tools.vadModel) {
      mode = 'internal-vad';
    }

    const outBase = path.join(workDir, 'whisper');
    const args = ['-m', tools.model, '-l', 'ja', '-f', input, '-ojf', '-of', outBase, '-pp', '-np'];
    if (mode === 'internal-vad') args.push('--vad', '-vm', tools.vadModel, '-vt', String(VAD_THRESHOLD));
    await run(tools.whisper, args, {
      signal,
      onStderr: line => {
        const m = /progress\s*=\s*(\d+)%/.exec(line);
        if (m) onProgress?.(Number(m[1]) / 100);
      },
      onStdout: line => {
        const m = /^\[[^\]]*\]\s*(.+)$/.exec(line);
        if (m) onPartial?.(m[1].trim());
      },
    });

    const json = JSON.parse((await fs.readFile(`${outBase}.json`)).toString('latin1'));
    let segments = readSegments(json, mode === 'mapped' ? toOriginal : t => t);
    for (const seg of segments) placeChars(seg, mode, toOriginal);
    if (clearSpeech) segments = dropHallucinations(segments, clearSpeech);
    return buildCaptions(segments, { maxChars, energy: analysis.energy, energyRate: analysis.energyRate, duration, pauses });
  } finally {
    await fs.rm(speechWav, { force: true });
    await fs.rm(normWav, { force: true });
  }
}
