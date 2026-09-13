# テロップメーカー

動画の話し声を **この Mac の中だけで** 文字起こしして、テロップ入りの動画を作るアプリです。インターネットに動画を送らず、料金もかかりません。

## 使い方

1. `起動.command` をダブルクリック（ブラウザで http://127.0.0.1:8767/ が開きます）
2. 動画をドラッグ＆ドロップ → 自動で文字起こし
3. 右の「テロップ」タブで文字とタイミングを直す（下のタイムラインで帯の端をドラッグしても調整できます）
4. 「デザイン」タブで見た目を選ぶ
5. 「書き出し」タブでテロップ入りの MP4、または字幕ファイル（SRT）を保存

書き出したファイルは `書き出し/` フォルダに入ります。取り込んだ動画と編集内容は `data/` に保存されます（アプリの一覧から削除できます）。

### 便利な操作

| 操作 | キー |
| --- | --- |
| 再生 / 一時停止 | スペース |
| 1秒戻る / 進む（Shift で 5 秒） | ← / → |
| 元に戻す / やり直す | ⌘Z / ⇧⌘Z |
| まとめて置き換え | ⌘F |
| カーソル位置でテロップを分割 | ⌘Enter（文字の入力中） |
| テロップの中で改行 | Enter |

- 「要確認」マークは、聞き取りに自信がない部分です。
- よく聞き間違える名前などは「言葉の置き換え辞書」に登録すると、次からの文字起こしで自動で直ります。
- 「仕上がりを確認」を押すと、書き出しと同じ仕組みでいまの場面を1コマ描いて見せます。

## 使っているもの

- 文字起こし: [whisper.cpp](https://github.com/ggml-org/whisper.cpp)（`whisper-cli`）＋ `~/whisper-models/ggml-large-v3-turbo.bin`
- 声のある区間の検出: `whisper-vad-speech-segments` ＋ `~/whisper-models/ggml-silero-v5.1.2.bin`
- 動画の変換・テロップの焼き込み: `ffmpeg-full`（libass）
- サーバーと画面: Node.js（追加パッケージなし）

## 準備（別の Mac で使うとき）

Node.js 20 以上と Homebrew が必要です。

```bash
brew install ffmpeg-full whisper-cpp
mkdir -p ~/whisper-models
curl -L -o ~/whisper-models/ggml-large-v3-turbo.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
curl -L -o ~/whisper-models/ggml-silero-v5.1.2.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin
```

- 足りないものがあると、最初の画面に案内が出ます。
- モデルの場所は環境変数 `WHISPER_MODEL` / `WHISPER_VAD_MODEL` で変えられます。
- ffmpeg-full を入れると依存ライブラリ（x265 など）が更新され、通常の `ffmpeg` が起動しなくなることがあります。そのときは `brew upgrade ffmpeg` で直ります。
- 取り込んだ動画と編集内容（`data/`）、書き出したファイル（`書き出し/`）は Git に含めていません。

## 開発

```bash
npm test
```

- `server.mjs` … ローカルサーバー（127.0.0.1 だけで待ち受け）
- `lib/` … 文字起こし・動画処理・書き出し
- `public/` … 画面。`public/shared/` はサーバーと画面の両方で使う（行分け・フォント・配置の計算）

プレビューの文字の大きさと位置は、libass と同じ計算（フォントサイズ = usWinAscent + usWinDescent の高さ）で描いているので、書き出した動画と一致します。
