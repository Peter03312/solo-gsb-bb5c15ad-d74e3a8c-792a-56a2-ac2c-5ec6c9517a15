#!/usr/bin/env bash
# 逐词校时（词时间修正：预览 → 确认）完整调用示例。
# 依赖：bash + curl + python3（仅用于解析 JSON）。
#
# 用法：
#   bash examples/word-corrections-api.sh [BASE_URL]
# 例如：bash examples/word-corrections-api.sh http://localhost:3000
set -euo pipefail

BASE="${1:-http://localhost:3000}"

# ---- 小工具：POST JSON，输出响应体 + 末尾 HTTP 状态码 ----
req() {
  local method="$1"; local path="$2"; local body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -d "$body"
  else
    curl -s -w '\n%{http_code}' -X "$method" "$BASE$path"
  fi
}
body_of() { sed '$d'; }
code_of() { tail -1; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin);
ks=sys.argv[1].split("."); v=d
for k in ks: v=v[int(k)] if k.isdigit() else v[k]
print(v)' "$1"; }

echo "=== 0. 新建项目并排版（4 词，切点 1200ms → 两条字幕） ==="
WORDS='{"words":[
  {"text":"你好","start_ms":0,"end_ms":500},
  {"text":"世界","start_ms":550,"end_ms":1000},
  {"text":"欢迎","start_ms":1500,"end_ms":2000},
  {"text":"光临","start_ms":2050,"end_ms":2500}
],"cuts":[1200]}'

out="$(req POST /api/projects "$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); d['name']='逐词校时 API 示例'; print(json.dumps(d,ensure_ascii=False))" "$WORDS")")"
PID="$(echo "$out" | body_of | jget id)"
echo "项目 id=$PID"

out="$(req POST "/api/projects/$PID/layout" '{"sub_version":0}')"
SID1="$(echo "$out" | body_of | jget subtitles.0.id)"
SID2="$(echo "$out" | body_of | jget subtitles.1.id)"
SV="$(echo "$out" | body_of | jget sub_version)"
echo "排版完成：字幕 id=$SID1（词0-1）/ id=$SID2（词2-3），字幕集版本 sub_version=$SV"

echo
echo "=== 1. 非法请求：缺 sub_version / 空组 / 重复词序号 / 开始≥结束 → 400 ==="
req POST "/api/projects/$PID/word-corrections/preview" \
  '{"corrections":[{"idx":0,"start_ms":0,"end_ms":450}]}' | body_of
req POST "/api/projects/$PID/word-corrections/preview" \
  "{\"sub_version\":$SV,\"corrections\":[]}" | body_of
req POST "/api/projects/$PID/word-corrections/preview" \
  "{\"sub_version\":$SV,\"corrections\":[
     {\"idx\":0,\"start_ms\":0,\"end_ms\":450},
     {\"idx\":0,\"start_ms\":0,\"end_ms\":400}]}" | body_of
req POST "/api/projects/$PID/word-corrections/preview" \
  "{\"sub_version\":$SV,\"corrections\":[{\"idx\":0,\"start_ms\":500,\"end_ms\":400}]}" | body_of
req POST "/api/projects/$PID/word-corrections/preview" \
  "{\"sub_version\":$SV,\"corrections\":[{\"idx\":99,\"start_ms\":0,\"end_ms\":400}]}" | body_of

echo
echo "=== 2. 版本过期预览 → 409，返回当前 sub_version / 词 / 字幕 ==="
req POST "/api/projects/$PID/word-corrections/preview" \
  '{"sub_version":999,"corrections":[{"idx":0,"start_ms":0,"end_ms":450}]}' | body_of

echo
echo "=== 3. 修正后词序重叠 → 200 预览但 evaluation.ok=false（word_order，定位到词/字幕） ==="
req POST "/api/projects/$PID/word-corrections/preview" \
  "{\"sub_version\":$SV,\"corrections\":[
     {\"idx\":1,\"start_ms\":550,\"end_ms\":900},
     {\"idx\":2,\"start_ms\":800,\"end_ms\":2000}]}" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); e=d["evaluation"]
print("ok =", e["ok"])
for c in e["conflicts"]: print("冲突:", c["type"], "词", c["word_start"], c["word_end"], "涉及修正词", c["corrected_indices"], "涉及字幕", c["cue_ids"])'

echo
echo "=== 4. 正常预览：并列修正词、受影响字幕（relayout）与候选整版 ==="
PREVIEW_BODY='{"sub_version":'$SV',"corrections":[
  {"idx":2,"start_ms":1550,"end_ms":2000},
  {"idx":3,"start_ms":2050,"end_ms":2450}]}'
req POST "/api/projects/$PID/word-corrections/preview" "$PREVIEW_BODY" | body_of \
  | python3 -c 'import json,sys; e=json.load(sys.stdin)["evaluation"]
print("ok =", e["ok"])
print("受影响字幕:", [(c["id"], c["action"]) for c in e["affected_cues"]])
print("候选整版:", [(c["id"], c["action"], c["word_start"], c["word_end"], c["start_ms"], c["end_ms"], c["text"]) for c in e["candidate_cues"]])'
echo "（预览只读：此时词与字幕均未改变）"

echo
echo "=== 5. 确认冲突修正 → 422，整组不生效，词与字幕均不变 ==="
echo "尝试确认第 3 步的重叠修正：HTTP $(req POST "/api/projects/$PID/word-corrections/confirm" \
  "{\"sub_version\":$SV,\"corrections\":[
     {\"idx\":1,\"start_ms\":550,\"end_ms\":900},
     {\"idx\":2,\"start_ms\":800,\"end_ms\":2000}]}" | code_of)"

echo
echo "=== 6. 确认合法修正 → 原子更新词时间；受影响行换新 ID，未受影响行保留 ID/版本/人工文本 ==="
out="$(req POST "/api/projects/$PID/word-corrections/confirm" "$PREVIEW_BODY")"
echo "HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("ok =", d["ok"], "新字幕集版本 sub_version =", d["sub_version"])
print("删除的旧字幕行 ID:", d["deleted_cue_ids"])
for c in d["subtitles"]:
    print("  字幕 id=%s v%s 词%s-%s [%s,%s] %s" % (c["id"], c["version"], c["word_start"], c["word_end"], c["start_ms"], c["end_ms"], c["text"]))
print("词时间:", [(w["start_ms"], w["end_ms"]) for w in d["words"]])'

echo
echo "=== 7. 用旧 sub_version 再次确认 → 409（当前值随响应返回） ==="
req POST "/api/projects/$PID/word-corrections/confirm" \
  "{\"sub_version\":$SV,\"corrections\":[{\"idx\":0,\"start_ms\":0,\"end_ms\":450}]}" | body_of

echo
echo "=== 8. 锁定字幕：修正词仍在锁定区间内 → 锁定行原样；溢出 → 422 locked_word_span ==="
# 锁定第一条（id=$SID1，词0-1，时段 [0,1000]）
LOCK_SV="$(req PATCH "/api/projects/$PID/subtitles/$SID1" \
  '{"version":1,"locked":true}' | body_of | jget sub_version)"
echo "已锁定字幕 $SID1，当前 sub_version=$LOCK_SV"
# 词0 改到 [10,500]：仍被锁定区间 [0,1000] 容纳 → 成功，锁定行文本/时间/版本不动
out="$(req POST "/api/projects/$PID/word-corrections/confirm" \
  "{\"sub_version\":$LOCK_SV,\"corrections\":[{\"idx\":0,\"start_ms\":10,\"end_ms\":500}]}")"
echo "区间内容纳修正：HTTP $(echo "$out" | code_of)，删除行数：$(echo "$out" | body_of | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["deleted_cue_ids"]))')（锁定行不重排，应为 0）"
NEXT_SV="$(echo "$out" | body_of | jget sub_version)"
# 词1 结束改到 1300，超出锁定结束 1000 → 422
out="$(req POST "/api/projects/$PID/word-corrections/confirm" \
  "{\"sub_version\":$NEXT_SV,\"corrections\":[{\"idx\":1,\"start_ms\":550,\"end_ms\":1300}]}")"
echo "溢出锁定区间：HTTP $(echo "$out" | code_of)"
echo "$out" | body_of | python3 -c 'import json,sys
for c in json.load(sys.stdin)["conflicts"]:
    print("冲突:", c["type"], "字幕", c["cue_ids"], "修正词", c["corrected_indices"], "|", c["message"])'

echo
echo "=== 9. 查看最终项目状态 ==="
req GET "/api/projects/$PID" | body_of \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)
print("sub_version =", d["sub_version"])
print("词:", [(w["idx"], w["start_ms"], w["end_ms"], w["text"]) for w in d["words"]])
print("字幕:", [(c["id"], "锁" if c["locked"] else "  ", "v%s" % c["version"], c["start_ms"], c["end_ms"], c["text"]) for c in d["subtitles"]])'

echo
echo "完成。既有导出快照不受影响：可先 POST /api/projects/$PID/exports 导出再校词，随后 GET 旧版本内容不变。"
