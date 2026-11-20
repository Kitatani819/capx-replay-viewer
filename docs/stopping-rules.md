# 試行と評価が止まる規則

照合元は公開競技実装 [`matsuolab/geniac_prize_2026_code`, `d64344d`](https://github.com/matsuolab/geniac_prize_2026_code/tree/d64344d) です。以下のパスと行番号はこのコミットを指します。「公式」は gateway / referee / evalqueue による採点経路、「ローカル」はシミュレーターを直接動かす CaP-X runner（route A）です。公開されているエージェント実装の既定値は、任意の提出物に課される競技規則とは区別します。

## 公式の制限

| 規則 | 値と動作 | 公開実装の出典 |
| --- | --- | --- |
| 試行のステップ数 | `repeat` を含む制御サイクルを数え、上限で `truncated=true`。上限後の呼び出しは進めない | [`capx/gateway/gateway.py:213–277`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/gateway.py#L213) |
| ジョブ全体の時間 | `trial_time_s=300` 秒 × 対象タスクの試行総数。最初の gateway 接続から測り、超過後は `job_timeout`。evalqueue もコンテナを停止する | [`capx/protocol/taskpack.py:248–256`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/protocol/taskpack.py#L248)、[`capx/gateway/referee.py:90–98,192–197`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/referee.py#L192)、[`capx/evalqueue/runner.py:952–1017`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/evalqueue/runner.py#L952) |
| 試行回数 | タスクごとの `n_trials` を使い切ると `trials_exhausted`。未実施の試行も採点分母に入る | [`capx/gateway/referee.py:125–140`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/referee.py#L125)、[`capx/gateway/scoring.py:52–72`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/scoring.py#L52) |
| 環境の異常終了 | reset、step、観測、報酬計算などの例外で `env_crash`。試行とスコアを無効化し、回数を返却。同じ試行番号・seed を再利用する。ジョブ時間は返らない | [`capx/gateway/gateway.py:411–423`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/gateway.py#L411)、[`capx/gateway/referee.py:155–166`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/referee.py#L155) |
| シミュレーター horizon | 通常は `trial_steplimit + 10000` を渡し、gateway のカウントを優先。早期に horizon に到達した場合も試行終了として扱い、返金しない | [`capx/gateway/env_build.py:18–35`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/env_build.py#L18)、[`capx/gateway/gateway.py:247–270`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/gateway.py#L247) |
| 途中の成功 | `repeat` の各サイクルで成功を調べ、一度成功すれば後で状態が崩れても成功。後の `env_crash` はその成功ごと無効化 | [`capx/gateway/gateway.py:234–243`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/gateway.py#L234)、[`capx/gateway/scoring.py:29–47`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/scoring.py#L29) |
| 明示的な終了・置き換え | 提出物の `finish()` は全ジョブを終了。lane の reset / close は前の試行を終了しスコアは維持 | [`capx/gateway/referee.py:100–123`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/referee.py#L100)、[`capx/gateway/gateway.py:173–182,286–306`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/gateway.py#L286) |
| action の検査 | `repeat=1..200`、有限値・次元・公開 joint 範囲・gripper `0..1`。違反は `invalid_action` で拒否するが gateway は試行を継続可能 | [`capx/protocol/actions.py:26–46,60–193,240–274`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/protocol/actions.py#L26)、[`capx/config/defaults.yaml:7–19`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/config/defaults.yaml#L7) |
| 通信・接続・観測の境界 | 要求は 1 MiB、フレームは 64 MiB、同時 lane は構成値（既定 robosuite / libero 各 32）。観測は許可カメラ・自己状態のみ。大きすぎるフレームや切断は lane を閉じることがある | [`capx/gateway/server.py:28–49,94–116`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/server.py#L28)、[`capx/protocol/framing.py:34,126–165`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/protocol/framing.py#L126)、[`capx/protocol/observations.py:85–146`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/protocol/observations.py#L85) |
| 環境 backend の待ち時間 | 接続開始 120 秒（evalqueue では構成値 600 秒を渡す）、呼び出し 1800 秒、空き backend の待機 1800 秒。失敗は `env_crash` になり得る | [`capx/gateway/env_backend.py:160–171,216–227,331–340`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/gateway/env_backend.py#L160)、[`capx/evalqueue/config.py:139`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/evalqueue/config.py#L139) |
| 起動・保存容量 | 初回接続まで既定 21600 秒。出力と HOME 合計 20 GiB / 100000 項目で超過停止（30 秒ごとに検査） | [`capx/evalqueue/config.py:130–145`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/evalqueue/config.py#L130)、[`capx/evalqueue/scratch.py:30`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/evalqueue/scratch.py#L30) |
| ラウンド締切・待機提出の置き換え | 設定された締切で実行中・待機中を `cancelled`。同一チームの上限（既定 1）で古い待機提出を新しい提出に置き換える | [`capx/evalqueue/deadline.py`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/evalqueue/deadline.py)、[`capx/evalqueue/watcher.py:476–494`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/evalqueue/watcher.py#L476) |
| worker / Slurm 停止 | Slurm の時間値はジョブ構成に依存し、一律の値はない。公式 worker は SIGTERM / SIGINT で評価をキューへ戻し結果を公開しない。worker 消失を伴う再実行は 3 回まで | [`capx/evalqueue/config.py:226–227`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/evalqueue/config.py#L226)、[`capx/evalqueue/worker.py:44–51,85–98,123–184`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/evalqueue/worker.py#L85) |

`trial_time_s` は「1 試行 300 秒で打ち切る」という意味ではありません。公式経路には試行単位の wall-clock 制限がありません。[公開説明 `docs/taskpacks.md:13–15`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/docs/taskpacks.md#L13) もこの区別を明記しています。

### original パックのステップ上限

| タスク | `trial_steplimit` | `taskpacks/original/pack.yaml` |
| --- | ---: | --- |
| cube_lifting | 1500 | 18 行 |
| cube_stack | 1500 | 42 行 |
| cube_restack | 1500 | 66 行 |
| nut_assembly | 1000 | 90 行 |
| spill_wipe | 4000 | 114 行 |
| two_arm_lift | 5000 | 138 行 |
| two_arm_handover | 5000 | 162 行 |
| 上記以外の original パック掲載タスク | 8000 | 7 行（既定） |

機械可読の照合表は [`capx_trace_viewer/official_rules.json`](../capx_trace_viewer/official_rules.json) です。公開チェックアウトから `python scripts/generate_official_rules.py <checkout>` で再生成します。参照コミット、task ID、値、行番号を含み、未知の task ID に既定値を推測して適用しません。

## エージェントとローカル runner の制限

| 規則 | 公開実装の既定値と動作 | 公開実装の出典 |
| --- | --- | --- |
| 1 試行の wall-clock | ローカルは 1000 秒、timeout 時の試行は最大 3 回。reset 後にタイマーを再設定。記録値が優先 | [`capx/envs/runner.py:38–42,210–243,270–317`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/runner.py#L38)、[`capx/envs/trial.py:780–786`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/trial.py#L780) |
| 書き直し・ターン | `MULTITURN_LIMIT=10`。先頭ブロックを含め最大 11 ブロックを実行。複数ブロックの応答では「10 回書き直し」と一致しない場合がある | [`capx/envs/trial.py:51,916–918,951–953`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/trial.py#L916) |
| FINISH と暗黙の終了 | `FINISH` または `REGENERATE` がない応答を finish と解釈。終了後に実際の達成判定を別に見る | [`capx/llm/client.py:468–478`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/llm/client.py#L468)、[`capx/envs/trial.py:1000–1011`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/trial.py#L1000) |
| single-shot | 初回に生成したプログラムを実行し、multi-turn prompt がなければ FINISH / REGENERATE を問い合わせず終了。初回応答が複数のコードブロックを含む場合もある | [`capx/envs/trial.py:874,916–953`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/trial.py#L916) |
| コード実行 | 独立した実行秒数制限は見つからない。直接 `exec` し、ローカルでは試行全体の alarm が中断する。通常の例外は stderr としてモデルへ返す | [`capx/envs/tasks/base.py:189–219`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/tasks/base.py#L189) |
| Web UI のコード実行 | `execution_timeout` は既定 180 秒 / block。待機を打ち切り、reset を試みてブロックループを抜ける（実行スレッドの停止を保証する仕組みではない）。Web UI の `MULTITURN_LIMIT` は 30 | [`capx/web/async_trial_runner.py:57,500–522`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/web/async_trial_runner.py#L500)、[`capx/web/session_manager.py:82`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/web/session_manager.py#L82) |
| ローカル horizon・達成判定 | シミュレーターの `max_steps` と `_sim_step_count` で打ち切る。高位コードの実行終了時に報酬・`task_completed()` を読む。公式は各サイクルの成功を保持する | [`capx/envs/tasks/base.py:297–332`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/tasks/base.py#L297) |
| LLM 通信 | 1 接続応答待ちは既定 900 秒、再試行と本文読取を含む期限は 1800 秒。429 / 502 / 503 / 504 と通信エラーを再試行。他の HTTP エラーは直ちに失敗 | [`capx/llm/client.py:115–120,157–160,278–314`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/llm/client.py#L278) |
| モデル出力・context | `max_tokens` は呼び出し設定値。長さ超過は `finish_reason=length`。context 上限・画像数はモデルサーバー設定に依存し、公式パックの共通規則ではない | [`capx/llm/client.py:123–145,353`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/llm/client.py#L123) |
| サービス API | 共通 POST は既定 120 秒 / 5 attempts（実際の総時間は最後の要求で超える場合あり）。PyRoKI IK は 15 秒。GraspNet HTTP は 900 秒、内部候補探索は既定 10 回。Molmo は 120 秒 × 最大 3 attempts、失敗後は空の点を返す | [`capx/utils/serve_utils.py:9–47`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/utils/serve_utils.py#L9)、[`capx/integrations/motion/pyroki.py:43`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/integrations/motion/pyroki.py#L43)、[`capx/integrations/vision/graspnet.py:21,139–177`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/integrations/vision/graspnet.py#L139)、[`capx/integrations/vision/molmo.py:275–318`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/integrations/vision/molmo.py#L275) |
| gateway の無効試行を再実行 | 公開エージェントは `env_crash` / 切断の再実行を 2 回まで。gateway 自身の採点規則とは別のエージェント設定 | [`capx/submission/runner.py:56–74,369–378`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/submission/runner.py#L56) |
| 動作 helper の途中停止 | サーボ動作は `max_steps` / 収束条件で戻る。これは試行の上限とは別。計画探索もサービス内の試行数・時間で失敗し得る | [`capx/envs/simulators/robosuite_base.py:171–185`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/simulators/robosuite_base.py#L171)、[`capx/serving/launch_curobo_server.py:71–87`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/serving/launch_curobo_server.py#L71) |

ローカルと公式の比較では、ステップの設定値だけでなくカウントの主体、成功判定時点、クラッシュ時の試行返却、ジョブ時間と試行時間、再試行回数、ターン数、モデル context を確認します。最新公開版の robosuite reset は settling 分を horizon から戻します（[`robosuite_base.py:150–160`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/simulators/robosuite_base.py#L150)）。古いトレースへ最新の動作を遡って仮定しません。

## 表示と証拠の読み方

Viewer は大分類 `reason` と具体的な `cause` をチーム向けの言葉で説明します。single-shot の通常終了には `reason=single_shot` / `cause.code=single_shot` を追加し、既存の分類も引き続き使えます。試行の要約には、太字の原因と数字（例：「ステップ上限に到達（1000/1000 ステップ）」）と、短い日本語の説明を表示します。技術的な根拠、公開規則へのリンク、不足している記録は、閉じた「根拠を見る」にまとめます。通常の表示と表のツールチップには生のフィールド名を出しません。

試行の実際の上限が記録されていない場合、公式パックの値をその試行の上限として埋めません。説明には「この記録には実際の上限値が残っていません（公式の上限は 1000）」のように、タスクごとの `official_rules.json` の値を比較用として示します。書き直し回数だけが分かる場合も「書き直し 10 回で終了（上限の設定は記録なし）」と、分かる範囲を表示します。成功は `TrialSummary.success`（コードがエラーなく終了した意味）から判断せず、達成判定を使います。

比較表のセルと凡例は、Python の終了原因の定義と、その TypeScript の対応表を共通の出発点にします。凡例はセルに出る語を説明し、古い大分類の語だけを並べません。ツールチップは「数字を含む原因」「短い日本語の説明」「試行を開く」の順とし、同じラベルを繰り返しません。「失敗の内訳」は、時間切れ・打ち切り、未判定、未達成、書き直しの上限、single-shot、エラー、不明の各グループで原因別の件数と、開閉できる試行一覧を表示します。成否が未判定でも、記録から分かる停止原因は表示できます。

「公式の評価と条件が違います」では、記録や公開実装で確認できる次の違いを、1項目につき短い1文と公開ルールのリンクで表示します。表示は先頭3項目までとし、残りは「ほかの違い」にまとめます。

- 公式にはない、記録済みの1試行の時間制限。
- 成功判定の時点。公式では動作サイクルの途中で一度でも成功すれば成功とし、ローカル runner はコードブロック終了時にだけ調べます。ブロック終了前に状態が崩れるとローカルでは未達成になる場合があります。
- 時間切れ後の再試行。公開ローカル runner は合計最大3回まで試します。公式には試行ごとの時間制限がなく、それによる再試行もありません。記録済みの設定や再試行の証拠を確認し、現在の既定値を古い試行の設定値として補いません。
- 記録されたステップ上限と公式パックの値の違い。たとえば LIBERO の記録が4000なら、公式の8000と比較します。記録がない場合は差があると断定しません。

「分類は記録から自動で推測したもので、外れることがあります。」という注意は表示に残します。

- `episode_end.end_reason=timeout_alarm` / `alarm_seen=true` は試行の alarm。単に `truncated=true` で wall-clock 超過とは断定しません。
- `code_block_end.sim_step_range` はコード前後のカウント。古い記録では終端の厳密なカウント・horizon・適用上限がない場合があり、最後の snapshot と実際の終端には差があり得ます。
- `model_output_parsed.decision` と `model_said_finish` は finish の解釈、`harness_summary.num_regenerations` は書き直し数です。書き直し上限の設定値がなければ回数だけで到達を推測しません。
- `api_call_error` / `model_error` / `service_call_error` / `code_block_end.exception` / `episode_end.exception` は失敗した呼び出しと例外を示します。途中で回復したエラーを最終原因にしません。
- `end_reason=stopped_by_user` / `cancelled_replaced` は停止ボタン・セッション置換です。recorder が取り残された episode を閉じた場合は `end_reason=error` と `end_note` が残ります。これらは Slurm による終了を意味しません。
- `eval.json.end.signal=15` だけでは、Slurm timeout、手動停止、ほかの SIGTERM の区別ができません。Slurm の状態、job ID、終了時刻などの明示記録が必要です。
- `runner_records.jsonl` がない場合、達成判定が recorder から得られない試行もあります。判定不能時は不足している項目を示し、未達成と断定しません。

記録フィールドの正確な定義は [`trace-format.md`](trace-format.md) を参照してください。

## single-shot の通常終了

`single_shot` は「1回だけ実行して終了（single-shot）」、比較表のセルは「1回実行」と表示します。課題の成功・失敗は別に判定し、正常なコード実行を課題成功にはしません。

判定には `source=envs.runner`、明示的な `config_flags.multi_turn=false`、`end_reason=completed`、完全な記録、1個以上の実行ブロック、書き直し・FINISH 各0回、`sandbox_rc=0`、`terminated=false` を使います。`multi_turn` は recorder が multi-turn prompt の有無から記録する値で、`episode.json` または `episode_start` から読みます。FINISH / REGENERATE の判断がある記録には適用しません。成功、例外、時間切れ、ステップ・ターン上限などの具体的な記録を優先します。設定や終了の裏付けがなければ「不明」または「記録中断」を維持します。

GMO の LIBERO job 50139 を読み取り専用の SSH と既存エクスポートで照合しました。`completed`、`trace_complete=true`、`multi_turn=false`、1ブロック・116/8000ステップ、`sandbox_rc=0`、`task_completed=false`、書き直し・FINISH 各0回、`terminated=false` / `truncated=false` が記録され、抽出パーサーの `decision=null` の後に正常な `episode_end` がありました。終了判断がないことは、このモードの正常な動作です。テストにはこの構造の最小限の合成データを使い、実トレースや接続情報を含めません。判定結果は根拠フィールドと公開の [`capx/envs/trial.py:953`](https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/envs/trial.py#L953) を示します。

## 評価全体の準備・実行失敗と未完了

評価ラッパーは `eval.json.summary.config_flags.evaluation_failure` に任意の診断を記録します。`kind` は `infrastructure`（準備・workerなどの失敗）または `incomplete`（未完了）、`reason` は理由です。個別の失敗があれば `infrastructure_failures` に `{task, seed, reason}` を最大100件、`count` に総件数を保存します。task / seed は不明なら null です。評価の `status` は `interrupted` のままで、`end.exit_code` は実際の子プロセスの終了コードです。終了コード0でもラッパーの完了確認が失敗する場合があるため、表示には診断を使います。

評価一覧と共有HTML一覧は「評価失敗」または「未完了」を示し、理由・課題・seed をツールチップで読めます。比較ページの先頭にも「この評価は準備・実行の失敗で止まりました：…」などの日本語を表示します。基準評価に診断があれば基準の失敗も示します。試行から成功数を再集計しても評価全体の診断を保持し、実験条件の差分には含めません。診断のない古い記録と、課題自体に失敗した通常の評価は既存の表示を保ちます。
