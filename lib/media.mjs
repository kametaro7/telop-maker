import fs from 'node:fs/promises';
import { tools } from './config.mjs';
import { run } from './proc.mjs';

const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);

// HDR 映像を普通の画面向け (SDR) に変換するフィルター
export const TONEMAP_SDR = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

function parseRate(rate) {
  if (!rate) return 0;
  const [n, d] = String(rate).split('/').map(Number);
  return d ? n / d : n || 0;
}

export async function checkFfmpeg() {
  const result = { ffmpeg: !!tools.ffmpeg, ffprobe: !!tools.ffprobe, ass: false };
  if (!tools.ffmpeg) return result;
  try {
    const { stdout } = await run(tools.ffmpeg, ['-hide_banner', '-filters'], { captureStdout: true });
    result.ass = /^\s*\S+\s+ass\s/m.test(stdout);
  } catch {
    // ffmpeg が起動できない（ライブラリ不足など）
    result.ffmpeg = false;
  }
  return result;
}

export async function probe(file) {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { captureStdout: true });
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find(s => s.codec_type === 'audio');
  if (!v) return null;

  const rotationRaw = v.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? Number(v.tags?.rotate || 0);
  const rotation = (((Math.round(Number(rotationRaw) / 90) * 90) % 360) + 360) % 360;
  const [sn, sd] = String(v.sample_aspect_ratio || '1:1').split(':').map(Number);
  const sar = sn > 0 && sd > 0 ? sn / sd : 1;
  let width = Math.abs(sar - 1) > 0.01 ? Math.round((v.width * sar) / 2) * 2 : v.width;
  let height = v.height;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];

  return {
    width,
    height,
    duration: Number(info.format?.duration) || Number(v.duration) || 0,
    rotation,
    sar,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30,
    codec: v.codec_name,
    pixFmt: v.pix_fmt,
    hdr: HDR_TRANSFERS.has(v.color_transfer),
    colorTransfer: v.color_transfer || null,
    colorPrimaries: v.color_primaries || null,
    colorSpace: v.color_space || null,
    bitrate: Number(v.bit_rate) || Number(info.format?.bit_rate) || 0,
    audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: Number(a.sample_rate) || 0 } : null,
  };
}

// ffmpeg の -progress 出力から進み具合 (0〜1) を取り出す
export function progressParser(duration, onProgress) {
  return line => {
    if (!onProgress) return;
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m && duration > 0) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
    else if (line === 'progress=end') onProgress(1);
  };
}

// 画素が正方形でない映像 (一部のビデオカメラ) を正しい横幅に直す
export function sarFilter(info) {
  return Math.abs((info.sar || 1) - 1) > 0.01 ? ['scale=trunc(iw*sar/2)*2:ih', 'setsar=1'] : [];
}

export async function extractAudio(src, out, { signal, duration, onProgress } = {}) {
  await run(tools.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    '-progress', 'pipe:1', '-nostats', out,
  ], { signal, onStdout: progressParser(duration, onProgress) });
}

// 声の小さい動画でも声のある区間を見つけられるように、音量を配信でよく使われる -16 LUFS にそろえる
export async function normalizeAudio(src, out, { signal } = {}) {
  await run(tools.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out,
  ], { signal });
}

// ブラウザで確実に再生できる軽いプレビュー動画 (短辺 720px の H.264 + AAC) を作る
export async function makePreview(src, info, out, { signal, onProgress } = {}) {
  const filters = [...sarFilter(info)];
  if (Math.min(info.width, info.height) > 720) {
    filters.push(info.width >= info.height ? 'scale=-2:720:flags=bicubic' : 'scale=720:-2:flags=bicubic');
  }
  filters.push(info.hdr ? TONEMAP_SDR : 'format=yuv420p');
  const gop = String(Math.max(1, Math.round(info.fps || 30)));
  // Mac のハードウェア (VideoToolbox) で作り、使えないときはソフトウェアで作る
  const encoders = [
    ['-c:v', 'h264_videotoolbox', '-b:v', '2500k', '-maxrate', '4M', '-bufsize', '8M', '-g', gop, '-profile:v', 'high'],
    ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', gop],
  ];
  for (const [i, encoder] of encoders.entries()) {
    try {
      await run(tools.ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...(i === 0 ? ['-hwaccel', 'videotoolbox'] : []), '-i', src,
        '-map', '0:v:0', ...(info.audio ? ['-map', '0:a:0'] : []),
        '-vf', filters.join(','),
        ...encoder,
        ...(info.audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
        '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', out,
      ], { signal, onStdout: progressParser(info.duration, onProgress) });
      return;
    } catch (err) {
      if (err.name === 'AbortError' || i === encoders.length - 1) throw err;
    }
  }
}

export async function makeThumb(src, info, out) {
  const at = Math.min(1, info.duration * 0.1);
  const filters = [...sarFilter(info), info.width >= info.height ? 'scale=-2:270' : 'scale=270:-2', info.hdr ? TONEMAP_SDR : 'format=yuv420p'];
  await run(tools.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', src,
    '-frames:v', '1', '-vf', filters.join(','), '-c:v', 'libwebp', '-quality', '80', out,
  ]);
}

// 16kHz モノラル WAV から、10ms ごとの音量 (区切り位置の調整用) と 20ms ごとの波形 (表示用) を作る
export async function analyzeAudio(wavPath) {
  const buf = await fs.readFile(wavPath);
  let off = 12;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      dataOff = off + 8;
      dataLen = Math.min(len, buf.length - dataOff);
      break;
    }
    off += 8 + len + (len % 2);
  }
  if (dataOff < 0) throw new Error('音声データを読み取れませんでした');

  const count = Math.floor(dataLen / 2);
  const sample = i => buf.readInt16LE(dataOff + i * 2);

  const ENERGY_WIN = 160; // 10ms
  const energy = new Float32Array(Math.ceil(count / ENERGY_WIN));
  for (let i = 0; i < energy.length; i++) {
    const start = i * ENERGY_WIN;
    const end = Math.min(count, start + ENERGY_WIN);
    let sum = 0;
    for (let k = start; k < end; k++) {
      const x = sample(k);
      sum += x * x;
    }
    energy[i] = Math.sqrt(sum / Math.max(1, end - start)) / 32768;
  }

  const PEAK_WIN = 320; // 20ms
  const raw = new Float32Array(Math.ceil(count / PEAK_WIN));
  let maxPeak = 0;
  for (let i = 0; i < raw.length; i++) {
    const start = i * PEAK_WIN;
    const end = Math.min(count, start + PEAK_WIN);
    let m = 0;
    for (let k = start; k < end; k++) {
      const x = Math.abs(sample(k));
      if (x > m) m = x;
    }
    raw[i] = m / 32768;
    if (raw[i] > maxPeak) maxPeak = raw[i];
  }
  // 小さい声も見えるように正規化して平方根で持ち上げる
  const peaks = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) peaks[i] = Math.round(Math.sqrt(maxPeak > 0 ? raw[i] / maxPeak : 0) * 255);

  return { energy, energyRate: 100, peaks, peakRate: 50, sampleCount: count, dataOffset: dataOff, buffer: buf };
}
