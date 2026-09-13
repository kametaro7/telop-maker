#!/bin/zsh
# テロップメーカーを起動します（このファイルをダブルクリック）
cd "$(dirname "$0")" || exit 1
PORT=8767
URL="http://127.0.0.1:$PORT/"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org からインストールしてください。"
  read -k 1 "?何かキーを押すと閉じます"
  exit 1
fi

# すでに起動していたら、ブラウザで開くだけにする
if curl -sf -o /dev/null "${URL}api/health"; then
  echo "テロップメーカーはもう起動しています。ブラウザで開きます。"
  open "$URL"
  exit 0
fi

(sleep 1.5; open "$URL") &
echo "テロップメーカーを起動しています…"
echo "使い終わったら、このウィンドウを閉じてください（アプリも終了します）。"
exec node server.mjs
