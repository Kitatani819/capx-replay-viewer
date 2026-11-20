# 評価の記録と比較：設計

2026-11-20 更新：E06で共有ストレージに静的HTML一覧を追加しました。以下には初期設計も含みます。現在の実行方法は [evals.md](evals.md) を参照してください。

## 目的

同じ評価条件で、基準版と改良版の成功率をチーム全員が比べられるようにします。共有のHTML一覧をViewerなしで開き、失敗した試行はViewerで録画とログを開いて原因を調べられるようにします。

## 方針

- 人が入力するのは「変更した部品」と「比べる基準の評価ID」の2つだけです。それ以外は自動で記録します。
- 1回の評価を、トレースの1つのrunとして扱います。評価IDとrun IDは同じです。
- 記録はGMOの共用ストレージ上、トレースのrunの中に置きます。新しい置き場所は作りません。
- 各メンバーが自分のPCでviewerを動かし、自分のGMOアカウントで共用ストレージの評価を読みます。viewerはループバック限定のまま、外部に公開しません。
- 画面は「評価一覧」と「評価の比較」の2つだけにします。絞り込み、グラフ、任意の2評価の比較、画面からの編集は作りません。

## 全体の流れ

```
GMO（評価ジョブ）
  python -m capx_trace_recorder eval --changed … --baseline … -- <いつもの評価コマンド>
    ├ 開始時：<trace root>/<評価ID>/eval.json を「実行中」で作り、共有ルートのindex.htmlを更新
    ├ 子プロセスに CAPX_TRACE_RUN_ID=<評価ID> を渡して評価を実行
    │   （試行ごとの録画とログは、今までどおり <評価ID>/<episode>/ に記録される）
    └ 終了時：試行の成否を集計し、eval.json と共有ルートのindex.htmlを更新

共有ルートのindex.html
  ブラウザで直接開く（PCへコピーしてもよい） ─→ 全員の評価一覧・タスク別集計
  「開く」 ─→ 手元のviewerの /evals/<評価ID>

手元のviewer
  GMOの一覧取得で eval.json も読む ─→ /evals（評価一覧）
                                   ─→ /evals/<評価ID>（基準との比較・seedごとの成否表）
  表の試行を押す ─→ /traces?run=…&episode=… ─→ 手元になければGMOから自動で取り込んで開く
```

## 1. 評価の実行（GMO側）

### 1.1 コマンド

```bash
export CAPX_TRACE_DIR=<共用ストレージ>/<ユーザー名>
.venv/bin/python -m capx_trace_recorder eval \
  --changed "把持位置の修正" \
  --baseline ev-20261118T093000Z-3f2a \
  -- <いつもの評価コマンド>
```

| オプション | 必須 | 内容 |
|---|---|---|
| `--changed TEXT` | `--baseline` があるときは必須 | 変更した部品。最大200文字 |
| `--baseline ID` | 任意 | 比べる基準の評価ID。省略すると、この評価自体を基準として扱います（表示は「（基準）」） |
| `--eval-set NAME` | 任意 | 評価セットの名前（例：`robosuite-5x4`）。中身は第1段階では検証しません |
| `--by NAME` | 任意 | 実行者の表示名。省略時は `CAPX_EVAL_BY`、それもなければ `$USER` |
| `--repo PATH` | 任意 | コミットを記録するCaP-Xのチェックアウト。省略時は現在のディレクトリ |
| `--trust-repo` | 任意 | ラッパー自身のGit呼び出しで `--repo` のチェックアウトを信頼する。信頼できるチームメンバーのチェックアウトだけに使います |

- 既存の `run` と同じく、`capx_trace_recorder/__main__.py` のサブコマンドとして追加します。`--` より後ろは、そのまま子プロセスのコマンドとして渡します。
- `CAPX_TRACE_DIR` が設定されていなければ、起動を拒否します。置き場所は `<shared_root>/<ユーザー名>` を推奨します。viewerのGMO設定の `shared_root` は、ここを自分とチームの記録として探します。
- `CAPX_TRACE_RUN_ID` がすでに設定されていたら、起動を拒否します。runnerの記録フック（H15）は、ユーザーが設定した `CAPX_TRACE_RUN_ID` を上書きしません（`capx_trace_recorder/hooks/runner.py`）。そのため、ここで設定した評価IDがrun IDになります。
- `--baseline` に指定したIDの `eval.json` が `$CAPX_TRACE_DIR/..` の下（`*/<ID>/eval.json`）に見つからなければ、警告を1行出すだけで実行は続けます。

### 1.2 評価ID

`ev-<UTCの YYYYMMDDTHHMMSSZ>-<16進数4桁>` です（例：`ev-20261118T093000Z-3f2a`）。recorderのIDの規則（`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`）に合います。

### 1.3 実行の流れ

1. `<CAPX_TRACE_DIR>/<評価ID>/` を作り、`eval.json` を `status: "running"` で作成します（`O_EXCL`）。
2. 評価コマンドを、新しいプロセスグループの子プロセスとして起動します。環境変数は今の環境をそのまま引き継ぎ、`CAPX_TRACE_RUN_ID` だけ追加します。
3. 60秒ごとに `heartbeat_at` を更新します。更新は一時ファイルに書いてから置き換える方式です（以下、eval.jsonの更新はすべて同じ）。
4. SIGINTまたはSIGTERMを受けたら、子のプロセスグループへそのまま送り、子の終了を待ちます。
5. 子が終了したら、子のプロセスグループが空になるまで最大60秒待ち、runのエピソードを読んで集計し（1.5）、`eval.json` を最終状態にします。
   - 終了コードが0なら `completed`
   - 0以外の終了コード、またはシグナルによる終了なら `interrupted`
6. viewerで開くURL（`http://127.0.0.1:8390/evals/<評価ID>`）を表示し、子の終了コードを返して終わります。

SIGKILLで強制終了された場合は、`running` のまま残ります。viewerは `heartbeat_at` が5分以上前なら「中断」と表示します（2.3）。

ラッパーはCaP-Xのプロセスの外で動くので、標準出力に書いて構いません。fastapiなどviewer専用の依存がなくても動くようにします。

### 1.4 eval.json

```json
{
  "schema": "capx-eval/1",
  "eval_id": "ev-20261118T093000Z-3f2a",
  "status": "completed",
  "end": {"exit_code": 0, "signal": null},
  "by": "kitatani",
  "changed": "把持位置の修正",
  "baseline_eval_id": "ev-20261117T120000Z-9b1c",
  "eval_set": "robosuite-5x4",
  "git": {"commit": "a1b2c3d…", "dirty": true, "diff_sha256": "…"},
  "started_at": "2026-11-18T09:30:00Z",
  "heartbeat_at": "2026-11-18T09:58:00Z",
  "ended_at": "2026-11-18T09:58:12Z",
  "summary": {
    "trials": 20, "attempts": 23, "success": 14, "failure": 5, "unknown": 1, "incomplete": 0,
    "by_task": {"cube_lifting": {"trials": 4, "attempts": 5, "success": 3}},
    "tasks": ["cube_lifting", "cube_restack", "nut_assembly", "spill_wipe", "two_arm_lift"],
    "seeds": [401, 402, 403, 404],
    "models": {"code_generator": "Qwen/Qwen3.8-27B"},
    "config_flags": {"multi_turn": true, "use_parallel_ensemble": true},
    "mixed": [],
    "verdict_sources": {"runner_record": 20}
  }
}
```

- `summary` は終了時に書きます。実行中は `null` で、viewerがエピソードから途中経過を数えます。
- 論理集計の `trials` はタスク・条件・seedごとの最後の試行数、`attempts` はやり直しを含む全試行数です。`by_task` も同じ区別を持ちます。`attempts` のない旧記録も受け付けます。
- 子の終了後60秒を過ぎてもワーカーが残っていれば、`end.workers_left_running: true` を記録して集計を終えます。
- `incomplete` は、トレースが不完全（`trace_complete` が false）か、終了していない試行の数です。
- `models` はモデル名だけを記録し、接続先は含めません。`config_flags` が試行によって違う場合は、そのキーを `mixed` に入れます。
- `diff_sha256` は `git diff HEAD` の内容のハッシュで、`dirty` が true のときに記録します。Gitコマンドが失敗するかGitがない場合は、`.git` のファイルからコミットを読み、`{"commit": "<sha>", "dirty": null, "diff_sha256": null}` として変更の有無は不明と記録します。コミットも取れない場合（Gitのチェックアウトでない等）は `git: null` にします。いずれの場合も警告を1行出します。
- `--trust-repo` は、ラッパー自身のGit呼び出しだけに一時的なグローバル設定で `safe.directory` を指定し、子の評価コマンドには渡しません。一時ファイルは使用後に削除します。そのチェックアウトのGit設定も信頼するため、たとえば `core.fsmonitor` により `git status` 中にコマンドが実行されることがあります。信頼できるチームメンバーのチェックアウトだけに使います。GMOのGit 2.34.1では `git -c safe.directory=…` では所有者チェックを通りません。
- 一覧と比較では短いコミットを表示します。`dirty: null` の場合は「＋未コミット」を付けず、ツールチップで「未コミットの変更の有無は不明」と示します。
- **記録しないもの**：コマンドライン（秘密情報を含むことがあるため）、ホスト名、絶対パス、試行ごとの一覧。試行ごとの成否は、エピソードから読みます（2.4）。
- ファイルは256 KiB以内に収めます。GMOの一覧取得が読むJSONの上限と同じです。

### 1.5 成功の判定

`capx_trace_viewer/evals.py`（標準ライブラリだけで動くようにする）に、`trial_verdict(episode_summary, runner_records)` を1つだけ用意します。判定の規則は、`web-ui/src/trace/outcome.ts` の `episodeVerdict` と同じです。

1. その試行に対応するrunnerの記録に `task_success` があれば、それを使う
2. 最後の試行で、runnerの記録に `outcome.task_success` があれば、それを使う
3. エピソードが `completed` で終わっている（または `sandbox_rc >= 0`）なら、`harness_summary.task_completed` を使う
4. どれでもなければ「未判定」

`harness_summary.success` は使いません。バッチ試行では「最後のコードがエラーなく実行できた」という意味で、タスクの成功ではないためです。同じ記録に対して、TypeScript版とPython版の判定が一致することをテストで確かめます。評価条件を決める担当と相談して成功の定義が変わった場合は、この関数とTypeScript版だけを直します。

## 2. viewer側

### 2.1 GMOの一覧に評価を含める

- `REMOTE_EPISODE_LISTER`（`capx_trace_viewer/gmo.py`）で、runごとに `eval.json` を既存の `read_json` で読みます。
- 出力を `{"episodes": [...], "evals": [...]}` に変えます。`evals` の各要素は `run_id, path, owner, mine, eval_json, eval_json_error, eval_mtime` です。エピソードがまだ1つもないrunでも、`eval.json` があれば `evals` に入れます。自分の記録だけを取る巡回（`mine_only`）では、自分の評価だけを返します。
- 一覧を取るコードはSSHのたびにGMOへ送られるので、手元とGMOで版がずれることはありません。`list_remote_episodes` と呼び出し元を、新しい形式に合わせて直します。
- エピソードを1件取り込むときのファイル一覧（`REMOTE_EPISODE_FILES` と `episode_manifest`）に、`run.json` と同じ扱いで `eval.json` も含めます。取り込んだrunには評価の記録も付いてくるので、GMOにつながらないときも手元で比較ページを開けます。
- 手元の記録からは、`<trace root>/*/eval.json` を読みます。

### 2.2 API

`/api/traces` と同じアクセス制限（ループバック限定）の下に置きます。`server.py` で、traceのルーターと同じように登録します。登録していない `api/` のパスは、最後の全パス受け付けの処理が404を返すためです。

- `GET /api/evals`：評価の一覧を新しい順に返します。各要素には、検証済みの `eval`、置き場所（`local`・`gmo`・`both`）、表示用の状態（2.3）、見つかれば基準の成功数と試行数を含めます。
- `GET /api/evals/{eval_id}`：次の内容を返します。
  - `eval`
  - `baseline`：見つからなければ `null` と、その理由
  - `trials`：`episode_id, task, condition, seed, attempt, verdict, status, trace_complete, local_state` の一覧
  - `baseline_trials`：基準の評価の、同じ形の一覧
  - `differences`：評価と基準で違う条件の一覧
- `trials` は、手元のrunのエピソード（runnerの記録付き）と、GMOの一覧の行（`reader.episode_summary_from_metadata`）を `episode_id` で合わせて作ります。両方にある場合は手元を優先します。
- 手元のエピソードを読める評価では、表示用の `summary` を論理集計し直します。手元にない場合や読めない場合は保存済みの集計を使い、`eval.json` 自体は変更しません。
- `differences` では、`tasks`・`seeds`・`models`・`config_flags`・`eval_set` を比べ、違う項目を返します。
- 他のメンバーが書いた `eval.json` は信用できない入力として扱います。スキーマ・型・文字列の長さ・IDの形式を検証し、不正なものは理由付きで一覧に出し、画面全体を壊さないようにします。

### 2.3 評価一覧 `/evals`

| 日付 | 実行者 | 変更した部品 | 成功率 | コミット | 状態 |
|---|---|---|---|---|---|
| 11/18 09:30 | kitatani | 把持位置の修正 | 基準 62% → 70%（+8） | a1b2c3d＋未コミット | |

- 1行が1回の評価です。押すと比較ページを開きます。新しい順に並べ、絞り込みはありません。
- 状態の表示は次の3つだけです。
  - **実行中**：`running` で、`heartbeat_at` が5分以内
  - **中断**：`interrupted`、または `running` で `heartbeat_at` が5分より前
  - **欠損あり**：`completed` で、`incomplete` が1以上
- 問題なく終わった評価には、状態を表示しません。
- 試行画面のヘッダーにある「評価一覧」から開きます。この表をチーム共通の閲覧先にします。

### 2.4 評価の比較 `/evals/<評価ID>`

```
把持位置の修正 ・ kitatani ・ 11/18 09:30                    基準 13/20 → 今回 14/20（+5pt）
条件の違い：seed（基準 401–404 / 今回 401–403）               悪化 2件

                     seed 401  402  403  404
two_arm_lift   基準        ●    ●    ×    ●
               今回        ●   [×]   ●    ●      [×] = 悪化（基準は成功）
cube_lifting   基準        ×    ●    ●    ×
               今回        ●    ●    ●    ×
```

- 行はタスクごとです。runに条件が2つ以上ある場合だけ、行をタスクと条件の組にします。それぞれ「基準」と「今回」の2段にし、列は両方のseedを合わせて並べます。
- セルの表示は、成功●、失敗×、未判定–、実行中…、記録なしは空欄です。
- 同じseedに再試行がある場合は最後の試行を表示し、セルに「再試行あり」の印を付けます。
- **悪化**（基準は成功、今回は失敗）は、色に加えて枠と文字でも示します。表の上に件数を出します。
- セルを押すと `/traces?run=<評価ID>&episode=<episode_id>` を同じタブで開きます。戻るボタンで比較ページに戻れます。
- 基準がない評価では、「今回」の段だけを表示します。
- `eval.json` の集計と表から数えた数が違う場合（GMOの一覧にはrunnerの記録がないため）は、その旨を1行出します。
- 振り分けは `web-ui/src/main.tsx` でパスを見て行います。サーバーは今も、未知のパスに `index.html` を返しています。

### 2.5 試行を開いたときの自動取り込み

- `TraceViewerPage` で、URLのrunとエピソードが手元にない（APIが404を返す）とき、GMO連携が有効なら次の順に進めます。
  1. `/api/gmo/episodes?scope=all` から該当する行を探す
  2. `POST /api/gmo/fetch` で取り込みを始める
  3. `/api/gmo/jobs` で完了を待つ
  4. 終わったら、その試行を開く
- 取り込み中は「GMOから取り込み中（大きさ）」と表示します。
- GMOにない、1 GiBの上限を超える、同じ名前のrunが複数の場所にある、のいずれかの場合は、理由と比較ページへ戻るリンクを表示します。
- GMO連携が無効なら「手元にありません。GMO連携を有効にすると自動で取り込みます」と表示します。
- 取り込むのは、URLで開いた1件だけです。まとめて取り込むことはしません。

## 3. チームでviewerを見る

- GMO側では `CAPX_TRACE_DIR=<shared_root>/<ユーザー名>` に記録します。hype-agentの `HYPE_TRACE_ROOT/<ユーザー名>` と同じ場所です。評価の記録は `<shared_root>/<ユーザー名>/<評価ID>/eval.json` に置かれます。
- チームのグループが `eval.json` を読めて、runディレクトリを検索できる必要があります。親ディレクトリもチームが辿れるようにし、記録先をチームのグループ所有にしたうえで `umask 027` などを使います。ラッパーは作成直後にファイルのグループ読み取り権限とrunディレクトリのグループ検索権限を確認し、不足していれば「チームのviewerに表示されない」ことと対処を標準エラーに1行出します。権限は変更せず、評価を続けます。
- 各メンバーは自分のPCでviewerを起動し、[GMOの接続設定](gmo.md#gmoの記録を手元へ取ってくる)で `shared_root` に共通の記録フォルダーを指定します。一覧取得は各自のGMOアカウントで、自分とチームの `eval.json` を読みます。
- 試行画面のヘッダーにある「評価一覧」から `/evals` を開き、行を押して `/evals/<評価ID>` で基準との比較を見ます。

ラッパーの `publish(eval_record)` sink hookは未使用の拡張点として残します。既定のsinkは空で、評価結果の閲覧には使いません。

## 4. 共有HTML一覧（E06）

`capx_trace_recorder.eval_index` は標準ライブラリだけで `<shared_root>/*/ev-*/eval.json` と `<shared_root>/ev-*/eval.json` を読み、1つのHTMLを生成します。Viewerのインストールは不要です。ラッパーは実行中の記録を書いた後と終了後に呼び出し、失敗は警告に留めます。`CAPX_EVAL_INDEX=0` または `eval --no-index` で自動更新を止められます。

Viewerの集計モジュールがあり、評価フォルダーのエピソードを読める場合は論理集計し直します。それ以外は保存済みの集計を使います。全体とタスク別の試行数にやり直しがあれば、`36 / 70（やり直しを含めると 93 回）` のように表示します。

生成は出力先の隣のファイルで `fcntl.flock` を取り、同じディレクトリの一時ファイルから置き換えます。ファイルはディレクトリのグループに合わせて `0664` にし、ディレクトリは変更しません。自由入力はHTMLエスケープし、評価IDを検証してからViewerへのリンクに使います。ルート外へのシンボリックリンクは辿りません。読めない記録や不正な記録は、ほかの結果と分けてページ内に示します。

開き方と手動再生成のコマンドは [HTML一覧の使い方](evals.md#viewerを起動せず一覧を見る) を参照してください。

## 5. 作らないもの（初期設計）

- 一覧の絞り込み、検索、成功率の推移グラフ
- 任意の2つの評価を選んで比べる機能（比較相手は実行時の `--baseline` で決まります）
- 画面からの記録の編集やメモ
- 1回の評価を複数のSlurmジョブに分けて実行すること（第1段階では、1ジョブを1評価とします）
- 録画の保存期間の管理（決まったら別途。消す場合も、表を作れるように `episode.json` は残します）

## 6. 他チームと確認すること

- **評価を実行する担当（E04・E05）**
  - 評価はCaP-Xのrunnerを通して動かしますか？ ASPIREなどCaP-X以外にすると、recorderが試行を記録できません。
  - 1回の評価を、複数のSlurmジョブ（アレイジョブなど）に分けて実行しますか？
- **評価条件を決める担当（E07）**
  - 評価セット（タスク・seed・試行数）と、`--eval-set` に使う名前
  - 成功の定義（1.5）

## 7. 実装の順番と完了の条件

1. `capx_trace_viewer/evals.py`：`eval.json` の検証、成功の判定、集計。TypeScript版と判定が一致するかのテストを含みます。
2. `python -m capx_trace_recorder eval`：テストでは次の場合を確かめます。
   - 終了コード0、0以外、SIGTERMを受けたとき
   - `heartbeat_at` の更新
   - エピソードが1つもないとき
   - `CAPX_TRACE_DIR` が未設定、または `CAPX_TRACE_RUN_ID` が設定済みのとき
   - gitにコミットしていない変更があるとき
3. GMOの一覧取得と取り込みの変更、`/api/evals`：手元の記録とGMOの一覧の両方からテストします。
4. 画面：`/evals`、`/evals/<評価ID>`、自動取り込み。悪化の強調、再試行、空欄、条件の違いの表示をテストします。
5. ドキュメント：使い方は `docs/replay.md` か新しい `docs/evals.md` に書き、READMEには短い節と案内を足します。

ブラウザでの確認用に、`scripts/make_replay_demo.py` を拡張して、基準と改良の2つの評価（悪化を1件含む）を合成デモとして作れるようにします。

**完了の条件**

- READMEの「検証」にあるPythonテストと、web-uiのテスト・ビルドが通ること
- 合成デモで、次の流れをブラウザで確認できること
  - 一覧から比較ページを開く
  - 悪化したセルを押して試行を開く
  - 手元にない試行は、GMOからの取り込みに進む（GMOとの通信は模擬で可）
