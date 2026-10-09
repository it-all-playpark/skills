# transcript (*.jsonl) を 1 行ずつ読み、集計前の事象を 1 件 1 行の JSON で出す。
# jq -R -n -c -L <scripts> --arg home --argjson since --argjson until -f extract.jq <files...>
#
# 事象の種類 (cat):
#   sandbox    Bash の tool_result に出た sandbox 由来の拒否
#   request    assistant が人間にコマンドの実行を頼んだ発言
#   permission permission の拒否（permission rule / hook / auto mode classifier / 人間の reject）
#
# 誤検出を避けるための不変条件:
#   - sandbox は Bash の tool_result だけを見る。assistant の文・人間の `!` 実行の出力（user の文字列 content）は見ない
#     ので、依頼の文に含まれたコマンドやエラー文を拒否として二重に数えない
#   - 出力を表示するだけのコマンド（grep / cat 等）の結果は、そのコマンド自身の診断行（`grep: ...`）だけを数える。
#     それ以外のコマンドも診断行の形をした行（diagnostic_line）だけを数える。
#     ファイル本文・issue 本文・JSON に拒否の文言が含まれていただけのものを拒否にしない
#   - <sandbox_violations> は出力末尾に付いたブロックだけを読む（harness が末尾に付ける。本文中の言及は数えない）
#   - subagent の transcript と isSidechain の行は数えない
include "redact";

def epoch_of: (sub("\\.[0-9]+"; "") | fromdateiso8601?) // null;

def text_of:
  if type == "string" then .
  elif type == "array" then [ .[]? | select(type == "object" and .type == "text") | .text // "" ] | join("\n")
  else "" end;

def home_rel: if startswith($home + "/") then "~" + .[($home | length):] else . end;

# 同じ対象を 1 つの型にまとめるため、worktree 名・一時ディレクトリ・UUID を潰す
def norm_path:
  home_rel
  | gsub("/\\.claude/worktrees/[^/]+"; "/.claude/worktrees/*")
  | gsub("/\\.git/worktrees/[^/]+"; "/.git/worktrees/*")
  | gsub("^/(?:private/)?var/folders/[^/]+/[^/]+/T(?=/|$)"; "$TMPDIR")
  | gsub("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"; "*")
  | if . == "/" then . else sub("/+$"; "") end;

def abs_path($cwd):
  if startswith("/") or startswith("~") or $cwd == "" or test("\\A[A-Za-z][A-Za-z0-9+.-]*://") then . else $cwd + "/" + sub("^\\./"; "") end
  | norm_path;

def project_of($l): ($l.cwd // "") | home_rel | sub("/\\.claude/worktrees/.*$"; "");

# 先頭の単純コマンドのトークン列（cd / 環境変数代入 / sudo などの前置は除く）
def cmd_tokens:
  [ (. // "") | splits("\\s*(?:&&|\\|\\||;|\\||\\n)\\s*")
    | select(test("\\S") and (test("\\A\\s*(?:cd|pushd)(?:\\s|\\z)") | not))
    | [ splits("\\s+") | select(. != "") | gsub("\\A[\"'(]+|[\"')]+\\z"; "") ]
    | until(
        (length == 0)
        or (((.[0] | test("\\A[A-Za-z_][A-Za-z0-9_]*=")) or (.[0] | IN("", "sudo", "env", "exec", "command", "time", "nohup", "!", "$"))) | not);
        .[1:])
    | select(length > 0) ]
  | .[0] // [];

# 型のキーに使うコマンド名（サブコマンドがあれば 2 語まで）
def cmd_head:
  cmd_tokens as $t
  | if ($t | length) == 0 then ""
    else ($t[0] | home_rel) + (if (($t[1] // "") | test("\\A[a-z][a-z0-9:_-]*\\z")) then " " + $t[1] else "" end)
    end;

# 出力を表示するだけのコマンドなら、その名前（診断行の接頭辞として使う）
def reader_name:
  cmd_tokens
  | ((.[0] // "") | sub("\\A.*/"; "")) as $c
  | (.[1] // "") as $s
  | if ($c | IN("grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "bat", "head", "tail", "less", "more",
                "sed", "awk", "jq", "nl", "wc", "sort", "uniq", "cut")) then $c
    elif $c == "git" and ($s | IN("grep", "show", "log", "diff", "blame")) then $c
    else null end;

# EPERM は大文字・語境界で見る（大小無視だと requirePermission 等の識別子に当たる）
def ls_re: "kLSServerCommunicationErr|error -10822|\\(-10822\\)|LSOpenURLsWithRole\\(\\) failed";
def is_denial_line: test("operation not permitted"; "i") or test("\\bEPERM\\b|" + ls_re);

def strip_ansi: gsub("\u001b\\[[0-9;]*[A-Za-z]"; "");

# 出力の 1 行。JSON の行（ツールが stderr を JSON に包んで返す形）は中の文字列を行に割って見る
def candidate_lines:
  splits("\\n") | strip_ansi
  | if test("\\A\\s*\\{") then ([ fromjson? | .. | strings | splits("\\n") ] | if length > 0 then .[] else empty end) else . end;

# 拒否の診断行の形をしているか。文書・JSON・表・箇条書きの中に拒否の文言が書かれていただけの行を外すため、
# 文言が行末にある（`<path>: Operation not permitted`）か、`operation not permitted, open '<path>'` の形か、
# エラーの接頭辞で始まる行の EPERM だけを数える
def diagnostic_line:
  sub("\\A\\s+"; "") as $s
  | ($s | test("\\A(?:[{\\[\"|*#>`]|- |[0-9]+\\. )") | not)
    and ($s | test("\\A[^\\s:]+:[0-9]+[:-]") | not)
    and (($s | test("operation not permitted(?: \\(os error [0-9]+\\))?[.\\s]*\\z"; "i"))
         or ($s | test("operation not permitted[,:] [^']{0,20}'[^']+'"; "i"))
         or (($s | test("`") | not)
             and ($s | test("\\A(?:[^\\s:]+: )?(?:npm (?:error|ERR!)|error|fatal|Error)\\b.*\\bEPERM\\b|" + ls_re))));

def trailing_violations:
  [ capture("<sandbox_violations>\\n(?<b>[\\s\\S]*?)</sandbox_violations>\\s*\\z") ] | .[0];

def violation_target:
  [ capture("\\Adeny (?<op>\\S+) (?<t>\\S+)") ] | .[0]
  | if . == null then empty
    elif (.op | startswith("network")) and (.t | startswith("/")) then {kind: "unix_socket", target: (.t | norm_path)}
    elif (.op | startswith("network")) then {kind: "network", target: (.t | sub(":[0-9]+\\z"; ""))}
    else {kind: "path", target: (.t | norm_path)} end;

def line_target($cwd; $head):
  if test("kLSServerCommunicationErr|-10822|LSOpenURLsWithRole") then {kind: "launch_services", target: $head}
  else
    ([ capture("(?:socket at|dial unix|connect EPERM|connect\\(\\) to) '?(?<p>/[^'\\s:]+)") ] | .[0]) as $sock
    | ([ capture("'(?<p>[^'\\s]*/[^'\\s]*|\\.[^'\\s/]+)'") ] | .[0]) as $quoted
    | ([ capture("(?:\\A|\\s)(?<p>[^\\s:'\"]*[/.][^\\s:'\"]*): operation not permitted"; "i") ] | .[0]) as $bare
    | if $sock then {kind: "unix_socket", target: ($sock.p | abs_path($cwd))}
      elif $quoted then {kind: "path", target: ($quoted.p | abs_path($cwd))}
      elif $bare then {kind: "path", target: ($bare.p | abs_path($cwd))}
      else {kind: "command", target: $head} end
    | if .kind == "path" and (.target | test("\\.sock\\z")) then .kind = "unix_socket" else . end
  end;

def needle_of:
  if .kind == "path" or .kind == "unix_socket" then
    # 設定ファイルには ~ 形式・絶対パス形式のどちらでも書かれるので、home 以下の部分で突き合わせる。
    # home 直下のドット dir（~/.npm/... 等）と home 外は先頭 2 段、repo 内などそれ以外は末尾 2 段を使う
    .target as $p
    | ($p | sub("\\A~/"; "") | [splits("/")] | map(select(. != ""))) as $s
    | (if ($p | startswith("~/.")) or ($p | startswith("~") | not) then $s[0:2] else $s[-2:] end)
    | map(select(test("\\*") | not)) | join("/")
  else .target end;

# 対象・代表例は伏せ字を通してから切り詰める（先に切ると PEM 等の終端が落ちて伏せ字から漏れる）
def event($l; $cat; $kind; $target; $id; $example):
  ($target | redact) as $t
  | {id: $id, cat: $cat, kind: $kind, target: $t,
     key: "\($cat):\($kind):\($t)",
     epoch: ($l.timestamp | epoch_of), session: $l.sessionId, project: project_of($l),
     example: ($example | redact | .[0:300])}
  | .ts = (.epoch | todate)
  | .needle = needle_of;

def permission_events($l; $r; $tu; $txt):
  # hook の deny は permission rule と同じ kind で記録されるが、直す場所（hook）が違うので分ける
  (if ($txt | test("\\APreToolUse:\\S+ hook error")) then "hook"
   else $l.toolDenialKind end
   // (if ($txt | test("doesn't want to proceed")) then "user-rejected"
       elif ($txt | test("auto mode classifier")) then "automode-blocked"
       else "permission-rule" end)) as $kind
  | ($tu.name // ([ $txt | capture("Permission to use (?<t>\\S+)") ] | .[0].t) // "unknown") as $tool
  | ($tu.command // ([ $txt | capture("with command (?<c>[\\s\\S]*) has been denied") ] | .[0].c)) as $cmd
  | (if $tool == "Bash" and $cmd != null then ($cmd | cmd_head)
     elif $tu.file_path then ($tu.file_path | norm_path)
     else $tool end) as $target
  | event($l; "permission"; $kind; "\($tool) \($target)"; "permission:" + $r.tool_use_id; $txt)
  | .needle = ($target | redact);

def sandbox_events($l; $r; $tu; $txt):
  ($tu.command // "") as $cmd
  | ($cmd | cmd_head) as $head
  | ($cmd | reader_name) as $reader
  | ($l.cwd // "") as $cwd
  | ($txt | trailing_violations) as $viol
  | (if $viol then ($txt | sub("<sandbox_violations>[\\s\\S]*\\z"; "")) else $txt end) as $body
  | ([ ($viol.b // "") | splits("\\n") | select(startswith("deny ")) | . as $line | violation_target + {example: $line} ]
     + [ $body
         | if $reader then splits("\\n") | strip_ansi | select(startswith($reader + ": ") and is_denial_line)
           else candidate_lines | select(diagnostic_line) end
         | . as $line | line_target($cwd; $head) + {example: $line} ]) as $found
  # 対象が特定できた行があれば、同じ失敗の言い換え（`npm error code EPERM` 等）をコマンド名の型として重ねない
  | (if any($found[]; .kind != "command") then [ $found[] | select(.kind != "command") ] else $found end)
  | unique_by([.kind, .target])
  | .[]
  | event($l; "sandbox"; .kind; .target; "sandbox:\($r.tool_use_id):\(.kind):\(.target)"; .example);

def request_re:
  "通常のターミナル|ターミナルで|手元で|ご自身で|手動で(?:実行|叩)|run (?:it|this|these|that|the following)(?: commands?)? (?:yourself|manually|in your (?:own )?terminal)|in (?:a|your) (?:regular|normal|own) terminal|please run";

def request_cmds:
  . as $t
  | [ $t | scan("`!\\s*([^`\\n]+)`") | .[0] ] as $bang
  | (if ($bang | length) > 0 then $bang
     elif ($t | test(request_re; "i")) then
       # コードブロックはコメント行を飛ばした最初の行、無ければ空白を含むインラインコード
       ([ $t | scan("```[A-Za-z0-9_-]*\\n([\\s\\S]*?)```") | .[0] | [splits("\\n")] | map(select(test("\\S") and (test("\\A\\s*#") | not))) | .[0] // empty ]
        + [ $t | scan("`([^`\\n]*\\s[^`\\n]*)`") | .[0] ]) | .[0:1]
     else [] end)
  | map(sub("\\A\\s*[!$]\\s*"; ""))
  # 先頭の語がコマンドの形をしていないもの（日本語の語句など）は依頼として扱わない
  | map(select(test("\\A[A-Za-z0-9_.~/+=-]+(?:\\s|\\z)")));

def request_events($l):
  ($l.message.id // $l.uuid) as $mid
  | [ $l.message.content[]? | select(type == "object" and .type == "text") | .text // "" ] | join("\n")
  | request_cmds
  | map({cmd: ., head: cmd_head}) | map(select(.head != "")) | unique_by(.head)
  | .[]
  | event($l; "request"; "request"; .head; "request:\($mid):\(.head)"; .cmd);

def tool_entry:
  {name, command: ((.input.command // null) | if type == "string" then .[0:2000] else null end),
   file_path: (.input.file_path // .input.notebook_path // null)};

def in_window($l): ($l.timestamp | epoch_of) as $e | $e != null and $e >= $since and $e <= $until;

foreach (inputs | fromjson? | select(type == "object")) as $l (
  {file: null, tools: {}, out: []};
  (if .file != input_filename then .file = input_filename | .tools = {} else . end)
  | .out = []
  | if (input_filename | test("/subagents/")) or $l.isSidechain == true then .
    elif $l.type == "assistant" then
      .tools += ([ $l.message.content[]? | select(type == "object" and .type == "tool_use") | {key: .id, value: tool_entry} ] | from_entries)
      | if in_window($l) then .out = [ request_events($l) ] else . end
    elif $l.type == "user" and in_window($l) then
      .tools as $tools
      | .out = [
          $l.message.content[]? | select(type == "object" and .type == "tool_result") as $r
          | ($tools[$r.tool_use_id] // {}) as $tu
          | ($r.content | text_of) as $txt
          | if ($l.toolDenialKind != null and $r.is_error == true)
               or ($txt | test("\\A(?:Error: )?(?:Permission to use [\\s\\S]* has been denied|Permission for this action [\\s\\S]*denied|The user doesn't want to proceed with this tool use|PreToolUse:\\S+ hook error)"))
            then permission_events($l; $r; $tu; $txt)
            elif $tu.name == "Bash" then sandbox_events($l; $r; $tu; $txt)
            else empty end
        ]
    else . end;
  .out[]
)
