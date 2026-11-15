"""Write a synthetic GENIAC replay fixture, reusing the bundled demo renderer.

No robot, model API or generated Python is executed. Existing output is never
overwritten; use --out with a fresh directory when generating another fixture.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

import make_demo_trace as d


def build(root: Path) -> dict:
    root = root.resolve()
    if root.exists():
        raise SystemExit(f"Refusing to overwrite {root}; choose a fresh --out directory")
    d.RUN_ID = "geniac_replay_demo"
    run_dir = root / "traces" / d.RUN_ID
    run_dir.mkdir(parents=True)
    now = time.time()
    ep = d.EpisodeBuilder(run_dir, "cube_lifting__demo__s307__i1__a1", pid=430307,
                          t0=now-120, mono0=100, cameras=("agentview",), record_state=False)
    scene = d.Scene(np.array([.5, -.1, 1.1]), np.array([.5, -.1, .84]), np.array([.6, .13, .84]))
    start = ep.emit("episode_start", "info", {"source":"envs.runner", "task":"cube_lifting (合成デモ)",
        "condition":"DEMO", "seed":307, "attempt_index":1, "runner_invocation":1,
        "config_flags":{"use_parallel_ensemble":True,"record_video":True}, "host":"synthetic-demo", "synthetic":True})
    ep.emit("task_text", "info", {"text":"合成デモ: 赤いキューブを持ち上げる。実際のGENIAC試行ではありません。"})
    ep.buffer.append((0,scene.copy()))
    ep.save_frame(0,reason="periodic")
    _, before = ep.observation_snapshot(scene,"before_execution")
    ids: dict[str, object] = {}

    def request(turn, kind, messages, temperature=.2, thread=None, role="code_generator"):
        return ep.model_request(role=role,call_kind=kind,turn_index=turn,url="http://127.0.0.1:8000/v1/chat/completions",
            payload={"model":"synthetic-same-model","temperature":temperature,"messages":messages},
            logical_call_id=ep.new_id("lc_"),http_attempt=1,known_proxy=False,thread=thread)

    def ensemble(turn, image, answer, count=9):
        messages=[{"role":"system","content":"Synthetic fixture. Generate Python using the given robot API."},
            {"role":"user","content":[{"type":"text","text":f"Lift the red cube. Turn {turn}.\nPrevious stdout: Success!\nVDM: the cube is still below the target height."},
             {"type":"image_url","image_url":{"url":image}}]}]
        reqs=[request(turn,"ensemble_member",messages,round(.1*(i+1),1),f"ThreadPoolExecutor-0_{i}") for i in range(count)]
        complete=[]
        for i,req in enumerate(reqs):
            if count==9 and i in (7,8):
                ep.emit("model_error","error",{"scope":"logical","role":"code_generator","call_kind":"ensemble_member",
                    "logical_call_id":req["data"]["logical_call_id"],"http_attempt":1,
                    "error_type":"TimeoutError" if i==7 else "GeneratorExit", "message":"synthetic candidate error" if i==7 else "synthetic stream stopped",
                    "partial_content":"REGENERATE\n```python\n# partial stream" if i==8 else None},parent=req,refs=req["refs"],thread=req["thread"])
                continue
            text=answer if count!=9 else f"# candidate {i+1}\n{answer}"
            resp=ep.model_response(req,text,latency_s=1+i*.1,usage=None)
            if count==9 and i==6:
                resp["data"]["finish_reason"]="length"
                resp["data"]["content"]="REGENERATE\n```python\n# truncated at token limit"
                path=ep.dir/resp["data"]["payload_path"]
                body=json.loads(path.read_text());body["choices"][0]["finish_reason"]="length"
                body["choices"][0]["message"]["content"]=resp["data"]["content"]
                path.write_text(json.dumps(body),encoding="utf-8")
            else:
                complete.append(f"--- Candidate (temp={req['data']['params']['temperature']}) ---\n{text}")
        syn=request(turn,"ensemble_synthesis",[{"role":"system","content":"Synthesize candidate solutions into one answer."},
            {"role":"user","content":[{"type":"text","text":"Synthesize the best solution.\n<original_task_description>Lift the red cube.</original_task_description>\n<candidate_solutions>\n"+"\n\n".join(complete)+"\n</candidate_solutions>"}]}])
        result=ep.model_response(syn,answer,latency_s=1.5,usage=None)
        ids[f"synthesis_{turn}"]=syn["event_id"]
        ids[f"candidate_{turn}"]=reqs[0]["event_id"]
        return result

    def robot_code(target):
        return f'rgb = get_observation()["rgb"]\nmasks = segment_sam3_text_prompt(rgb, "red cube")\ngoto_pose({target.tolist()!r})\nprint("Success!")'

    def execute(turn, response, target):
        code=robot_code(target)
        ep.parsed(response,parser="_extract_code",code_blocks=[code],decision=None,model_said_finish=None)
        block=ep.code_block_start(block_index=turn,turn_index=turn,code=code,source=response,scene=scene)
        ids[f"block_{turn}"]=block["event_id"]
        rgb=d.render(scene,"robot0_robotview",128)
        observation=ep.api_start("get_observation",{},block=block,scene=scene,line=1,source_line=code.splitlines()[0])
        ep.api_end(observation,scene=scene,result={"rgb":rgb},duration_s=.01)
        api=ep.api_start("segment_sam3_text_prompt",{"text_prompt":"red cube"},block=block,scene=scene,line=2,source_line=code.splitlines()[1])
        service=ep.service_call(api,service="sam3",function="sam3_seg_fn",url="http://127.0.0.1:8114/segment",
            request={"image":rgb,"text_prompt":"red cube"},result=[{"mask":d.cube_mask(scene,scene.red,128),"score":.91}],
            latency_s=.2,http_attempts=[{"status":200,"latency_s":.2,"error":None}])
        ids[f"sam_{turn}"]=service["parent_event_id"]
        ep.api_end(api,scene=scene,result={"detected":True},duration_s=.2)
        move=ep.api_start("goto_pose",{"position":target.tolist()},block=block,scene=scene,line=3,source_line=code.splitlines()[2])
        sim_start=ep.sim_step
        origin=scene.gripper.copy()
        for i in range(1,61):
            scene.gripper=origin+(target-origin)*i/60
            scene.red=scene.gripper-np.array([0,0,.03]);scene.held=True;scene.gripper_open=False
            ep.sim_step+=1;ep.buffer.append((ep.sim_step,scene.copy()))
            if i%15==0: ep.save_frame(len(ep.buffer)-1,reason="periodic")
        ep.api_end(move,scene=scene,result=None,duration_s=2.)
        ep.print_out("Success!\n")
        ep.code_block_end(block,scene=scene,sandbox_rc=0,reward=.4 if turn==0 else 1.,
            task_completed=turn==1,terminated=turn==1,sim_start=sim_start,duration_s=2.)

    def vdm(turn, old_image):
        _,new_image=ep.observation_snapshot(scene,"after_execution")
        req=request(turn,"image_diff",[{"role":"user","content":[
            {"type":"text","text":"Before execution:"},{"type":"image_url","image_url":{"url":old_image}},
            {"type":"text","text":"After execution:"},{"type":"image_url","image_url":{"url":new_image}},
            {"type":"text","text":"Describe the observed change."}]}],role="vdm")
        ep.model_response(req,"The red cube moved upward, but remains below the target height." if turn==1 else "The red cube is now raised above the target height.",latency_s=.7,usage=None)
        ids[f"vdm_{turn}"]=req["event_id"]
        return new_image

    initial=ensemble(0,before,'```python\n'+robot_code(np.array([.5,-.1,.93]))+'\n```')
    execute(0,initial,np.array([.5,-.1,.93]))
    after=vdm(1,before)
    revised=ensemble(1,after,'REGENERATE\n```python\n'+robot_code(np.array([.5,-.1,1.1]))+'\n```')
    execute(1,revised,np.array([.5,-.1,1.1]))
    after2=vdm(2,after)
    finished=ensemble(2,after2,"FINISH",count=3)
    ep.parsed(finished,parser="_parse_multi_turn_decision",code_blocks=[],decision="finish",model_said_finish=True)
    end=ep.emit("episode_end","info",{"end_reason":"completed","trace_complete":True,"gaps":[],
        "harness_summary":{"task_completed":True,"reward":1.,"success":True,"sandbox_rc":0}})
    video=d.mp4_bytes([d.render(s,"agentview",256) for _,s in ep.buffer],fps=30)
    ep.write_file("videos/video_combined.mp4",video)
    ep.emit("trial_videos","ok",{},artifacts=[{"path":"videos/video_combined.mp4","mime":"video/mp4","written":True,"turn_index":None}])
    # Write final event objects, including intentionally modified token-limit replies.
    ep.write_file("events.jsonl",b"".join(d.event_line(e) for e in ep.events))
    ep.write_episode_json(d.episode_summary(ep,start,end=end,gaps=[],late_events=0,n_warnings=0,last_event=ep.events[-1]))
    (run_dir/"run.json").write_text(json.dumps({"run_id":d.RUN_ID,"created_at":now,"synthetic":True}),encoding="utf-8")
    legacy=root/"runner"/"video_only"
    trial=legacy/"cube_lifting"/"DEMO"/"trial_307"
    trial.mkdir(parents=True)
    (legacy/"run.json").write_text('{"run_id":"video_only","synthetic":true}',encoding="utf-8")
    (trial/"video_combined.mp4").write_bytes(video)
    manifest={"run":d.RUN_ID,"episode":ep.episode_id,"events":ids,"video_frames":len(ep.buffer),
        "legacy":{"run":"video_only","task":"cube_lifting","condition":"DEMO","trial":"trial_307"}}
    (root/"manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
    return manifest


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",default="outputs/geniac_demo")
    args=parser.parse_args()
    print(json.dumps(build(Path(args.out)),indent=2))
