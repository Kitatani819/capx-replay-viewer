# GMOの記録をブラウザで見る

[README](../README.md) | [画面の操作](replay.md)

viewerをGMOの計算ノードで動かし、SSH転送を通して手元のブラウザから開く手順です。計算ノードではTCPのポートではなく、自分だけが入れるディレクトリに置いたUnixドメインソケットで待ち受けます。閲覧にGPUは使いません。READMEではGMO実試行のデモ映像を公開しています。ログイン情報・鍵・実験ログは含めません。

手元のPCはWindows・Linux・macOSのいずれでも使えます。この構成ではviewerのPythonサーバーをGMO側で動かすため、手元に必要なのはSSHとブラウザだけです。手元へ録画を持ち帰って動かす場合は、次の「[GMOの記録を手元へ取ってくる](#gmoの記録を手元へ取ってくる)」を使います。

## GMOの記録を手元へ取ってくる

`capx_trace_recorder` がGMO上に書いた記録（トレースのrun）を、手元の `outputs/gmo/traces` へコピーしてから開きます。コピーには手元の `ssh` と `rsync` を使い、GMO側では `python3` で一覧を作ります。2回目以降は、変更されたファイルだけをコピーします。1エピソードの転送予定量が1 GiB以上の場合は転送前に止まります。

[公式ログイン手順](https://github.com/matsuolab/geniac_prize_2026_baseline/blob/main/docs/tutorial/01_login.md)の `Host gmo` を手元の `~/.ssh/config` に登録済みなら、viewerの設定は不要です。接続情報は公式手順の案内に従って入力し、秘密鍵は手元に保管してください。

```text
Host gmo
    HostName <host>
    User <user>
    Port <port>
    IdentityFile ~/.ssh/id_ed25519_gmo
    IdentitiesOnly yes
```

Linux・macOS、またはWindowsのWSL内で次を実行します。

```bash
bash Start-Replay.sh --from-gmo
```

接続先は `gmo`、共有の記録フォルダーは `~/shared-storage/traces` が既定です。各メンバーのGMOホームにある `~/shared-storage` は同じ共有ストレージへのリンクです。自分とチームの記録を次の配置から探します。viewerでいう trace root は、共有フォルダー直下のユーザー名のフォルダーです。

```text
~/shared-storage/traces/<GMOのユーザー名>/<run id>/<episode>/…
~/shared-storage/submission_evals/_viewer/<GMOのユーザー名>/<eval id>/<episode>/…
```

自分の記録は `~/shared-storage/traces/<自分のユーザー名>`、チームの記録は同じ共有フォルダーのうち自分以外のユーザーフォルダーから探します。提出の形の評価（経路 B）の結果も `~/shared-storage/submission_evals/_viewer` の同じユーザーフォルダー構成から、自分・チームの評価として既定で表示します。このフォルダーがない接続先では読み飛ばします。`~/` は手元ではなくGMOアカウントのホームへ、一覧取得と同じSSH接続内で展開します。以後の取り込み、実行者の判定、場所の表示には解決した絶対パスを使い、追加のSSH接続は行いません。

提出の形の評価（経路 B）の成否は審判（gateway）の判定です。試行を開く前から審判の記録で終了理由を表示します。未達成の試行では `referee.ended` の値を次のように読みます。

- `steplimit`（上限）：試行のステップ上限に達しました。
- `reset`（終了）：審判が成功と判定する前に、提出物が試行をリセット・終了しました。
- `cut`（打ち切り）：試行の途中で評価ジョブが終了したか、ジョブの制限時間に達しました。公式の集計では終了済みの試行数に含めません。

BEHAVIORの提出の形の評価（経路 B）は、シミュレーターだけがRTX VMのDocker内で動き、エージェントとモデルはGMOのB300上のSlurmジョブで動きます。ジョブと記録がGMOにあるため、結果は「B300」タブに表示します。

接続先が `user@host` なら `user` を自分のユーザー名として使い、SSH設定の別名などユーザー名が書かれていない場合は、同じ接続内でリモートのユーザー名を調べます。共有フォルダー配下の「実行者」（`owner`）は、ファイルの所有者にかかわらず、そのユーザー名のフォルダー名になります。

接続先に `@` が複数ある場合は、最後の `@` より前をユーザー名として使います（例：`alice@domain@host` のユーザー名は `alice@domain`）。権限などで一覧を読めないユーザーフォルダーは飛ばし、読めるフォルダーの一覧取得・自動取り込み・起動前の取り込みを続けます。

`--from-gmo` は起動前に自分の記録だけを取り込み、`outputs/gmo/traces` を開いて、サーバーの `--gmo` API を有効にします。設定ファイルがなくても既定値で起動前の取り込みと定期的な自動取り込みを行います。SSHの別名が見つからない、接続できない場合は、公式手順の `Host gmo` または「接続設定」を確認する案内を表示してサーバーを起動します。「手元の記録」は引き続き使えます。チームの記録はGMOタブから選んで手動で取り込みます。サーバーを直接起動する場合も `--gmo` を付けると、起動前の取り込みと同じAPI・自動取り込みが使えます。

従来の場所も使う場合は「接続設定」の「場所を個別に指定する（詳細）」を開き、自分・チームのパターンを1行ずつ入力します。`mine` と `team` は共有フォルダーから決まる場所に足し合わせます。同じ場所が複数の指定に一致しても1回だけ表示し、自分とチームの両方に一致する記録は自分として扱います。共有フォルダー内の実行者名は、個別のパターンから見つかった場合もフォルダー名です。設定ファイルの `shared_root` と `submission_root` を両方空にすれば個別のパターンだけで使え、既存の設定ファイルも変更せずに読み込めます。

連携が有効な場合、「試行を選ぶ」は最初に「GMO」を開きます。一覧から「取り込む」→「開く」と進めます。接続先や共有先を変える場合は同じタブの「接続設定」を開き、値を変更して「保存して確かめる」を押します。フォームには現在の有効な値が入り、既定値を使っている場合も確認できます。タブは左から「GMO」「手元の記録」「古いログ（トレースなし）」で、取得済みのトレースは「手元の記録」からも開けます。「古いログ（トレースなし）」は既存runnerログがある場合、またはURLで旧形式の試行を開いている場合に表示します。

有効・無効の確認中は読み込み表示になり、無効なら「手元の記録」を開きます。確認でエラーが起きた場合も「手元の記録」を開きますが、「GMO」ボタンは残り、設定を読み直せます。選んだタブは閉じて開き直しても保ち、ページの再読み込みで初期選択に戻ります。

評価一覧・比較画面と GMO タブは、最後に取得できた一覧をすぐ表示し、30 秒以上経過していればバックグラウンドで更新します。同時に動く一覧更新は1つです。「GMO の一覧：hh:mm 時点（更新中…）」で取得時刻を確認でき、更新ボタンで再取得できます。接続に失敗しても前の一覧と取得時刻を保ちます。初回は手元の記録を先に表示し、取得後に GMO の記録を追加します。

一覧のキャッシュは設定ファイルと同じディレクトリの `cache/remote-listings/` 以下に保存します。設定ファイルのパスごとに保存先を分けるため、同じディレクトリの `gmo.json` と `rtx.json` もキャッシュを共有しません。キャッシュディレクトリは 700、ファイルは 600 です。再起動後も保存済みの一覧を表示できます。評価一覧は `eval.json` だけを取得し、比較画面を開くと、その評価と基準のエピソード情報を取得します。同条件の再実行を比較する場合は、候補の情報も必要に応じて取得します。

GMO タブの一覧では、エピソード直下のファイルのサイズ・更新時刻とサブディレクトリの更新時刻から変更を調べます。変更のないエピソードはフレームの列挙も省きます。ファイル数は `scandir` で数え、サブディレクトリ内の容量は各ディレクトリ最大4ファイルから推定し、「約」を付けます。フレームの上書きだけではディレクトリの更新時刻が変わらない場合があるため、この一覧の判定は概算です。取り込み・ライブ追従・自動取り込みは従来どおり正確なファイル一覧で差分と転送量を確認し、GMO側にキャッシュを書き込みません。

ローカルの合成データで一覧取得の比較をするには `python scripts/benchmark_gmo_listing.py --frames 72000` を実行します。`--stat-latency-ms` でメタデータ取得の待ち時間を模擬できます。実 GMO での測定とは異なります。

GMO タブの「接続設定」にある「自動取り込みの間隔」で、1 分・2 分（既定）・5 分・取り込まないを選び、「保存して確かめる」で保存できます。「取り込まない」を保存すると自動取り込みが無効になります。間隔の変更は次の巡回から反映されます。設定ファイルで指定したこれら以外の間隔も、設定ファイルの値として選択欄に表示され、そのまま保存できます。

設定ファイルは Linux では `${XDG_CONFIG_HOME:-~/.config}/capx-geniac-replay/gmo.json`、macOS では `~/Library/Application Support/capx-geniac-replay/gmo.json` です。`CAPX_GMO_CONFIG` で別の場所を指定できます。接続設定を保存するとファイルを書き込み、ディレクトリ 700、ファイル 600 にします。優先順位は次のとおりです。

1. 設定ファイルがある場合はその値を使い、省略した項目には下記の既定値を補います。環境変数で上書きしません。
2. ファイルがない場合は組み込みの既定値を使い、`CAPX_GMO_HOST` は接続先、`CAPX_GMO_TRACES` は自分の追加パターン（`mine`）として優先します。

組み込みの既定値は次のとおりです。

```json
{
  "host": "gmo",
  "port": null,
  "identity_file": null,
  "shared_root": "~/shared-storage/traces",
  "submission_root": "~/shared-storage/submission_evals/_viewer",
  "mine": [],
  "team": [],
  "interval_s": 120
}
```

`host` は SSH の Host 名または `user@host` です。`port` と `identity_file` が `null` の場合はSSH設定に任せます。`shared_root` は共有フォルダーの絶対パス、または `~/` で始まるパス1つです。省略時は `~/shared-storage/traces`、明示的な空文字列（`"shared_root": ""`）は共有フォルダーを無効にします。UIでも「共有の記録フォルダー」を空にして保存できます。半角英数字と `._/+@-` を使え、`~` は先頭の `~/` だけに使えます（`~` 単独や `~user/` は不可）。`..` のパス要素、制御文字、空白、glob文字（`*`、`?`、`[` など）は使えません。`mine` と `team` は追加するパターンの配列で、`*` や `?` を使えます。たとえば `"mine": ["/path/to/other/traces"]` で共有フォルダー以外の自分の記録を追加できます。

`submission_root` は提出の形の評価（経路 B）の結果の共有フォルダーです。省略時は `~/shared-storage/submission_evals/_viewer` から自分・チームの評価を表示し、`"team": []` がある既存の設定ファイルでも有効です。`shared_root` と同じパスの制限が適用され、`"submission_root": ""` で無効にできます。接続設定のフォームで保存しても、この値は保たれます。

自動取り込みの巡回間隔は設定ファイルの `interval_s` でも秒単位で指定でき、既定は 120 秒（2 分）、`0` は無効、最大は 86400 秒（1 日）です。範囲外の設定ファイルはエラーとなり、設定を修正すると巡回が復帰します。API の SSH 接続は `BatchMode=yes` を使うため、パスフレーズ付きの鍵は事前に `ssh-agent` へ登録してください。パスフレーズなしの鍵も使えます。

`--gmo` のサーバーは `interval_s` ごとに自分の試行（共有フォルダーの自分の場所と `mine` のパターン）を一覧し、未取得・更新ありの試行を手動と同じキューへ入れます。同じ SSH 接続でチームの場所（共有フォルダーの自分以外と `team` のパターン）の run 名も確認し、異なる場所に同名 run がある場合は取り込みを見送ります（team の試行内容は巡回しません）。エピソードが一致していても `run.json` が欠落・不完全なら差分を取り込みます。1 回の巡回の転送予定量は合計 1 GiB 未満とし、新しい順に入るものを選びます。残りは GMO タブの「大きいため手動」に表示されます。記録中も差分を同じファイルへ取り込むため、開いている viewer の Live 表示が追従します。取り込み間隔の間に heartbeat が古くなり `incomplete` となった場合も、20 秒ごとの再読で次の取り込みを検知します。

GMO タブの「自分の試行を自動で取り込む」で一時停止・再開でき、次の巡回、最後の結果、エラーを 5 秒ごとに確認できます。一時停止はサーバー再起動で解除されます。失敗時は間隔を倍に延ばし（最大 30 分）、成功すると設定の間隔へ戻ります。設定変更は次の巡回に反映され、サーバー終了時に巡回と実行中の子プロセスも停止します。

従来の環境変数も、設定ファイルがない場合に引き続き使えます。`CAPX_GMO_TRACES` は自分のtrace rootの追加パターンで、複数の場所は `:` で区切ります。共有フォルダーの既定値はそのまま有効です。共有フォルダーを無効にする場合は設定ファイルを使ってください。

```bash
export CAPX_GMO_HOST=gmo
export CAPX_GMO_TRACES='/path/to/your/replay-*/traces'
bash Start-Replay.sh --from-gmo
```

コピーだけを行う場合や、runを選ぶ場合は `scripts/fetch_gmo.py` を直接使います。この従来のCLIには `shared_root` と `submission_root` の設定は適用されないので、環境変数か `--traces` でtrace rootを指定してください。

```bash
python3 scripts/fetch_gmo.py --list                       # GMO上のrunとコピー量を表示するだけ
python3 scripts/fetch_gmo.py --run RUN_ID                 # 指定したrunだけコピー
python3 scripts/fetch_gmo.py --ssh "ssh -p <port> -i ~/.ssh/id_ed25519_gmo" --host '<user>@<host>'
```

`~/.ssh/config` を使わない場合、従来の CLI は最後の例のように `--ssh` と `--host`（環境変数では `CAPX_GMO_SSH` と `CAPX_GMO_HOST`）で指定できます。CLI では鍵のパスフレーズを `ssh` が通常どおり尋ねます。API は設定ファイルの `port` と `identity_file` だけを受け付けます。Windowsでは、WSL内で同じコマンドを実行してください。`--from-gmo` はLinux / macOSのランチャーにだけあります。

hype-agentでの[記録の作り方](../README.md#記録を作る)も参照してください。従来の `CAPX_TRACE_DIR` の場所は「場所を個別に指定する（詳細）」の個別パターンでも指定できます。

## 複数の接続先を1つのviewerで開く

B300とRTX PRO 6000 VMには、それぞれSSH接続先・共有フォルダーを設定したJSONファイルを用意します。既定のRTX設定ファイルはLinuxでは `${XDG_CONFIG_HOME:-~/.config}/capx-geniac-replay/rtx.json`、macOSでは `~/Library/Application Support/capx-geniac-replay/rtx.json` です。`CAPX_GMO_CONFIG` はB300側だけに適用されます。

```bash
bash Start-Replay.sh --from-gmo --rtx
# RTX設定が別の場所にある場合
bash Start-Replay.sh --from-gmo --rtx /path/to/rtx.json
```

サーバーは1つで、B300の記録は `outputs/gmo/traces`、RTXの記録は `outputs/rtx/traces` に保存します。起動前にそれぞれの設定で自分の記録を取り込みます。RTX設定が見つからなければ案内を表示し、RTXサイトを追加せず起動します。B300だけなら従来どおり `bash Start-Replay.sh --from-gmo` が使えます。

評価一覧・評価詳細・試行の上部に表示する「B300」「RTX」でサイトを切り替えます。試行や評価の詳細から切り替えたときは、切り替え先の評価一覧を開きます。接続設定の保存、自動取り込み、Live追従、一覧キャッシュ、評価・比較は各サイトで独立します。RTXを開いたURLには `site=rtx` が付き、そのURLを共有すると同じサイトが開きます。サイトの選択はブラウザのタブごとに保持します。

サーバーを直接起動する場合は、追加サイトを `--site NAME=LABEL,CONFIG,TRACE_ROOT` で指定できます。複数回指定でき、名前は半角小文字・数字・ハイフンの1～32文字で、既定の主サイト名 `b300` と重複できません。

```bash
python -m capx_trace_viewer.server --gmo --trace-root outputs/gmo/traces \
  --site "rtx=RTX,/path/to/rtx.json,outputs/rtx/traces"
```

主サイトのAPIは従来どおり `/api/traces`・`/api/gmo`・`/api/evals`、追加サイトは `/api/sites/rtx/traces`・`/api/sites/rtx/gmo`・`/api/sites/rtx/evals` です。サイトの一覧は `/api/sites` から取得できます。どのサイトにも同じローカル接続・書き込み要求の制限が適用されます。

評価のHTML一覧を生成する場合は、RTX側の「開く」リンクにもサイトを指定します。生成コマンドの `--viewer-url 'http://127.0.0.1:8390?site=rtx'` で、RTXを開くURLを使えます。

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
