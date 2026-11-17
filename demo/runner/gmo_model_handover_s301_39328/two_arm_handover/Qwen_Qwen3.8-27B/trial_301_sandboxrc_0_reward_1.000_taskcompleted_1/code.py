# Code block 0
import numpy as np

# ============================================================
# STEP 1: Locate the hammer
# ============================================================
obs = get_observation()
rgb = obs["robot0_robotview"]["images"]["rgb"]
depth = obs["robot0_robotview"]["images"]["depth"]
intrinsics = obs["robot0_robotview"]["intrinsics"]
extrinsics = obs["robot0_robotview"]["pose_mat"]

# Segment the hammer
masks = segment_sam3_text_prompt(rgb, text_prompt="hammer")
if not masks:
    masks = segment_sam3_text_prompt(rgb, text_prompt="hammer on table")
if not masks:
    masks = segment_sam3_text_prompt(rgb, text_prompt="wooden hammer")

best_mask = max(masks, key=lambda m: m['score'])
mask = best_mask['mask']
print(f"Hammer segment score: {best_mask['score']:.3f}, pixels: {mask.sum()}")

# Get 3D world points
world_points = mask_to_world_points(mask, depth, intrinsics, extrinsics)
print(f"Hammer world points: {len(world_points)}")

# Get oriented bounding box
obb = get_oriented_bounding_box_from_3d_points(world_points)
hammer_center = obb['center']
hammer_extent = obb['extent']
hammer_R = obb['R']
print(f"Hammer center: {hammer_center}")
print(f"Hammer extent: {hammer_extent}")

# The hammer is aligned along Y-axis, handle toward +Y
# Estimate table surface z (hammer lies flat, so table z ≈ center_z - half thickness)
# The thickness is the smallest extent
thickness_idx = np.argmin(hammer_extent)
table_z = hammer_center[2] - hammer_extent[thickness_idx] / 2.0
print(f"Estimated table z: {table_z:.4f}")

# Code block 1
import numpy as np

# Helper: slerp for smooth quaternion interpolation
def slerp(q1, q2, t):
    q1 = q1 / np.linalg.norm(q1)
    q2 = q2 / np.linalg.norm(q2)
    dot = np.clip(np.dot(q1, q2), -1.0, 1.0)
    if dot < 0:
        q2 = -q2
        dot = -dot
    if dot > 0.9999:
        return (q1 + t * (q2 - q1)) / np.linalg.norm(q1 + t * (q2 - q1))
    theta_0 = np.arccos(dot)
    theta = theta_0 * t
    s1 = np.cos(theta) - dot * np.sin(theta) / np.sin(theta_0)
    s2 = np.sin(theta) / np.sin(theta_0)
    return s1 * q1 + s2 * q2

# Constants from previous step
hammer_center = np.array([0.34935842, 0.04449645, -0.08605274])
hammer_extent = np.array([0.20457902, 0.07897013, 0.04390533])
table_z = -0.1080
hammer_top_z = hammer_center[2] + hammer_extent[2] / 2  # ~-0.064
hammer_half_len = hammer_extent[0] / 2.0  # ~0.102m

# Grasp point: slightly toward head end (-Y) to leave more handle for Arm 1
grasp_offset_y = -0.03
grasp_pos = np.array([hammer_center[0], hammer_center[1] + grasp_offset_y, hammer_top_z])
print(f"Grasp position: {grasp_pos}")

# Handover position: midpoint between arms, z in [0.15, 0.20]
handover_x = 0.81
handover_y = 0.0
handover_z = 0.175
handover_pos = np.array([handover_x, handover_y, handover_z])

# Quaternions (w, x, y, z)
q_arm0_open_x = np.array([0, 0.707, 0.707, 0])  # facing down, opening along X (perp to hammer along Y)
q_arm0_open_y = np.array([0, 1, 0, 0])           # facing down, opening along Y (after 90 deg Z rotation)
q_arm1_open_y = np.array([0, 0, 1, 0])           # facing down, opening along Y (perp to hammer along X)

# ============================================================
# PHASE 1: Arm 0 picks up the hammer
# ============================================================
open_gripper_arm0()
print("Phase 1: Arm 0 picking up hammer...")

# 1a: Approach from above
approach_pos = np.array([grasp_pos[0], grasp_pos[1], 0.15])
joints = solve_ik_arm0(approach_pos, q_arm0_open_x)
move_to_joints_arm0(joints)
print(f"  Above hammer at z=0.15")

# 1b: Lower to grasp height
joints = solve_ik_arm0(grasp_pos, q_arm0_open_x)
move_to_joints_arm0(joints)
print(f"  Lowered to grasp: {grasp_pos}")

# 1c: Close gripper
close_gripper_arm0()
print("  Gripper closed")

# 1d: Lift well above table (clear any table edge/gap)
lift_pos = np.array([grasp_pos[0], grasp_pos[1], 0.25])
joints = solve_ik_arm0(lift_pos, q_arm0_open_x)
move_to_joints_arm0(joints)
print(f"  Lifted to z=0.25")

# ============================================================
# PHASE 2: Rotate hammer 90 deg around Z (handle from +Y to +X)
# Using slerp for smooth, collision-free rotation
# ============================================================
print("Phase 2: Rotating hammer 90 deg around Z...")
n_rot_steps = 5
for i in range(1, n_rot_steps + 1):
    t = i / n_rot_steps
    q_rot = slerp(q_arm0_open_x, q_arm0_open_y, t)
    q_rot = q_rot / np.linalg.norm(q_rot)
    joints = solve_ik_arm0(lift_pos, q_rot)
    if not np.any(np.isnan(joints)):
        move_to_joints_arm0(joints)
print("  Rotation complete: handle now points +X (toward Arm 1)")

# ============================================================
# PHASE 3: Move to handover position (stepwise for safety)
# ============================================================
print("Phase 3: Moving to handover position...")

# Step 3a: Move in X direction at safe height
mid_x_pos = np.array([0.60, grasp_pos[1], 0.25])
joints = solve_ik_arm0(mid_x_pos, q_arm0_open_y)
move_to_joints_arm0(joints)
print(f"  Intermediate: x=0.60, z=0.25")

# Step 3b: Continue to handover x,y at safe height
step2_pos = np.array([handover_x, handover_y, 0.25])
joints = solve_ik_arm0(step2_pos, q_arm0_open_y)
move_to_joints_arm0(joints)
print(f"  At ({handover_x}, {handover_y}), z=0.25")

# Step 3c: Lower to handover z (within required range)
joints = solve_ik_arm0(handover_pos, q_arm0_open_y)
move_to_joints_arm0(joints)
print(f"  Lowered to handover z={handover_z}")

# ============================================================
# PHASE 4: Arm 1 approaches and grasps the handle
# ============================================================
print("Phase 4: Arm 1 grasping handle...")

# After rotation, handle extends toward +X from Arm 0's grip
# Distance from grip to handle end = 0.03 + 0.102 = 0.132m
# Arm 1 grasps at 0.10m from Arm 0 (on the handle, >8cm buffer)
arm1_grasp_x = handover_x + 0.10
arm1_grasp_pos = np.array([arm1_grasp_x, handover_y, handover_z])
gripper_dist = arm1_grasp_x - handover_x
print(f"  Arm 1 target: {arm1_grasp_pos}")
print(f"  Gripper separation: {gripper_dist:.3f}m (min 0.08m)")

# 4a: Arm 1 approaches from above (well clear of Arm 0)
open_gripper_arm1()
arm1_approach = np.array([arm1_grasp_x, handover_y, 0.35])
joints = solve_ik_arm1(arm1_approach, q_arm1_open_y)
move_to_joints_arm1(joints)
print(f"  Arm 1 above handle at z=0.35")

# 4b: Arm 1 lowers to grasp the handle
joints = solve_ik_arm1(arm1_grasp_pos, q_arm1_open_y)
move_to_joints_arm1(joints)
print(f"  Arm 1 at grasp position")

# 4c: Close Arm 1 gripper on the handle
close_gripper_arm1()
print("  Arm 1 gripper closed on handle")

# ============================================================
# PHASE 5: Arm 0 releases and retracts safely
# ============================================================
print("Phase 5: Arm 0 releasing and retracting...")

open_gripper_arm0()
print("  Arm 0 gripper opened (releasing)")

# Retract: move back toward Arm 0 side and up
retract_pos = np.array([handover_x - 0.25, handover_y, 0.30])
joints = solve_ik_arm0(retract_pos, q_arm0_open_y)
move_to_joints_arm0(joints)
print(f"  Arm 0 retracted to {retract_pos}")

print(f"\n=== HANDOVER COMPLETE ===")
print(f"Hammer z at handover: {handover_z} (required: 0.15-0.20)")