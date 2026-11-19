"""Browser acceptance of a sequential evaluation resume, using synthetic trials only."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from capx_trace_recorder.eval import run_eval


def child_code(seeds: list[int], expected: list[int]) -> str:
    return f'''
import json, os, time
from pathlib import Path
root = Path(os.environ['CAPX_TRACE_DIR']) / os.environ['CAPX_TRACE_RUN_ID']
done = json.loads(Path(os.environ['CAPX_EVAL_COMPLETED_TRIALS_FILE']).read_text())
assert [item['seed'] for item in done] == {expected!r}, done
segment = int(os.environ['CAPX_EVAL_SEGMENT'])
(root / 'planned-trials.json').write_text(json.dumps([{{'task':'synthetic_cube','condition':None,'seed':seed}} for seed in range(1,5)]))
(root / 'evaluation-budget.json').write_text(json.dumps({{'schema':'capx-eval-budget/1','limit_s':1200}}))
(root / f'evaluation-clock-{{segment}}.json').write_text(json.dumps({{'budget_s':1200,'used_before_s':float(os.environ['CAPX_EVAL_USED_BUDGET_S']),'started_at':time.time()-.1}}))
for seed in {seeds!r}:
    directory = root / f'synthetic-{{segment}}-{{seed}}'
    directory.mkdir()
    raw = {{'episode_id':directory.name,'run_id':root.name,'task':'synthetic_cube','condition':None,'seed':seed,
            'status':'ended','trace_complete':True,'episode_end_written':True,'end_reason':'completed',
            'started_wall_time':time.time(),'harness_summary':{{'task_completed':seed % 2 == 1}}}}
    (directory / 'episode.json').write_text(json.dumps(raw))
'''


def check(base_url: str, fixture: Path, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    repo = output / "synthetic-repo"
    repo.mkdir(exist_ok=True)
    if not (repo / ".git").exists():
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / "fixture.txt").write_text("synthetic resume acceptance\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "fixture.txt"], check=True)
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "commit", "-qm", "synthetic fixture"], check=True)
    trace_root = fixture / "traces"
    before = set(trace_root.iterdir())
    assert run_eval([sys.executable, "-c", child_code([1, 2], [])], trace_root=trace_root,
                    repo=repo, by="合成テスト", changed="分割評価（合成）", eval_set="synthetic-resume-4") == 0
    run = next(iter(set(trace_root.iterdir()) - before))
    errors, passed = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(12000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(base_url + "/evals/" + run.name)
            expect(page.locator(".eval-score")).to_contain_text("1/4")
            expect(page.get_by_text("未走行", exact=True).first).to_be_visible()
            passed.append("最初の2試行と未走行2件を分母4で表示、未走行を失敗として明示")
            assert run_eval([sys.executable, "-c", child_code([3, 4], [1, 2])],
                            trace_root=trace_root, repo=repo, resume=run.name) == 0
            page.reload()
            panel = page.get_by_role("region", name="分割した評価の履歴")
            expect(panel).to_contain_text("2回に分けて実行した評価")
            expect(page.locator(".eval-score")).to_contain_text("2/4")
            panel.get_by_text("各回の開始・終了と完了数", exact=True).click()
            expect(panel).to_contain_text("開始前に完了 2組、終了後 4組")
            expect(panel).to_contain_text("1200.0秒")
            assert page.get_by_text("集計と試行の表の数が異なります", exact=False).count() == 0
            detail = page.request.get(base_url + "/api/evals/" + run.name).json()
            assert detail["summary"]["trials"] == 4 and len(detail["trials"]) == 6
            page.screenshot(path=str(output / "resumed-evaluation.png"), full_page=True, animations="disabled")
            passed.append("完了2組を省いて残りを同IDに追加、試行6記録をlogical4組で集計し履歴・累積予算を表示")
            assert run_eval([sys.executable, "-c", child_code([], [1, 2, 3, 4])],
                            trace_root=trace_root, repo=repo, resume=run.name) == 0
            page.reload()
            expect(panel).to_contain_text("3回に分けて実行した評価")
            expect(page.locator(".eval-score")).to_contain_text("2/4")
            passed.append("再度のresumeで完了試行を重複実行せず、成功率と分母を維持")
            page.set_viewport_size({"width": 390, "height": 844})
            assert panel.evaluate("element => element.scrollWidth <= element.clientWidth + 1")
            page.screenshot(path=str(output / "resumed-mobile.png"), full_page=True, animations="disabled")
            passed.append("390px幅で履歴の説明がはみ出さない")
            assert not errors, errors
            result = {"passed": passed, "page_errors": errors, "fixture": "synthetic"}
            (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False))
        finally:
            browser.close()
