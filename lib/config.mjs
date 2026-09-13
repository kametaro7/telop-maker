import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT) || 8767;
// プレビュー確認用に環境変数で置き場所を変えられるようにしておく
export const DATA_DIR = path.resolve(process.env.TELOP_DATA_DIR || path.join(APP_DIR, 'data'));
export const EXPORT_DIR = path.resolve(process.env.TELOP_EXPORT_DIR || path.join(APP_DIR, '書き出し'));

const HOME = os.homedir();

function isFile(p) {
  try {
    return !!p && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const firstExisting = (...candidates) => candidates.find(isFile) || null;
const which = cmd => firstExisting(...(process.env.PATH || '').split(':').filter(Boolean).map(dir => path.join(dir, cmd)));

// 通常の Homebrew ffmpeg は字幕を描けないので ffmpeg-full を優先する
const ffmpeg = firstExisting(process.env.FFMPEG, '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg', '/usr/local/opt/ffmpeg-full/bin/ffmpeg') || which('ffmpeg');

export const tools = {
  ffmpeg,
  ffprobe: (ffmpeg && firstExisting(path.join(path.dirname(ffmpeg), 'ffprobe'))) || which('ffprobe'),
  whisper: firstExisting(process.env.WHISPER_CLI, '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli') || which('whisper-cli'),
  vadTool: firstExisting(process.env.WHISPER_VAD_CLI, '/opt/homebrew/bin/whisper-vad-speech-segments', '/usr/local/bin/whisper-vad-speech-segments') || which('whisper-vad-speech-segments'),
  model: firstExisting(process.env.WHISPER_MODEL, path.join(HOME, 'whisper-models', 'ggml-large-v3-turbo.bin')),
  vadModel: firstExisting(process.env.WHISPER_VAD_MODEL, path.join(HOME, 'whisper-models', 'ggml-silero-v5.1.2.bin')),
};
