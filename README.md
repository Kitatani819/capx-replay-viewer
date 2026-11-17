# CaP-X Replay Viewer

CaP-Xの録画を見ながら、その場面の観測、モデルの入力・回答、実行されたPythonをブラウザで確認するviewerです。
[nawta/capx-trace-viewer](https://github.com/nawta/capx-trace-viewer) の `35ce4bb` をベースに、既存の動画再生・フレーム同期・ログ表示を拡張しています。

## できること

- **左にMP4、動画の下に処理一覧、右に「入出力」「候補」「統合結果」の3タブ**を表示します。採用案Aに合わせて、設定・ID・詳細ログは必要なときだけ開く構成です。
- 再生・シークに対応する処理を強調します。同じ動画位置の処理も個別に選べ、停止したまま右の詳細を切り替えられます。
- SAM3の入力画像・対象指示・マスク、VDMの比較画像・説明、生成プロンプト・回答、実行Python・stdout/stderrを記録から表示します。
- 並列候補は1件ずつ選んで読み、統合結果は別タブで確認します。候補数は記録に従い、共通入力、temperature、エラー・打ち切りを確認できます。
- **「APIとPython」** では、動画の下に時刻付きAPI一覧と実行Python全文を並べます。再生・シーク・APIの選択に合わせて、呼び出し行が見える位置までコード欄内をスクロールします。試行を切り替えても「APIとPython」の表示を引き継ぎます。APIの説明はホバーで確認できます。右には、そのPythonを生成したモデルの入力と回答を表示します。[操作と記録条件](docs/replay.md#apiとpythonを同時に追う)
- 同期情報が足りない場合は「同期情報なし」と表示し、MP4の再生を維持します。保存されていない入力やマスクは復元・推定しません。

個人の接続設定・秘密鍵・GMOの実験ログは含めません。まず同梱スクリプトで作る**合成デモ**で操作を試せます。viewerは閲覧専用で、試行やモデル推論を開始しません。

## デモ映像

GMOで実行した `two_arm_handover`（seed 302）の録画です。2台のアームがハンマーを受け渡します。

![GMOで実行したハンマーの受け渡し](docs/media/gmo-two-arm-handover.gif)

[録画（MP4、14.53秒）](docs/media/gmo-two-arm-handover.mp4?raw=true)

## ビューアの画面例

GMOで実行した `two_arm_handover`（seed 302）の画面です。9.07秒の `goto_pose_arm1` を選択し、録画とAPIの引数・戻り値を表示しています。

![GMOの録画と9.07秒のAPI呼び出しの詳細](docs/media/replay-layout.png)

「APIとPython」では、13.73秒の `goto_pose_arm0` に対応する実行コードの38行目が、動画と同時に見えます。

![GMOの録画とPythonの38行目を表示する「APIとPython」](docs/media/api-python.png)

## GMOで使う

**[GMOへの接続・計算ノードでのセットアップ・ブラウザ接続](docs/gmo.md)** を参照してください。
ログインノードでインストールや長時間のviewer起動をせず、計算ノードで動かしてSSHで手元のブラウザへ転送します。録画の閲覧にGPUは不要です。

GMOから取得済みの記録はローカル環境で表示確認していますが、**GMOの計算ノード上でのviewer起動と、そのノードへのSSH転送は未確認**です。ノードの接続制限は利用環境の案内に従ってください。

## 対応環境

| サーバーを動かす環境 | 起動方法 |
|---|---|
| Linux | `bash Start-Replay.sh` |
| macOS（Apple Silicon / Intel） | `bash Start-Replay.sh`。PythonとNode.jsはそのMac用のものを使います。 |
| Windows | WSL/Ubuntu内でサーバーを動かす `Start-Replay.ps1` |

ブラウザでの閲覧はWindows・Linux・macOSで共通です。GMOなど別のLinuxマシンでサーバーを動かす場合、手元にはブラウザとSSHだけあればよく、手元へのPython・Node.js・WSLの導入は不要です。

録画済みの閲覧・合成デモにCaP-X本体やGPUは必要ありません。OSごとの実行確認範囲は[検証](#検証)に記載しています。

## Linux / macOSでデモを起動する

必要なものはGit、Node.jsとnpm、Python **3.10～3.12**です。対応するPythonが見つからない場合は、導入済みの `uv` でPython 3.12を取得することもできます。開発時の構成はPython 3.12、Node.js 24.19.0、npm 11.17.0です。macOSの標準ターミナルからも同じコマンドを実行できます。

```bash
git clone https://github.com/Kitatani819/capx-replay-viewer.git
cd capx-replay-viewer
cd web-ui
npm ci
npm run test:trace
npm run build
cd ..
bash Start-Replay.sh
```

同じPCのブラウザで **http://127.0.0.1:8390/traces** を開きます。停止はサーバーの端末で `Ctrl+C`。
初回は専用のPython環境へ依存パッケージを導入し、合成デモを `outputs/geniac_demo` に生成します。既存データは上書きしません。環境の保存先はLinuxで `~/.cache/capx-geniac-replay`、macOSで `~/Library/Caches/capx-geniac-replay` です（`XDG_CACHE_HOME` を指定した場合はそちらを使います）。OSのPython環境や別のプロジェクトの仮想環境は変更しません。

2回目以降はプロジェクト直下で `bash Start-Replay.sh` を実行します。更新後に画面をビルドし直す場合は `web-ui` で `npm ci` と `npm run build` を実行してください。

デュアルブートのUbuntuでは、Ubuntu側のホームディレクトリにこのリポジトリを取得して、この手順を実行してください。Windows側の `.venv` や `node_modules` はOSごとの実行ファイルを含むため流用しません。録画・ログは、Ubuntuから読める保存先を `--trace-root` / `--runner-root` で指定できます。

自分で用意したPython環境を使う場合は、必要なパッケージを導入して明示できます。この指定ではランチャーからパッケージを追加しません。

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
bash Start-Replay.sh --python .venv/bin/python
```

操作は **試行を選ぶ → 再生 → 気になる場面で停止 → 動画下のログを選ぶ → 右の入出力 → 候補 → 統合結果** です。[操作の詳細](docs/replay.md)も参照してください。

## 自分の録画・ログを開く

```bash
bash Start-Replay.sh --port 8390 \
  --trace-root /absolute/path/to/traces \
  --runner-root /absolute/path/to/runner
```

指定するのは各試行の親となるルートディレクトリです。`--trace-root` は `<run>/<episode>/events.jsonl` を含む親、`--runner-root` は `<run>/run.json` と `<run>/<task>/<condition>/trial_*/` を含む親です。詳しい配置は[データの置き方](docs/replay.md#データの置き方)を参照してください。

MP4だけの記録もrunner形式で表示できますが、処理ログがなければ同期や入出力表示はできません。同じ試行の動画・ログ・画像をまとめて指定してください。

既存の `.venv/bin/python -m capx_trace_viewer.server --viewer-only ...` による直接起動も引き続き使えます。複数のrunnerルートや別のフロントエンド配信先などを指定する場合は、この起動方法を利用してください。

## Windows / WSL

ローカルでサーバーを動かす場合は、WSLのUbuntuと、その中で利用できるPython 3.10～3.12または `uv` が必要です。リポジトリを取得後、PowerShellで実行します。

```powershell
cd web-ui
npm ci
npm run test:trace
npm run build
cd ..
.\Start-Replay.ps1
```

このランチャーはLinux / macOSと共通の起動処理をWSL内で実行し、専用のPython環境と、必要なら合成デモを作ります。初回は依存パッケージを取得します。`uv` を使う場合は必要に応じてPythonも取得します。

```powershell
.\Start-Replay.ps1 -Port 8391 -TraceRoot 'C:\data\traces' -RunnerRoot 'C:\data\runner'
```

Linux / macOSの安全なファイル読み出し機能を利用するため、WindowsネイティブのPythonでサーバーを動かす構成はサポートしていません。対応しない環境では起動時に案内を表示します。Windowsのブラウザでの閲覧やOpenSSHによるGMOへの接続には、この制限はありません。

## 検証

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -e '.[dev,demo]'
cd web-ui
npm ci
npm run test:trace
npm run build
cd ..
.venv/bin/python -m pytest tests -q
.venv/bin/python -m playwright install chromium
```

別端末で `bash Start-Replay.sh --python .venv/bin/python` を起動してから、次を実行します。

```bash
.venv/bin/python scripts/demo/check_replay_layout.py --base-url http://127.0.0.1:8390
```

GitHub ActionsでLinux・macOSのバックエンドテスト、フロントエンドのテストとビルド、合成デモのブラウザ操作を実行します。[2026-11-16のAPI/Python試作の検証結果](https://github.com/Kitatani819/capx-replay-viewer/actions/runs/43729932868)は両OSとも成功です。

| 環境 | Pythonテスト | フロントテスト / ビルド | ブラウザ操作 |
|---|---|---|---|
| Ubuntu（GitHub Actions、x86_64） | 1,491成功・24スキップ | 214成功 / 成功 | 16項目成功・例外0 |
| macOS 26（GitHub Actions、Apple Silicon） | 1,444成功・71スキップ | 214成功 / 成功 | 16項目成功・例外0 |

手元のWSL/Ubuntuでは、今回Linuxブラウザ操作16項目が成功しました。前回のPythonテスト1,491件、初回Python環境作成（通常のvenvとuv）からの起動、Windowsで未対応理由を案内するテストも成功しています。Intel Macと、このPCをデュアルブートのUbuntuで起動した状態の実機確認は未実施です。

ビルドは成功しますが、ブラウザ互換性データの更新案内と、gzip圧縮前のJavaScriptが500 kBを超える警告が残っています（約503 kB、gzip後約166 kB）。

確認した内容:

- 2026-11-16のAPI/Python試作では `test:trace` 214件、ビルド、WindowsとWSL/Linuxのブラウザ16項目が成功。`goto_pose`と3行目の同時表示、ホバーで位置・選択が変わらないこと、同時刻の個別選択、前後コード、正確な生成元入出力、既存3タブを確認。最初のAPIより前への巻き戻しと、ターンフィルターの選択不一致には回帰テストを追加しています。

- 合成デモで再生・停止、SAM3・VDM・Pythonの入出力、候補・統合結果を確認。GMOから取得済みの記録のローカル表示は前回検証で8項目成功しています。OS別CIには実験データを含めず、合成デモだけを使っています。
- 同位置の複数イベント・候補選択、停止位置の保持、マスクの拡大、未記録の表示、MP4のみ、狭幅・動きを減らす設定を確認。
- モデル呼び出しだけに絞った状態からPythonへ移動すると対象行が隠れる問題と、録画切替後に再生ボタンの状態が残る問題を修正。
- 一覧から開いた直後のSAM3選択と右欄の一致、イベント指定URL、再生中・Live中の履歴移動、候補9件／3件、デバッグ表示が1組だけになること、注意帯の指定配色（約8.22:1）を確認。
- OS別検証で見つかった詳細ログのスクロール補正による連続更新を修正し、旧実装では失敗する回帰テストを追加。macOSに存在しない `/proc` に依存していたレコーダーのテストも、ファイルの識別情報を使う方法へ修正。
- 実行中の応答をブラウザ内で模擬し、Liveの新着追従、再生による閲覧への切り替え、Live再開時の動画停止を確認。実際のGMO上で記録中の試行を使ったLive検証は未実施です。

トレースを記録したGMOの `two_arm_handover`（seed 301、Oracle）で、APIとPythonの同期表示とシーク位置の保持を確認しました。Chromeでseed 302の13.73秒の動画と38行目を同時に表示できることと、seed 301に切り替えても「APIとPython」が維持されることを確認しました。モデルの入出力、候補と統合結果は合成デモで確認しています。呼び出し行には `call_site`、モデル入出力には `source_model_event_id` と要求・回答の記録が必要です。 [操作と検証](docs/replay.md#検証)

## 記録形式とライセンス

- [trace-format](docs/trace-format.md): イベント・payload・画像・フレーム・同期の仕様。
- [元viewerのREADME](docs/upstream-readme.md): recorderの導入、元の画面、詳細な検証方法。
- [MIT License](LICENSE): 上流のライセンスと著作権表記を保持しています。

サーバーに認証機能はありません。既定の `127.0.0.1` のまま利用し、遠隔閲覧にはSSH転送を使ってください。GitHubリポジトリの非公開設定は、起動したHTTPサーバーへのアクセス制御にはなりません。
