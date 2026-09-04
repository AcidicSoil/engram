#!/usr/bin/env bash
set -euo pipefail

server="${1:-engram-local}"
marker="EngramVerify$(date +%s)$$"
source_id=""
memory_conversation_id=""

call() {
  local tool="$1"
  local args="${2-}"
  if [[ -z "$args" ]]; then
    args='{}'
  fi
  mcporter call "${server}.${tool}" --args "$args" --output json
}

cleanup() {
  local id
  for id in "$memory_conversation_id" "$source_id"; do
    if [[ -n "$id" ]]; then
      call delete_conversation "$(jq -nc --arg id "$id" '{conversation_id:$id}')" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT

status="$(mcporter list "$server" --status --json)"
jq -e '.servers[0].status == "ok"' <<<"$status" >/dev/null
baseline_total="$(call list_conversations '{"limit":1}' | jq -er '.total')"
baseline_used="$(call memory_status '{}' | jq -er '.storage.used')"

source_id="$(call create_conversation "$(jq -nc --arg title "$marker source" '{title:$title,agent_id:"local-verifier",tags:["verification"]}')" | jq -er '.conversation_id')"
call append_messages "$(jq -nc --arg id "$source_id" --arg marker "$marker" '{conversation_id:$id,messages:[{role:"user",content:($marker + " deployment requires a verified rollback plan before release.")},{role:"assistant",content:"The release remains blocked until rollback validation passes."}]}')" >/dev/null

memory_conversation_id="$(call create_conversation "$(jq -nc --arg title "$marker memory" '{title:$title,agent_id:"local-verifier",tags:["verification","memory"]}')" | jq -er '.conversation_id')"
memory_id="$(call append_messages "$(jq -nc --arg id "$memory_conversation_id" --arg source "$source_id" '{conversation_id:$id,messages:[{role:"user",content:"Never release without a verified rollback plan.",metadata:{memory_provenance:{source:{type:"local-verification",conversation_id:$source,start_sequence:1,end_sequence:2},reason:{type:"explicit_user_request",text:"Preserve the release rollback safeguard as durable memory."},actor:"verify-mcporter"}}}]}')" | jq -er '.message_ids[0]')"
exact="$(call search "$(jq -nc --arg q "$marker" --arg id "$source_id" '{query:$q,conversation_id:$id,limit:5}')")"
jq -e --arg id "$source_id" '.results | any(.conversation_id == $id)' <<<"$exact" >/dev/null
semantic="$(call search "$(jq -nc --arg id "$source_id" '{query:"emergency reversal procedure",conversation_id:$id,limit:5}')")"
jq -e --arg id "$source_id" '.results | any(.conversation_id == $id)' <<<"$semantic" >/dev/null

trace="$(call trace_memory "$(jq -nc --arg id "$memory_id" '{memory_id:$id}')")"
jq -e --arg source "$source_id" '.provenance.source.conversation_id == $source and .provenance.reason.type == "explicit_user_request" and .source_conversation.id == $source' <<<"$trace" >/dev/null
reverse="$(call trace_memory "$(jq -nc --arg id "$source_id" '{source_conversation_id:$id}')")"
jq -e --arg memory "$memory_id" '.memories | any(.id == $memory)' <<<"$reverse" >/dev/null

page1="$(call get_conversation "$(jq -nc --arg id "$source_id" '{conversation_id:$id,message_limit:1,message_offset:0}')")"
page2="$(call get_conversation "$(jq -nc --arg id "$source_id" '{conversation_id:$id,message_limit:1,message_offset:1}')")"
[[ "$(jq -er '.messages[0].sequence' <<<"$page1")" == "1" ]]
[[ "$(jq -er '.messages[0].sequence' <<<"$page2")" == "2" ]]

reindexed="$(call reindex "$(jq -nc --arg id "$source_id" '{conversation_id:$id}')")"
jq -e '.conversations_reindexed == 1 and .results[0].semantic == true' <<<"$reindexed" >/dev/null
post_reindex="$(call search "$(jq -nc --arg q "$marker" --arg id "$source_id" '{query:$q,conversation_id:$id,limit:5}')")"
jq -e --arg id "$source_id" '.results | any(.conversation_id == $id)' <<<"$post_reindex" >/dev/null

call delete_conversation "$(jq -nc --arg id "$memory_conversation_id" '{conversation_id:$id}')" >/dev/null
memory_conversation_id=""
call delete_conversation "$(jq -nc --arg id "$source_id" '{conversation_id:$id}')" >/dev/null
source_id=""

after_total="$(call list_conversations '{"limit":1}' | jq -er '.total')"
after_used="$(call memory_status '{}' | jq -er '.storage.used')"
[[ "$after_total" == "$baseline_total" ]]
[[ "$after_used" == "$baseline_used" ]]

jq -nc \
  --arg server "$server" \
  --arg marker "$marker" \
  --argjson baseline_total "$baseline_total" \
  --argjson baseline_used "$baseline_used" \
  '{server:$server,marker:$marker,status:"ok",keyword_search:true,semantic_search:true,provenance_forward:true,provenance_reverse:true,pagination:true,reindex:true,cleanup_restored_baseline:true,baseline:{conversations:$baseline_total,messages:$baseline_used}}'
