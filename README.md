# MovieEdit

ブラウザ上で動画をタイムラインに並べ、[HeyGen HyperFrames](https://github.com/heygen-com/hyperframes) で**決定論的な MP4** にレンダリングする動画編集アプリです。

HyperFrames は「HTML を書く → 動画になる」フレームワーク。MovieEdit は、
その HyperFrames を**エンジン**として使い、その手前に

- **大容量ファイルに耐えるアップロード基盤**（チャンク分割・レジューム対応）
- クリップ／テキスト／音声を並べる**タイムライン編集 UI**
- ブラウザプレビューと **MP4 レンダリング／ダウンロード**

を載せたものです。

---

## なぜこの構成か（大容量アップロード）

動画素材は数 GB になり得るため、アップロードを最重要の設計ポイントにしています。

- **チャンク分割アップロード**: ブラウザがファイルを分割し、順番に送信。各チャンクのボディはサーバ側でそのままディスクへ書き出すため、**ファイル全体をメモリに載せません**（20GB でも消費 RAM は数 MB）。
- **レジューム**: 回線断・リロード後も、サーバに「何バイトまで確実に受信したか」を問い合わせて途中から再開。
- **壊れない書き込み**: 各チャンクは正確なバイトオフセット（`flags:"r+"`）に書き込むので、途中で失敗したチャンクを再送しても末尾が壊れず上書きされます。確定カーソルはチャンクが**完全に**着地してから進めます。

このプロトコルは、本番では **S3 マルチパート**や **tus** にそのまま置き換え可能です（クライアント契約は不変）。

---

## 必要環境

| 依存 | 用途 | 備考 |
| --- | --- | --- |
| Node.js 22+ | サーバ／CLI | 必須 |
| Chromium / Chrome | HyperFrames のフレームキャプチャ | `PUPPETEER_EXECUTABLE_PATH` で任意のバイナリを指定可 |
| ffmpeg / ffprobe | エンコード・メディア解析 | 未指定なら同梱の `ffmpeg-static` / `ffprobe-static`、無ければ PATH 上のものを使用 |

ffmpeg/Chromium は環境変数で差し替えられるため、素の `npm install` が
バイナリのダウンロードで失敗するような制限ネットワークでも動きます
（`ffmpeg-static` は `optionalDependencies` なので、取得に失敗してもインストール自体は成功します）。

---

## セットアップ & 起動

```bash
npm install

# 任意: 既存の Chromium / システム ffmpeg を使う場合
export PUPPETEER_EXECUTABLE_PATH=/opt/pw-browsers/chromium   # 例
# export HYPERFRAMES_FFMPEG_PATH=/usr/bin/ffmpeg
# export HYPERFRAMES_FFPROBE_PATH=/usr/bin/ffprobe

npm start                 # http://localhost:4000
```

設定は環境変数（`.env.example` 参照）。主なもの:

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `PORT` | 4000 | HTTP ポート |
| `MAX_UPLOAD_BYTES` | 20 GB | アップロード上限 |
| `UPLOAD_CHUNK_BYTES` | 8 MB | チャンクサイズ |
| `PUPPETEER_EXECUTABLE_PATH` | (puppeteer 既定) | レンダリング用 Chromium |
| `HYPERFRAMES_FFMPEG_PATH` / `HYPERFRAMES_FFPROBE_PATH` | 同梱 static → PATH | ffmpeg/ffprobe |

---

## 使い方（編集フロー）

1. **New project** でプロジェクト（解像度・fps）を作成
2. 左パネルに動画をドラッグ＆ドロップ → チャンクアップロード（進捗バー表示）
3. アップロード済み素材の **+ Timeline** でクリップを追加、**+ Text** でテロップを追加
4. 各要素の `start` / `duration` / `track` などを編集
5. **▶ Preview** でブラウザ内プレビュー（別タブ）
6. **⬇ Render MP4** で HyperFrames レンダリング → 完了後にダウンロード

---

## HyperFrames との統合

`server/composition.js` が、プロジェクト（JSON のタイムライン）を
**HyperFrames 準拠の HTML コンポジション**に変換します。

- ルート要素に `data-composition-id` / `data-width` / `data-height`
- 各要素に `class="clip"` と `data-start` / `data-duration` / `data-track-index`
- `<video>` は `muted playsinline`、音声は別 `<audio>` で同期
- 一時停止状態の GSAP タイムラインを `window.__timelines[id]` に登録（可視性はフレームワークが管理）
- GSAP はコンポジションに**ローカル同梱**（CDN 非依存で決定論的レンダリング）
- 同じ HTML は `?preview=1` 付きで開くとブラウザプレビューとして動作（レンダリング時は不活性）

レンダリングは `server/render.js` が `@hyperframes/producer` の
`createRenderJob` → `executeRenderJob` を呼び出し、Chromium でフレームを
キャプチャし ffmpeg で MP4 にエンコードします。素材は巨大になり得るため、
コンポジションディレクトリへは**シンボリックリンク**で参照します（コピーしない）。

生成物のレイアウト（すべて gitignore、肥大化するためコミットしない）:

```
assets/           アップロード済み素材（+ assets/tmp: アップロード中の一時ファイル）
data/             プロジェクト/アセットのメタデータ（JSON）
compositions/<id> 生成された HyperFrames コンポジション（index.html + media シンボリックリンク）
output/           レンダリング済み MP4
```

---

## API 概要

```
# アップロード（チャンク／レジューム）
POST   /api/uploads                    { filename, size, mimeType } -> { uploadId, received, chunkBytes }
GET    /api/uploads/:id                -> { received, size }
PUT    /api/uploads/:id?offset=N       <生バイナリのチャンク>       -> { received }
POST   /api/uploads/:id/complete       -> { asset }

# 素材・プロジェクト・要素
GET    /api/assets
GET/POST/PATCH/DELETE  /api/projects[/:id]
POST/PATCH/DELETE      /api/projects/:id/elements[/:elId]

# プレビュー・レンダリング
GET    /api/projects/:id/preview       -> 302 /compositions/:id/index.html?preview=1
POST   /api/projects/:id/render        { quality, format } -> { render }
GET    /api/renders/:id                -> { render: { status, progress, outputFile, ... } }
GET    /output/:file                   レンダリング済み MP4 のダウンロード
```

---

## 本番へのスケール（次の一手）

MVP はローカルディスク + 逐次レンダリング（同時 1 本）です。拡張ポイント:

- **ストレージ**: `assets/` を S3/GCS へ。アップロードは S3 マルチパート or tus に置換（プロトコル互換）。
- **メタデータ**: `server/store.js`（JSON ファイル）を Postgres / Supabase へ。差し替え対象はこのファイルの約 10 関数のみ。
- **分散レンダリング**: `@hyperframes/producer` の `plan` / `renderChunk` / `assemble` を使い、長尺をチャンク分割してワーカーへ。`server/render.js` のキューをジョブキュー（BullMQ 等）へ。
- **フォーマット**: producer は `mp4` / `webm`(アルファ) / `mov`(ProRes) / `gif` / `png-sequence` に対応。`render` の `format` で切替可能。

---

## ライセンス / クレジット

- 動画レンダリングエンジン: [HeyGen HyperFrames](https://github.com/heygen-com/hyperframes)（Apache-2.0）
