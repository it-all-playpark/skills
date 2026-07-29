// tools/sync-inlines.guard.test.mjs
// issue #453 AC2: verify the new `--add` marker-insertion route (F1, tools/sync-inlines.mjs)
// is not denied by dotfiles' pretool-inline-edit-guard.sh PreToolUse hook.
//
// The hook only inspects tool_name === 'Edit' | 'Write' (see hook header comment: "正規の
// 再生成経路"). The --add route is invoked as a bare-form Bash command
// (`tools/sync-inlines.mjs --add ...`), i.e. tool_name === 'Bash', so it is structurally
// outside the hook's Edit/Write detection surface. This suite spawns the real hook script
// (read-only; dotfiles repo is never modified) to prove that pass-through claim against the
// hook's actual behavior rather than just reading its source, and includes a negative control
// (case 3) so hook-absent skip can't make the suite vacuously green.
//
// Hook path resolution: INLINE_GUARD_HOOK env override, else the dotfiles repo's default
// location. If the hook file does not exist (e.g. CI on ubuntu, no dotfiles checkout), every
// case in this file is skipped so the suite stays green without asserting anything about a
// hook that isn't present.

import { test, describe } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const HOOK_PATH = process.env.INLINE_GUARD_HOOK
  ?? join(os.homedir(), 'ghq/github.com/it-all-playpark/dotfiles/claude-code/hooks/pretool-inline-edit-guard.sh');

const HOOK_AVAILABLE = existsSync(HOOK_PATH);

function runHook(inputObj) {
  const result = spawnSync('bash', [HOOK_PATH], {
    input: JSON.stringify(inputObj),
    encoding: 'utf8',
  });
  return result;
}

describe('pretool-inline-edit-guard.sh vs sync-inlines --add route (issue #453 AC2)', () => {
  test.skipIf(!HOOK_AVAILABLE)(
    'pass-through: Bash --add invocation is not denied (new marker-add route is outside Edit/Write detection surface)',
    () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: {
          command: "tools/sync-inlines.mjs --add _lib/example.mjs --into dev-flow.js --after 'const PLAN_MAX = 8;'",
        },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), '');
    },
  );

  test.skipIf(!HOOK_AVAILABLE)(
    'pass-through: Bash --write invocation is not denied (existing regeneration route, regression check)',
    () => {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: {
          command: 'tools/sync-inlines.mjs --write',
        },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), '');
    },
  );

  test.skipIf(!HOOK_AVAILABLE)(
    'negative control: Edit inserting a marker line into .claude/workflows/*.js IS denied (proves skip is not vacuous)',
    () => {
      const result = runHook({
        tool_name: 'Edit',
        tool_input: {
          file_path: '/x/.claude/workflows/dev-flow.js',
          old_string: 'a',
          new_string: '// ==== BEGIN inline: _lib/foo.mjs (x) ====',
        },
      });
      assert.equal(result.status, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
    },
  );
});
