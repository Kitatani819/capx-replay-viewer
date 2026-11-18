# GMOの記録をブラウザで見る

[README](../README.md) | [画面の操作](replay.md)

viewerをGMOの計算ノードで動かし、SSH転送を通して手元のブラウザから開く手順です。計算ノードではTCPのポートではなく、自分だけが入れるディレクトリに置いたUnixドメインソケットで待ち受けます。閲覧にGPUは使いません。READMEではGMO実試行のデモ映像を公開しています。ログイン情報・鍵・実験ログは含めません。

手元のPCはWindows・Linux・macOSのいずれでも使えます。この構成ではviewerのPythonサーバーをGMO側で動かすため、手元に必要なのはSSHとブラウザだけです。手元へ録画を持ち帰って動かす場合は、次の「[GMOの記録を手元へ取ってくる](#gmoの記録を手元へ取ってくる)」を使います。

## GMOの記録を手元へ取ってくる

`capx_trace_recorder` がGMO上に書いた記録（トレースのrun）を、手元の `outputs/gmo/traces` へコピーしてから開きます。コピーには手元の `ssh` と `rsync` を使い、GMO側では `python3` で一覧を作ります。2回目以降は、変更されたファイルだけをコピーします。1エピソードの転送予定量が1 GiB以上の場合は転送前に止まります。

手元の `~/.ssh/config` に接続先を登録しておくと、指定が短くなります。`USER` と鍵ファイルは自分のものに置き換えてください。

```text
Host gmo
    HostName host.example
    Port 8822
    User USER
    IdentityFile ~/.ssh/YOUR_GMO_KEY
    IdentitiesOnly yes
```

まず次のコマンドで起動し、「試行を選ぶ」→「GMO」→「接続設定」を開きます。接続先を入力し、一番上の「共有の記録フォルダー」に `/path/to/shared/traces` のような共有フォルダーの絶対パスを1つ入れて、「保存して確かめる」を押してください。記録の場所はこの1欄で設定できます。

```bash
bash Start-Replay.sh --from-gmo
```

hype-agentの `HYPE_TRACE_ROOT` と、viewerの「共有の記録フォルダー」には同じ場所を指定します。hype-agentは次の配置で記録を保存します。viewerでいう trace root は、共有フォルダー直下のユーザー名のフォルダーです。

```text
<共有フォルダー>/<GMOのユーザー名>/<run id>/<episode>/…
```

自分の記録は `<共有フォルダー>/<自分のユーザー名>`、チームの記録は `<共有フォルダー>/*` のうち自分以外のフォルダーから探します。接続先が `user@host` なら `user` を自分のユーザー名として使い、SSH設定の別名などユーザー名が書かれていない場合は、一覧取得と同じSSH接続内でリモートのユーザー名を調べます。ユーザー名を調べるための追加接続は行いません。共有フォルダー配下の「実行者」（`owner`）は、ファイルの所有者にかかわらず、そのユーザー名のフォルダー名になります。

接続先に `@` が複数ある場合は、最後の `@` より前をユーザー名として使います（例：`alice@domain@host` のユーザー名は `alice@domain`）。権限などで一覧を読めないユーザーフォルダーは飛ばし、読めるフォルダーの一覧取得・自動取り込み・起動前の取り込みを続けます。

`--from-gmo` は起動前に自分の記録だけを取り込み、`outputs/gmo/traces` を開いて、サーバーの `--gmo` API を有効にします。初回など設定がなければ警告を1行表示して起動前の取り込みを飛ばし、サーバーは起動します。保存後は自動取り込みを利用でき、チームの記録はGMOタブから選んで手動で取り込みます。サーバーを直接起動する場合も `--gmo` を付けると同じ API が使えます。

従来の場所も使う場合は「接続設定」の「場所を個別に指定する（詳細）」を開き、自分・チームのパターンを1行ずつ入力します。`mine` と `team` は共有フォルダーから決まる場所に足し合わせます。同じ場所が複数の指定に一致しても1回だけ表示し、自分とチームの両方に一致する記録は自分として扱います。共有フォルダー内の実行者名は、個別のパターンから見つかった場合もフォルダー名です。共有フォルダーを空にすれば個別のパターンだけで使え、既存の設定ファイルも変更せずに読み込めます。

連携が有効な場合、「試行を選ぶ」は最初に「GMO」を開きます。接続設定が未入力なら同じタブで設定し、一覧から「取り込む」→「開く」と進めます。タブは左から「GMO」「手元の記録」「古いログ（トレースなし）」で、取得済みのトレースは「手元の記録」からも開けます。「古いログ（トレースなし）」は既存runnerログがある場合、またはURLで旧形式の試行を開いている場合に表示します。

有効・無効の確認中は読み込み表示になり、無効なら「手元の記録」を開きます。確認でエラーが起きた場合も「手元の記録」を開きますが、「GMO」ボタンは残り、設定を読み直せます。選んだタブは閉じて開き直しても保ち、ページの再読み込みで初期選択に戻ります。

GMO タブの「接続設定」にある「自動取り込みの間隔」で、1 分・2 分（既定）・5 分・取り込まないを選び、「保存して確かめる」で保存できます。「取り込まない」を保存すると自動取り込みが無効になります。間隔の変更は次の巡回から反映されます。設定ファイルで指定したこれら以外の間隔も、設定ファイルの値として選択欄に表示され、そのまま保存できます。

設定ファイルは Linux では `${XDG_CONFIG_HOME:-~/.config}/capx-geniac-replay/gmo.json`、macOS では `~/Library/Application Support/capx-geniac-replay/gmo.json` です。`CAPX_GMO_CONFIG` で別の場所を指定できます。ファイルがない場合だけ、`CAPX_GMO_HOST` と `CAPX_GMO_TRACES` を既定値（`mine`）として使います。設定はディレクトリ 700、ファイル 600 で保存します。

```json
{
  "host": "gmo",
  "port": null,
  "identity_file": null,
  "shared_root": "/path/to/shared/traces",
  "mine": [],
  "team": [],
  "interval_s": 120
}
```

`host` は SSH の Host 名または `user@host`、`port` は省略可能なポート番号、`identity_file` は省略可能な鍵のパスです。`shared_root` は共有フォルダーの絶対パス1つで、省略時や空文字列（`""`）では無効です。半角英数字と `._/+@-` を使えます。`..` のパス要素、制御文字、空白、glob文字（`*`、`?`、`[` など）は使えません。`mine` と `team` は追加するパターンの配列で、`*` や `?` を使えます。たとえば `"mine": ["/path/to/other/traces"]` で共有フォルダー以外の自分の記録を追加できます。

自動取り込みの巡回間隔は設定ファイルの `interval_s` でも秒単位で指定でき、既定は 120 秒（2 分）、`0` は無効、最大は 86400 秒（1 日）です。範囲外の設定ファイルはエラーとなり、設定を修正すると巡回が復帰します。API の SSH 接続は `BatchMode=yes` を使うため、パスフレーズ付きの鍵は事前に `ssh-agent` へ登録してください。パスフレーズなしの鍵も使えます。

`--gmo` のサーバーは `interval_s` ごとに自分の試行（共有フォルダーの自分の場所と `mine` のパターン）を一覧し、未取得・更新ありの試行を手動と同じキューへ入れます。同じ SSH 接続でチームの場所（共有フォルダーの自分以外と `team` のパターン）の run 名も確認し、異なる場所に同名 run がある場合は取り込みを見送ります（team の試行内容は巡回しません）。エピソードが一致していても `run.json` が欠落・不完全なら差分を取り込みます。1 回の巡回の転送予定量は合計 1 GiB 未満とし、新しい順に入るものを選びます。残りは GMO タブの「大きいため手動」に表示されます。記録中も差分を同じファイルへ取り込むため、開いている viewer の Live 表示が追従します。取り込み間隔の間に heartbeat が古くなり `incomplete` となった場合も、20 秒ごとの再読で次の取り込みを検知します。

GMO タブの「自分の試行を自動で取り込む」で一時停止・再開でき、次の巡回、最後の結果、エラーを 5 秒ごとに確認できます。一時停止はサーバー再起動で解除されます。失敗時は間隔を倍に延ばし（最大 30 分）、成功すると設定の間隔へ戻ります。設定変更は次の巡回に反映され、サーバー終了時に巡回と実行中の子プロセスも停止します。

従来の環境変数も引き続き使えます。`CAPX_GMO_TRACES` は自分のtrace rootのパターンで、複数の場所は `:` で区切ります。

```bash
export CAPX_GMO_HOST=gmo
export CAPX_GMO_TRACES='/path/to/your/replay-*/traces'
bash Start-Replay.sh --from-gmo
```

コピーだけを行う場合や、runを選ぶ場合は `scripts/fetch_gmo.py` を直接使います。この従来のCLIには `shared_root` の設定は適用されないので、環境変数か `--traces` でtrace rootを指定してください。

```bash
python3 scripts/fetch_gmo.py --list                       # GMO上のrunとコピー量を表示するだけ
python3 scripts/fetch_gmo.py --run RUN_ID                 # 指定したrunだけコピー
python3 scripts/fetch_gmo.py --ssh "ssh -p 8822 -i ~/.ssh/YOUR_GMO_KEY" --host USER@host.example
```

`~/.ssh/config` を使わない場合、従来の CLI は最後の例のように `--ssh` と `--host`（環境変数では `CAPX_GMO_SSH` と `CAPX_GMO_HOST`）で指定できます。CLI では鍵のパスフレーズを `ssh` が通常どおり尋ねます。API は設定ファイルの `port` と `identity_file` だけを受け付けます。Windowsでは、WSL内で同じコマンドを実行してください。`--from-gmo` はLinux / macOSのランチャーにだけあります。

hype-agentでの[記録の作り方](../README.md#記録を作る)も参照してください。従来の `CAPX_TRACE_DIR` の場所は「場所を個別に指定する（詳細）」の個別パターンでも指定できます。

**計算ノードではTCPで待ち受けない:** 計算ノードは他のチームと共有しています。`--host 127.0.0.1 --port 8390` のようにTCPのポートで待ち受けると、同じノードで動く他のチームのジョブからも接続でき、トレース（プロンプト、モデルの回答、生成コード、画像）を読まれます。viewerのアクセス制限はループバック（127.0.0.1）からの接続だけを許すもので、同じノードの他のユーザーを区別できません。計算ノードでは必ず `--uds` を使い、`$HOME` の下のパーミッション0700のディレクトリに置いたソケットで待ち受けてください。`/tmp` の直下には置きません。[公式ルール §10.5](https://github.com/matsuolab/geniac_prize_2026_code/blob/main/PRELIM_RULEBOOK.md#105-計算ノードで立てるサーバー)

**確認範囲:** GMOから取得した実記録をローカルのviewerで開くことは確認済みです。`--uds` のソケットで待ち受けてAPIと画面を返すこと、権限の検査はPythonテストで確認しています。以下の計算ノードでの起動と、ソケットへのSSH転送（`ssh -L` の転送先にソケットを指定する方法）は、GMOの計算ノードでは未確認です。計算ノードへのSSHと、sshdのUnixドメインソケット転送（`AllowStreamLocalForwarding`、既定で許可）が許可されていることが必要です。

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

まず、ソケットを置くディレクトリを `$HOME` の下に作り、自分だけが入れるようにします（パーミッション0700）。例の `~/.capx/sockets` は、CaP-X参照実装のサーバーがソケットを置く既定の場所と同じです。表示されたソケットの絶対パスは、手順4で使います。

```bash
sock_dir="$HOME/.capx/sockets"
mkdir -p "$sock_dir"
chmod 700 "$sock_dir"
sock="$sock_dir/replay-viewer.sock"
echo "$sock"
```

まず同梱のデモ記録で画面まで確認する場合:

```bash
.venv/bin/python -m capx_trace_viewer.server --viewer-only \
  --uds "$sock" \
  --trace-root demo/traces \
  --runner-root demo/runner
```

実験の記録を開く場合は、一度 `Ctrl+C` で止め、同じ試行の記録が入るルートを指定します。

```bash
.venv/bin/python -m capx_trace_viewer.server --viewer-only \
  --uds "$sock" \
  --trace-root /path/to/traces \
  --runner-root /path/to/runner
```

`--uds` は、ソケットのディレクトリが自分の所有でパーミッション700でなければ起動を拒否し、直すコマンドを表示します。ソケットはパーミッション600で作り、`Ctrl+C` やSlurmの割り当て終了（SIGTERM）で削除します。同じパスにファイルが既にある場合も起動しません。`$HOME` は他のノードと共有されることがあるため、別のノードで同時にviewerを動かすときはソケットの名前を変えてください。強制終了などで残ったソケットは、そのパスでviewerが動いていないことを確かめてから `rm "$sock"` で削除します。`--uds` は `--host`・`--port` と同時に指定できません。`bash Start-Replay.sh --python .venv/bin/python --uds "$sock" --trace-root ... --runner-root ...` でも同じように起動できます。

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
  --uds "$sock" \
  --trace-root outputs/empty-traces \
  --runner-root "$replay_root"
```

`$sock` は上の手順で設定したソケットのパスです。

`run.json` はこの例では空のオブジェクトで構いません。`trial_record.json` は必須ではなく、既存の `summary.txt` や候補・統合ログがあれば表示に使います。シンボリックリンクを使った代用は、安全なファイル読み出しで拒否されるため避けてください。コピーするのは権限のある試行だけにし、大きなコピーも計算ノード上で行います。

## 4. 手元のブラウザへ転送する

手元の別端末から実行します。手元の `127.0.0.1:18390` への接続を、計算ノードのソケットへ転送します。`USER` と `COMPUTE` は自分のGMOユーザー名と、手順1で得た計算ノード名です。`/home/GROUP/USER/.capx/sockets/replay-viewer.sock` は、手順3の `echo "$sock"` が表示した絶対パスに置き換えます。`~` や `$HOME` は計算ノードのパスとして展開されないため、絶対パスで書きます。鍵ファイルのパスは手元の実際の場所に合わせてください。以下はLinux・macOSで共通です。

```bash
ssh -N -o ExitOnForwardFailure=yes -J gmo \
  -L 127.0.0.1:18390:/home/GROUP/USER/.capx/sockets/replay-viewer.sock \
  -i ~/.ssh/id_ed25519_gmo USER@COMPUTE
```

WindowsのPowerShellでは一行で実行できます。

```powershell
ssh -N -o ExitOnForwardFailure=yes -J gmo -L 127.0.0.1:18390:/home/GROUP/USER/.capx/sockets/replay-viewer.sock -i "$env:USERPROFILE\.ssh\id_ed25519_gmo" USER@COMPUTE
```

SSH転送を起動したまま、手元のブラウザで **http://127.0.0.1:18390/traces** を開きます。計算ノード側では、自分のユーザーで動くsshdがソケットへ接続します。他のチームのジョブはソケットのディレクトリに入れないため接続できません。18390は手元のPCのポートです。既存のローカルviewerと衝突する場合は、手元の18390だけを別の空き番号へ変えます。ソケットへの転送には、手元と計算ノードのOpenSSHが6.7以降であることが必要です。`open failed` や `administratively prohibited` で転送できない場合、そのノードではソケット転送が許可されていません。TCPの転送へ戻さず、次の代替を使ってください。

この方法は、割り当てた計算ノードへのSSH接続が許可され、認証できる環境を前提としています。接続を拒否される場合は運営の接続案内を確認してください。代替として、許可された転送方法で同じ試行の記録一式を手元へ持ち帰り、ローカルのviewerで開けます（[GMOの記録を手元へ取ってくる](#gmoの記録を手元へ取ってくる)）。

計算ノードでは `--host`・`--port` を使わず `--uds` で起動し、`--expose-traces` は付けません。HTTPを外部公開する必要はありません。

## 5. 終了

1. 計算ノードのviewer端末で `Ctrl+C`。ソケットも削除されます。
2. 手元のSSH転送端末で `Ctrl+C`。
3. 計算ノードのシェルで `exit` し、Slurmの割り当てを解放します。

起動できない場合は、計算ノードの `hostname`、サーバーのエラー、ソケットのディレクトリの所有者とパーミッション（`ls -ld "$sock_dir"` が `drwx------` と自分のユーザー名）、データルートの階層、ビルド済みの `web-ui/dist/index.html` を確認してください。初回ビルド前やdistがない状態ではブラウザに503が返ります。
