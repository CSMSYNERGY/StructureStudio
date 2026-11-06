#!/usr/bin/env bash
# Runs the REAL report job's two steps (lifted from the workflow) against every outcome
# combination: first the collector (gate outputs -> capped files), then the posting step, with
# git and curl replaced by stand-ins. git ls-remote answers FAKE_REMOTE (or fails for "FAIL");
# curl captures the payload instead of posting. Checks each header against the truth.
# Usage, from the repo root:  bash tests/promotion/report.sh .github/workflows/merge-beta-to-main.yml
# Needs bash and Python 3 with PyYAML; uses jq when installed, else jqshim.py.
set -uo pipefail
YML="$1"; H="$(cd "$(dirname "$0")" && pwd)"; R="${PROMOTION_HARNESS_WORK:-$(mktemp -d)}/report"; rm -rf "$R"; mkdir -p "$R/bin"
"${PYTHON:-python}" -I -c "
import yaml,sys
d=yaml.safe_load(open(sys.argv[1],encoding='utf-8'))
st=d['jobs']['report']['steps']
open(sys.argv[2]+'/collect.sh','w',newline='\n',encoding='utf-8').write([x for x in st if x['name'].startswith('Collect')][0]['run'])
open(sys.argv[2]+'/post.sh','w',newline='\n',encoding='utf-8').write([x for x in st if x['name']=='Report to Projects'][0]['run'])
" "$YML" "$R" || { echo "report harness: could not lift"; exit 2; }

cat > "$R/bin/git" <<'EOF'
#!/usr/bin/env bash
for a in "$@"; do [ "$a" = ls-remote ] && { [ "${FAKE_REMOTE:-}" = FAIL ] && exit 128; printf '%s\trefs/heads/main\n' "$FAKE_REMOTE"; exit 0; }; done
echo "unexpected git call: $*" >&2; exit 1
EOF
cat > "$R/bin/curl" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -d) printf '%s' "$2" > "$PAYLOAD_FILE"; shift ;;
    --data-binary) f="${2#@}"; cp "$f" "$PAYLOAD_FILE"; shift ;;
  esac; shift
done
echo '[{"id":"fake"}]'
EOF
chmod +x "$R/bin/git" "$R/bin/curl"
if ! command -v jq >/dev/null 2>&1; then
  printf '#!/usr/bin/env bash\nexec "${PYTHON:-python}" -I "%s" "$@"\n' "$H/jqshim.py" > "$R/bin/jq"; chmod +x "$R/bin/jq"; export PATH="$R/bin:$PATH"; echo "(jq shim in use)"
fi

PASS=0; FAIL=0
A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; C=cccccccccccccccccccccccccccccccccccccccc

# case_ <name> <expected-header-regex> KEY=VAL ...
# Test vocabulary: RESULT / MERGED_SHA (the merge facts), PROMOTE_NOTE (promote's own result if it
# differs), MERGE_OUTCOME / NODE_OUTCOME / DENO_OUTCOME / PREFLIGHT_OUTCOME (the gate's steps).
# They become the collector's G_* inputs and, when promote's remerge ran, the posting step's P_*.
# Explicit G_* / P_* arguments win. NO_COLLECT=1 skips the collector (its process could not start).
case_() {
  local name="$1" want="$2"; shift 2
  local kv k v RES= MSHA= PN= REM= NOCOL=
  for kv in "$@"; do k="${kv%%=*}"; v="${kv#*=}"; case "$k" in RESULT) RES="$v";; MERGED_SHA) MSHA="$v";; PROMOTE_NOTE) PN="$v";; REMERGE_OUTCOME) REM="$v";; NO_COLLECT) NOCOL="$v";; esac; done
  local T="$R/tmp-$name"; rm -rf "$T"; mkdir -p "$T"
  local genv=(G_RESULT="$RES" G_MERGED_SHA="$MSHA" G_COMMITS=c1 G_CONFLICTS= G_BETA_DIFF= G_MERGE_OUTCOME= G_NODE_OUTCOME= G_DENO_OUTCOME= G_PREFLIGHT_OUTCOME=)
  local penv=(SUPABASE_SERVICE_ROLE_KEY=k GH_TOKEN=t REPO=o/r RUN_URL=u PM_MERGE_ITEM_ID=i SUPABASE_URL=https://x
    GATE_RESULT= PROMOTE_RESULT= SNAPSHOT_RESULT= MAIN_BEFORE= REMERGE_OUTCOME= PUSHED= PUSH_OUTCOME= NOTES_RESULT= FAKE_REMOTE=
    P_RESULT= P_MERGED_SHA= P_COMMITS= P_CONFLICTS= P_BETA_DIFF=)
  if [ -n "$REM" ] && [ "$REM" != skipped ]; then penv+=(P_RESULT="${PN:-$RES}" P_MERGED_SHA="$MSHA" P_COMMITS=c1); fi
  for kv in "$@"; do
    k="${kv%%=*}"
    case "$k" in
      MERGE_OUTCOME|NODE_OUTCOME|DENO_OUTCOME|PREFLIGHT_OUTCOME) genv+=("G_$kv") ;;
      G_*) genv+=("$kv") ;;
      RESULT|MERGED_SHA|PROMOTE_NOTE|NO_COLLECT) ;;
      *) penv+=("$kv") ;;
    esac
  done
  if [ -z "$NOCOL" ]; then
    env -i PATH="$R/bin:/usr/bin:/bin:$PATH" RUNNER_TEMP="$T" "${genv[@]}" bash -e "$R/collect.sh" > "$R/log-$name-collect.txt" 2>&1
  fi
  export PAYLOAD_FILE="$R/payload-$name.json"; rm -f "$PAYLOAD_FILE"
  env -i PATH="$R/bin:/usr/bin:/bin:$PATH" RUNNER_TEMP="$T" "${penv[@]}" PAYLOAD_FILE="$PAYLOAD_FILE" bash -e "$R/post.sh" > "$R/log-$name.txt" 2>&1; local rc=$?
  local header=""; [ -s "$PAYLOAD_FILE" ] && header="$(jq -r .body "$PAYLOAD_FILE" | head -n1)"
  if [ $rc -eq 0 ] && [[ "$header" =~ $want ]]; then echo "  PASS $name: $header"; PASS=$((PASS+1));
  else echo "  FAIL $name (rc=$rc): got [$header], want /$want/"; tail -5 "$R/log-$name.txt"; FAIL=$((FAIL+1)); fi
}
body_has() {  # body_has <case> <grep-regex> <label>
  if jq -r .body "$R/payload-$1.json" 2>/dev/null | grep -qE "$2"; then echo "  PASS $3"; PASS=$((PASS+1)); else echo "  FAIL $3"; FAIL=$((FAIL+1)); fi
}
OKRUN=(SNAPSHOT_RESULT=success GATE_RESULT=success MERGE_OUTCOME=success NODE_OUTCOME=success DENO_OUTCOME=success PREFLIGHT_OUTCOME=success)

case_ R1-promoted-clean '^\[OK\] Beta->Main merged cleanly$' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$B
case_ R1b-promoted-conflicts '^\[CONFLICTS RESOLVED\]' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=conflicts-resolved MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$B
case_ R2-refused-at-merge '^\[NOT PROMOTED\] the merge was refused' SNAPSHOT_RESULT=success GATE_RESULT=failure MERGE_OUTCOME=failure "RESULT=refused (conflict markers in: x)" MAIN_BEFORE=$A PROMOTE_RESULT=skipped FAKE_REMOTE=$A
case_ R3-preflight-failed '^\[NOT PROMOTED\] preflight failed' SNAPSHOT_RESULT=success GATE_RESULT=failure MERGE_OUTCOME=success NODE_OUTCOME=success DENO_OUTCOME=success PREFLIGHT_OUTCOME=failure RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A PROMOTE_RESULT=skipped FAKE_REMOTE=$A
case_ R3b-preflight-failed-ls-down '^\[NOT PROMOTED\] preflight failed' SNAPSHOT_RESULT=success GATE_RESULT=failure MERGE_OUTCOME=success NODE_OUTCOME=success DENO_OUTCOME=success PREFLIGHT_OUTCOME=failure RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A PROMOTE_RESULT=skipped FAKE_REMOTE=FAIL
case_ R4-push-failed-but-landed '^\[PROMOTED, BUT THE PUSH TO MAIN FAILED\]' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=success PUSH_OUTCOME=failure RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$B
case_ R5-push-failed-ls-down '^\[CHECK MAIN\]' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=success PUSH_OUTCOME=failure RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=FAIL
case_ R6-push-failed-main-unchanged '^\[NOT PROMOTED\] the push to main failed' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=success PUSH_OUTCOME=failure RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$A
case_ R6b-push-failed-main-moved-elsewhere '^\[CHECK MAIN\]' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=success PUSH_OUTCOME=failure RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$C
case_ R7-nothing-new '^\[OK\] Nothing new on beta' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=clean MERGED_SHA=$A MAIN_BEFORE=$A FAKE_REMOTE=$A
case_ R7b-nothing-new-ls-down '^\[OK\] Nothing new on beta' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=clean MERGED_SHA=$A MAIN_BEFORE=$A FAKE_REMOTE=FAIL
case_ R8-nothing-new-notes-failed '^\[NOTHING NEW, BUT A STEP AFTER THE PUSH FAILED\]' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=clean MERGED_SHA=$A MAIN_BEFORE=$A FAKE_REMOTE=$A
case_ R9-cancelled-in-preflight '^\[NOT PROMOTED\] the run was cancelled' SNAPSHOT_RESULT=success GATE_RESULT=cancelled MERGE_OUTCOME=success PREFLIGHT_OUTCOME=cancelled RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A PROMOTE_RESULT=skipped FAKE_REMOTE=FAIL
case_ R10a-cancelled-in-push-landed '^\[PROMOTED, BUT THE RUN WAS CANCELLED\]' "${OKRUN[@]}" PROMOTE_RESULT=cancelled REMERGE_OUTCOME=success PUSH_OUTCOME=cancelled RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$B
case_ R10b-cancelled-in-push-not-landed '^\[NOT PROMOTED\] the run was cancelled' "${OKRUN[@]}" PROMOTE_RESULT=cancelled REMERGE_OUTCOME=success PUSH_OUTCOME=cancelled RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$A
case_ R10c-cancelled-in-push-ls-down '^\[CHECK MAIN\]' "${OKRUN[@]}" PROMOTE_RESULT=cancelled REMERGE_OUTCOME=success PUSH_OUTCOME=cancelled RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=FAIL
case_ R11-snapshot-failed '^\[NOT PROMOTED\] the snapshot could not pin' SNAPSHOT_RESULT=failure GATE_RESULT=skipped PROMOTE_RESULT=skipped FAKE_REMOTE=$A
case_ R12-promoted-notes-failed '^\[PROMOTED, BUT A STEP AFTER THE PUSH FAILED\]' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$B
case_ R13-promote-refused-rebuild '^\[NOT PROMOTED\] promote could not rebuild' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=failure "PROMOTE_NOTE=rebuilt x, which is not the commit the gate checked" RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$A
case_ R14-promoted-ls-down '^\[OK\] Beta->Main merged cleanly$' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=FAIL
case_ R15-rerun-already-on-main '^\[OK\] Already promoted' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success "PROMOTE_NOTE=already on main" PUSH_OUTCOME=skipped NOTES_RESULT="2 note(s) now Live" RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$C
case_ R16-forged-gate-sha-refused '^\[NOT PROMOTED\] promote could not rebuild' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=failure "P_RESULT=rebuilt $B, which is not the commit the gate checked" P_MERGED_SHA=$B G_MERGED_SHA=$A RESULT=clean MERGED_SHA=$A MAIN_BEFORE=$A FAKE_REMOTE=$A
case_ R17-promoted-result-blank '^\[PROMOTED\] Beta->Main merged \(merge result not reported' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT= MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$B
case_ R18-gate-blanked-but-promote-honest '^\[OK\] Beta->Main merged cleanly$' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=clean MERGED_SHA=$B G_RESULT= G_MERGED_SHA= MAIN_BEFORE=$A FAKE_REMOTE=$B
case_ R19-injected-already-on-main-on-failed-step '^\[NOT PROMOTED\] promote could not rebuild' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=failure "P_RESULT=already on main" RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A PUSH_OUTCOME=skipped FAKE_REMOTE=$A
case_ R20-gate-failed-with-forged-nothing-new '^\[NOT PROMOTED\] preflight failed' SNAPSHOT_RESULT=success GATE_RESULT=failure MERGE_OUTCOME=success NODE_OUTCOME=success DENO_OUTCOME=success PREFLIGHT_OUTCOME=failure RESULT=clean MERGED_SHA=$A MAIN_BEFORE=$A PROMOTE_RESULT=skipped FAKE_REMOTE=$A
case_ R21-gate-failed-with-forged-promoted-sha '^\[NOT PROMOTED\]' SNAPSHOT_RESULT=success GATE_RESULT=failure MERGE_OUTCOME=success NODE_OUTCOME=success DENO_OUTCOME=success PREFLIGHT_OUTCOME=failure RESULT=clean MERGED_SHA=$C MAIN_BEFORE=$A PROMOTE_RESULT=skipped FAKE_REMOTE=$C
BIG="$(printf '%*s' 140000 '' | tr ' ' x)"
case_ R22-oversized-gate-output-on-a-promoted-week '^\[OK\] Beta->Main merged cleanly$' "${OKRUN[@]}" PROMOTE_RESULT=success REMERGE_OUTCOME=success PUSH_OUTCOME=success PUSHED=yes RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$B "G_COMMITS=$BIG"
case_ R23-promote-cancelled-early-forged-nothing-new '^\[NOT PROMOTED\] the run was cancelled' "${OKRUN[@]}" PROMOTE_RESULT=cancelled REMERGE_OUTCOME= RESULT=clean MERGED_SHA=$A MAIN_BEFORE=$A FAKE_REMOTE=$A
case_ R23b-promote-failed-to-start-forged-nothing-new '^\[NOT PROMOTED\] promote did not report' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME= RESULT=clean MERGED_SHA=$A MAIN_BEFORE=$A FAKE_REMOTE=$A
case_ R24-promote-published-nothing-main-moved '^\[CHECK MAIN\]' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME= RESULT=clean MERGED_SHA=$C MAIN_BEFORE=$A FAKE_REMOTE=$C
case_ R25-gate-failed-outputs-unreadable '^\[NOT PROMOTED\] the gate failed \(its outputs could not be read\)' SNAPSHOT_RESULT=success GATE_RESULT=failure PROMOTE_RESULT=skipped MAIN_BEFORE=$A FAKE_REMOTE=$A NO_COLLECT=1
case_ R26-main-moved-refusal-keeps-commit-list '^\[NOT PROMOTED\] promote could not rebuild' "${OKRUN[@]}" PROMOTE_RESULT=failure REMERGE_OUTCOME=failure "P_RESULT=main moved after the snapshot" P_COMMITS= "G_COMMITS=abc1234 the waiting commit" RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A FAKE_REMOTE=$A
BUSY="$(for i in $(seq 1 50); do printf '%07d Busy week commit %d: a long realistic subject line about the designer, the portal and pricing\n' "$i" "$i"; done)"
case_ R27-busy-week-gate-list-intact '^\[NOT PROMOTED\] preflight failed' SNAPSHOT_RESULT=success GATE_RESULT=failure MERGE_OUTCOME=success NODE_OUTCOME=success DENO_OUTCOME=success PREFLIGHT_OUTCOME=failure RESULT=clean MERGED_SHA=$B MAIN_BEFORE=$A PROMOTE_RESULT=skipped FAKE_REMOTE=$A "G_COMMITS=$BUSY"
if [ "$(jq -r .body "$R/payload-R27-busy-week-gate-list-intact.json" | grep -c 'Busy week commit')" = 50 ] && ! jq -r .body "$R/payload-R27-busy-week-gate-list-intact.json" | grep -q truncated; then echo "  PASS R27 all 50 commits reach the report through the collector"; PASS=$((PASS+1)); else echo "  FAIL R27 busy list cut"; FAIL=$((FAIL+1)); fi
body_has R26-main-moved-refusal-keeps-commit-list '^abc1234 the waiting commit$' "R26 body still lists the waiting commits"
body_has R22-oversized-gate-output-on-a-promoted-week '^Pushed to main: yes$' "R22 report posted in full"
body_has R5-push-failed-ls-down '^Pushed to main: unconfirmed' "R5 body says the push is unconfirmed"
body_has R1-promoted-clean '^Pushed to main: yes$' "R1 body says pushed yes"
body_has R15-rerun-already-on-main '^Result: already on main \(merged: clean\)$' "R15 body names what the merge was"

echo "report harness: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
