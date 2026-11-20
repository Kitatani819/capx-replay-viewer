# デザインを手伝ってくれる人へ

CaP-X Replay Viewer は、ロボットの評価結果と、失敗した試行の中身（動画・モデルの入出力・生成されたコード・API の呼び出し）を見るための画面です。お願いしたいのは**見た目だけ**です。**画面の構成、情報の並び、操作の流れは今のまま**にしてください。データの処理や記録の仕組みも変更しません。

対象は、ライト・ダーク両方の色と背景、文字（フォント・大きさ・太さ）、余白、ボタン、スイッチ、状態を示すチップ、表、カードです。後述する共有用の HTML 評価一覧も含め、同じ見た目にそろえたいです。

GPU は要りません。GMO のアカウントがなくても、手元の PC で本物と同じ画面をデモの記録で動かせます。チームのメンバーは、本物の記録でも使えます（1 の最後の節）。このページのコマンドは Linux・macOS の Bash 向けです。Windows では WSL/Ubuntu の中で同じ手順を実行してください。

## 1. 動かす

必要なもの：Python 3.10〜3.12（venv と pip を使えるもの）、Node.js 20 以上と npm、Git、初回のパッケージ取得用のインターネット接続。以下は Python 3.12 の例です。3.10 / 3.11 を使う場合は、最初の `python3.12` をそのコマンド名に読み替えてください。

```bash
git clone https://github.com/Kitatani819/capx-replay-viewer.git
cd capx-replay-viewer
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
cd web-ui
npm ci
npm run build
cd ..
bash Start-Replay.sh
```

同じ PC のブラウザーで http://127.0.0.1:8390/traces を開きます。同梱のデモの記録（GMO で記録した本物の試行）が見られます。サーバーを止めるには、そのターミナルで `Ctrl+C` を押してください。

ランチャーは初回に専用の Python 環境も準備します。このページで作る `.venv` は、デモ生成・HTML 一覧の生成・テストに使います。以降のコマンドは、特に指定がなければリポジトリ直下で `.venv` を有効にした状態で実行します。新しいターミナルでは、リポジトリ直下に移動して `source .venv/bin/activate` を実行してください。

### 評価一覧・比較やカメラ 3 台の画面も見たいとき

先ほどのサーバーを `Ctrl+C` で止めてから、次を実行します。

```bash
python scripts/make_replay_demo.py --out outputs/demo --evals --cameras 3
bash Start-Replay.sh --trace-root outputs/demo/traces --runner-root outputs/demo/runner
```

評価一覧は http://127.0.0.1:8390/evals です。このデモは合成データで、基準版と改良版の比較、失敗の内訳、カメラ 3 台の動画を確認できます。生成コマンドは既存の出力を上書きしません。`outputs/demo` が作成済みなら再生成せず、その下の起動コマンドだけを実行してください。

8390 が別のサーバーで使われている場合は、起動コマンドに `--port 8391` など空いているポートを指定し、ブラウザーの URL も同じポートに変えてください。

### 共有用の HTML 評価一覧も見たいとき

これもデザインの対象です。React の画面と同じ色・文字・余白・表・状態表示にそろえてください。デモを生成した後、サーバーを止めたターミナルで次を実行します。

```bash
python -m capx_trace_recorder index --root outputs/demo/traces
```

生成された `outputs/demo/traces/index.html` をブラウザーで開きます。CSS を含む 1 ファイルなので、一覧の閲覧にサーバーは要りません。「開く」のリンク先は既定で http://127.0.0.1:8390 の Viewer です。試行の詳細まで見るときは、上のデモ用サーバーも起動してください。

### 見た目を直しながら確認するとき（保存すると自動で反映されます）

先に合成デモを生成し、8390 のサーバーを止めてから、リポジトリ直下でターミナルを 2 つ使います。1 つ目は API 用です。

```bash
bash Start-Replay.sh --port 8290 --trace-root outputs/demo/traces --runner-root outputs/demo/runner
```

2 つ目は画面の開発サーバー用です。

```bash
cd web-ui
npm run dev -- --port 5173 --strictPort
```

ブラウザーで http://localhost:5173/evals または http://localhost:5173/traces を開きます。画面は 5173 から配信され、`/api` は `web-ui/vite.config.ts` の設定で 8290 の API へ転送されます。両方のサーバーを起動したまま作業してください。ポートが使用中なら、そこで動いている自分のサーバーを止めてから起動します。

### チームのメンバーなら、本物の記録で使う（おすすめ）

GMO のアカウントがある人は、チームが実際に回した評価と試行で使えます。デモより量が多く、実際に困る場面（長いログ、失敗の多い評価など）が見られるので、デザインを考えるにはこちらがおすすめです。

用意するもの：公式チュートリアルどおりの SSH 設定（`~/.ssh/config` の `Host gmo`）。`ssh gmo` でパスワードを聞かれずに入れれば準備できています。

```bash
bash Start-Replay.sh --from-gmo
```

起動時に自分の記録を取り込んでから、http://127.0.0.1:8390/traces が開きます。評価一覧（/evals）には、チーム全員の評価が出ます。記録が多いと、最初の起動に少し時間がかかります。

見た目を直しながら本物の記録で確認するときは、上の 2 つのターミナルのうち 1 つ目を次に替えます。2 つ目（`npm run dev`）はそのままです。

```bash
bash Start-Replay.sh --from-gmo --port 8290
```

共有用の HTML 評価一覧の実物は、GMO の `~/shared-storage/traces/index.html` にあります。手元に持ってきてブラウザーで開けます。

```bash
scp gmo:shared-storage/traces/index.html ./capx-evals.html
```

## 2. 見てほしい画面

| 画面 | URL | 何を見るための画面か |
| --- | --- | --- |
| 評価一覧 | `/evals` | 評価ごとの成功率と、基準からの変化。成功率の推移のグラフ |
| 評価の比較 | `/evals/<評価ID>` | 基準と改良版の、課題×seed ごとの成否。悪化した試行と失敗の原因（失敗の内訳） |
| 試行 | `/traces?run=…&episode=…` | 1 回の試行の要約（終わり方・最初のエラー）、動画（複数カメラ）、1 行ずつの処理の一覧、モデルの入出力 |
| 共有用の HTML 評価一覧 | `outputs/demo/traces/index.html` | Viewer を起動せず読める評価の一覧。React の画面と同じ見た目にそろえる |

一番大事なのは、「どこで失敗したか、なぜか」にすぐたどり着けることです。

## 3. どこを触ればいいか

- 画面：`web-ui/src/`（React / TypeScript）
  - 評価一覧と比較：`evals/`
  - 試行：`trace/`
- 見た目：Tailwind と、次の CSS ファイル
  - `web-ui/src/trace/replay.css`
  - `web-ui/src/trace/trialSummary.css`
  - `web-ui/src/trace/sideBySide.css`
  - `web-ui/src/evals/failureBreakdown.css` など
- 共有用の HTML 評価一覧：`capx_trace_recorder/eval_index.py`（CSS はこのファイル内の `_CSS` にインラインで定義）
- 画面の言葉（ラベル）は、テストが使っているものがあります。変えるときは相談してください。

## 4. 出す前に

```bash
python -m pytest -q
cd web-ui
npm run test:trace
npx tsc --noEmit -p .
npm run build
cd ..
```

ライト・ダーク両方と狭い画面でも確認し、変えた画面のスクリーンショット（できれば変える前と後）を付けて PR にしてください。画面構成は保ち、見た目の変更に絞ってください。分からないことは、気軽にスレッドで聞いてください。
