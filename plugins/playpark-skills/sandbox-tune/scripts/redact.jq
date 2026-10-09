# 秘密の形をした文字列を伏せる。レポート・issue 下書き・collect の代表例に出す文字列は必ずここを通す。
# 値だけを伏せ、前置き（スキーム・変数名・トークンの種類）は残して何が伏せられたか読めるようにする。
def redact:
  if type != "string" then .
  else
    gsub("-----BEGIN (?<l>[A-Z0-9 ]+)-----[\\s\\S]*?-----END [A-Z0-9 ]+-----"; "-----BEGIN \(.l)----- [REDACTED] -----END \(.l)-----")
    | gsub("(?<s>[A-Za-z][A-Za-z0-9+.-]*://)[^/\\s:@]+:[^/\\s@]+@"; "\(.s)***:***@")
    | gsub("(?<![A-Za-z0-9])(?<k>(?:[A-Za-z0-9_]*_)?(?:TOKEN|KEY|SECRET))=(?:\"[^\"]*\"|'[^']*'|[^\\s\"']+)"; "\(.k)=***"; "i")
    | gsub("(?<p>sk_live_|sk_test_|ghp_|gho_|xox[bp]-)[A-Za-z0-9_-]+"; "\(.p)***")
  end;

def redact_all: walk(if type == "string" then redact else . end);
