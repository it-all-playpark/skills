# Evaluate-Retry Loop

After Phase 6 (dev-evaluate) returns evaluation JSON:

## Flow

1. **Record result**: `update-phase.sh 6_evaluate done --eval-result '$JSON' --worktree $PATH`
2. **If `verdict == "pass"`**: Proceed to Phase 7 (git-commit)
3. **If `verdict == "fail"` AND iterations < max_iterations (default 5)**:
   - Read `feedback_level` from the evaluation result
   - If `"design"`: Reset to Phase 3
     ```bash
     $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done --reset-to 3_plan_impl --worktree $PATH
     ```
     Pass feedback to dev-plan-impl for plan revision
   - If `"implementation"`: Reset to Phase 4
     ```bash
     $SKILLS_DIR/dev-kickoff/scripts/update-phase.sh 6_evaluate done --reset-to 4_implement --worktree $PATH
     ```
     Pass feedback to dev-implement for code revision
4. **If max_iterations reached**: Proceed to Phase 7 with warning log
5. **If evaluate fork fails**: Retry once. If still fails, skip evaluation and proceed to Phase 7 with warning. Record error in kickoff.json.
