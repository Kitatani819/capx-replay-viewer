# GMOの記録をブラウザで見る

[README](../README.md) | [画面の操作](replay.md)

viewerをGMOの計算ノードで動かし、SSH転送を通して手元のブラウザから開く手順です。閲覧にGPUは使いません。READMEではGMO実試行のデモ映像を公開しています。ログイン情報・鍵・実験ログは含めません。

手元のPCはWindows・Linux・macOSのいずれでも使えます。この構成ではviewerのPythonサーバーをGMO側で動かすため、手元に必要なのはSSHとブラウザだけです。手元へ録画を持ち帰って動かす場合は、次の「[GMOの記録を手元へ取ってくる](#gmoの記録を手元へ取ってくる)」を使います。

## GMOの記録を手元へ取ってくる

`capx_trace_recorder` がGMO上に書いた記録（トレースのrun）を、手元の `outputs/gmo/traces` へコピーしてから開きます。コピーには手元の `ssh` と `rsync` を使い、GMO側では `python3` で一覧を作ります。2回目以降は、変更されたファイルだけをコピーします。1エピソードの転送予定量が1 GiB以上の場合は転送前に止まります。

手元の `~/.ssh/config` に接続先を登録しておくと、指定が短くなります。`USER` と鍵ファイルは自分のものに置き換えてください。

```text
Host gmo
    HostName connect2.gpucloud.gmo
    Port 8822
    User USER
    IdentityFile ~/.ssh/YOUR_GMO_KEY
    IdentitiesOnly yes
```

GMO上のトレースの置き場所（`CAPX_TRACE_DIR` に指定したディレクトリ）を指定して起動します。`*` などのパターンも使えます。複数の場所は `:` で区切ります。

```bash
export CAPX_GMO_HOST=gmo
export CAPX_GMO_TRACES='/home/GROUP/USER/replay-*/traces'
bash Start-Replay.sh --from-gmo
```

`--from-gmo` は起動前に自分の記録（`mine`）だけを取り込み、`outputs/gmo/traces` を開いて、サーバーの `--gmo` API を有効にします。設定がなければ警告を1行表示して取り込みを飛ばし、サーバーは起動します。チームの記録（`team`）は API から選んで取り込みます。サーバーを直接起動する場合も `--gmo` を付けると同じ API が使えます。

連携が有効な場合、「試行を選ぶ」は最初に「GMO」を開きます。接続設定が未入力なら同じタブで設定し、一覧から「取り込む」→「開く」と進めます。タブは左から「GMO」「手元の記録」「古いログ（トレースなし）」で、取得済みのトレースは「手元の記録」からも開けます。「古いログ（トレースなし）」は既存runnerログがある場合、またはURLで旧形式の試行を開いている場合に表示します。

有効・無効の確認中は読み込み表示になり、無効なら「手元の記録」を開きます。確認でエラーが起きた場合も「手元の記録」を開きますが、「GMO」ボタンは残り、設定を読み直せます。選んだタブは閉じて開き直しても保ち、ページの再読み込みで初期選択に戻ります。

設定ファイルは Linux では `${XDG_CONFIG_HOME:-~/.config}/capx-geniac-replay/gmo.json`、macOS では `~/Library/Application Support/capx-geniac-replay/gmo.json` です。`CAPX_GMO_CONFIG` で別の場所を指定できます。ファイルがない場合だけ、上の `CAPX_GMO_HOST` と `CAPX_GMO_TRACES` を既定値（`mine`）として使います。設定はディレクトリ 700、ファイル 600 で保存します。

```json
{
  "host": "gmo",
  "port": null,
  "identity_file": null,
  "mine": ["/path/to/your/traces"],
  "team": ["/path/to/team/traces"],
  "interval_s": 120
}
```

`host` は SSH の Host 名または `user@host`、`port` は省略可能なポート番号、`identity_file` は省略可能な鍵のパスです。`mine` と `team` はパターンの配列で、`*` や `?` を使えます。`interval_s` は自動取り込みの巡回間隔（秒）で、`0` は無効、最大は 86400 秒（1 日）です。範囲外の設定ファイルはエラーとなり、設定を修正すると巡回が復帰します。API の SSH 接続は `BatchMode=yes` を使うため、パスフレーズ付きの鍵は事前に `ssh-agent` へ登録してください。パスフレーズなしの鍵も使えます。

`--gmo` のサーバーは `interval_s` ごとに `mine` の試行を一覧し、未取得・更新ありの試行を手動と同じキューへ入れます。同じ SSH 接続で `team` の run 名も確認し、異なる場所に同名 run がある場合は取り込みを見送ります（team の試行内容は巡回しません）。エピソードが一致していても `run.json` が欠落・不完全なら差分を取り込みます。1 回の巡回の転送予定量は合計 1 GiB 未満とし、新しい順に入るものを選びます。残りは GMO タブの「大きいため手動」に表示されます。記録中も差分を同じファイルへ取り込むため、開いている viewer の Live 表示が追従します。取り込み間隔の間に heartbeat が古くなり `incomplete` となった場合も、20 秒ごとの再読で次の取り込みを検知します。

GMO タブの「自分の試行を自動で取り込む」で一時停止・再開でき、次の巡回、最後の結果、エラーを 5 秒ごとに確認できます。一時停止はサーバー再起動で解除されます。失敗時は間隔を倍に延ばし（最大 30 分）、成功すると設定の間隔へ戻ります。設定変更は次の巡回に反映され、サーバー終了時に巡回と実行中の子プロセスも停止します。

コピーだけを行う場合や、runを選ぶ場合は `scripts/fetch_gmo.py` を直接使います。

```bash
python3 scripts/fetch_gmo.py --list                       # GMO上のrunとコピー量を表示するだけ
python3 scripts/fetch_gmo.py --run RUN_ID                 # 指定したrunだけコピー
python3 scripts/fetch_gmo.py --ssh "ssh -p 8822 -i ~/.ssh/YOUR_GMO_KEY" --host USER@connect2.gpucloud.gmo
```

`~/.ssh/config` を使わない場合、従来の CLI は最後の例のように `--ssh` と `--host`（環境変数では `CAPX_GMO_SSH` と `CAPX_GMO_HOST`）で指定できます。CLI では鍵のパスフレーズを `ssh` が通常どおり尋ねます。API は設定ファイルの `port` と `identity_file` だけを受け付けます。Windowsでは、WSL内で同じコマンドを実行してください。`--from-gmo` はLinux / macOSのランチャーにだけあります。

GMO上で記録を作る手順はこのリポジトリに含めていません。記録時に `CAPX_TRACE_DIR` で指定したディレクトリが、ここで指定する置き場所です。

**確認範囲:** GMOから取得した実記録をローカルのviewerで開くことは確認済みです。以下の計算ノードでの起動とSSH転送経路は、そのGMO環境では未確認です。計算ノードへのSSHが許可されていることが必要です。

## 1. ログインと計算ノードの確保

手元の端末で、登録済みのSSH接続設定を使います。以下の `gmo` は手元のSSH設定の別名です。既に別名がある場合はそれを使ってください。新たに設定する場合は[公式ログイン手順](https://github.com/matsuolab/geniac_prize_2026_baseline/blob/main/docs/tutorial/01_login.md)を参照し、秘密鍵は手元に保管します。

```bash
ssh gmo
hostname
snodes
```

表示された利用可能なパーティションを選び、GPUなしの計算ノードへ入ります。`PARTITION` は実際の名前へ置き換えます。

```bash
srun --partition=PARTITION --cpus-per-task=2 --mem=4G --time=01:00:00 --pty bash
hostname
```

`hostname` がログインノードから変わったことを確認し、計算ノード名を控えます。割り当て終了までこの端末を保ちます。パーティションの指定と利用状況は[公式Slurm手順](https://github.com/matsuolab/geniac_prize_2026_baseline/blob/main/docs/tutorial/02_slurm.md)を参照してください。

インストール、ファイル展開、時間が読めない処理はログインノードで行わない規則があります。この後のclone、依存関係の導入、ビルド、viewer起動は計算ノードで行います。[公式ルール §10.3](https://github.com/matsuolab/geniac_prize_2026_code/blob/main/PRELIM_RULEBOOK.md#103-ログインノードでしてはいけないこと)

## 2. viewerの取得とビルド

チーム共有ストレージ内の自分用作業ディレクトリへ移動します。以下のパスは例なので実環境に置き換えます。

```bash
cd /path/to/shared-storage/your-work-directory
git clone https://github.com/Kitatani819/capx-replay-viewer.git
cd capx-replay-viewer
python3.12 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
cd web-ui
npm ci
npm run test:trace
npm run build
cd ..
```

Python 3.10～3.12、Node.js、npmが必要です。未導入の場合は計算ノード上で利用できる環境を用意してください。READMEはPython 3.12を使った例です。ロボットシミュレーターやLLMのモデル重みは不要です。

## 3. 録画とログを指定して起動

まず同梱のデモ記録で画面まで確認する場合:

```bash
.venv/bin/python -m capx_trace_viewer.server --viewer-only \
  --host 127.0.0.1 --port 8390 \
  --trace-root demo/traces \
  --runner-root demo/runner
```

実験の記録を開く場合は、一度 `Ctrl+C` で止め、同じ試行の記録が入るルートを指定します。

```bash
.venv/bin/python -m capx_trace_viewer.server --viewer-only \
  --host 127.0.0.1 --port 8390 \
  --trace-root /path/to/traces \
  --runner-root /path/to/runner
```

ルートは[データの置き方](replay.md#データの置き方)に示す階層の親です。トレースがない旧形式の出力はrunner側から表示します。MP4があってもフレーム対応情報がなければ「同期情報なし」と表示します。

### 生のoutputsから1試行を用意する

CaP-X側の出力が `<model>/<task>/trial_*` の並びなら、`--runner-root` にそのまま渡してもviewerの期待する `<run>/<task>/<condition>/trial_*` と一致しません。計算ノードで、対象の1試行を別の閲覧用ディレクトリへコピーします。元データは変更しません。

以下の `source_trial` と `replay_root` を実際の絶対パスへ、`task` と `condition` をその試行に合わせて変更してください。初回専用の例で、同名runや同名試行があれば中断します。`run` は新しい名前にしてください。

```bash
set -euo pipefail
source_trial='/path/to/outputs/model/task/trial_001'
replay_root='/path/to/your-work-directory/viewer-recordings'
run='review_run_001'
task='cube_lifting'
condition='model_name'
trial=$(basename -- "$source_trial")
target="$replay_root/$run/$task/$condition/$trial"

test -d "$source_trial" || { echo '元の試行ディレクトリが見つかりません' >&2; exit 1; }
case "$trial" in trial_*) ;; *) echo 'trial_* ディレクトリを指定してください' >&2; exit 1;; esac
test ! -e "$replay_root/$run" || { echo '同名runが存在します。runを変更してください' >&2; exit 1; }
test ! -e "$target" || { echo 'コピー先が存在します' >&2; exit 1; }
mkdir -p -- "$replay_root/$run/$task/$condition"
cp -R -- "$source_trial" "$target"
printf '{}\n' > "$replay_root/$run/run.json"

.venv/bin/python -m capx_trace_viewer.server --viewer-only \
  --host 127.0.0.1 --port 8390 \
  --trace-root outputs/empty-traces \
  --runner-root "$replay_root"
```

`run.json` はこの例では空のオブジェクトで構いません。`trial_record.json` は必須ではなく、既存の `summary.txt` や候補・統合ログがあれば表示に使います。シンボリックリンクを使った代用は、安全なファイル読み出しで拒否されるため避けてください。コピーするのは権限のある試行だけにし、大きなコピーも計算ノード上で行います。

## 4. 手元のブラウザへ転送する

手元の別端末から実行します。`USER` と `COMPUTE` は自分のGMOユーザー名と、手順1で得た計算ノード名です。鍵ファイルのパスは手元の実際の場所に合わせてください。以下はLinux・macOSで共通です。

```bash
ssh -N -o ExitOnForwardFailure=yes -J gmo \
  -L 127.0.0.1:18390:127.0.0.1:8390 \
  -i ~/.ssh/id_ed25519_gmo USER@COMPUTE
```

WindowsのPowerShellでは一行で実行できます。

```powershell
ssh -N -o ExitOnForwardFailure=yes -J gmo -L 127.0.0.1:18390:127.0.0.1:8390 -i "$env:USERPROFILE\.ssh\id_ed25519_gmo" USER@COMPUTE
```

SSH転送を起動したまま、手元のブラウザで **http://127.0.0.1:18390/traces** を開きます。計算ノード側の8390と手元の18390は別のポートです。既存のローカルviewerと衝突する場合は、手元の18390だけを別の空き番号へ変えます。

この方法は、割り当てた計算ノードへのSSH接続が許可され、認証できる環境を前提としています。接続を拒否される場合は運営の接続案内を確認してください。代替として、許可された転送方法で同じ試行の記録一式を手元へ持ち帰り、ローカルのviewerで開けます。

サーバーは `127.0.0.1` のままで使い、`--expose-traces` は付けません。HTTPを外部公開する必要はありません。

## 5. 終了

1. 計算ノードのviewer端末で `Ctrl+C`。
2. 手元のSSH転送端末で `Ctrl+C`。
3. 計算ノードのシェルで `exit` し、Slurmの割り当てを解放します。

起動できない場合は、計算ノードの `hostname`、サーバーのエラー、データルートの階層、ビルド済みの `web-ui/dist/index.html` を確認してください。初回ビルド前やdistがない状態ではブラウザに503が返ります。
