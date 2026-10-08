#!/usr/bin/env bash
# Drives the REAL promotion merge against synthetic repos (no network, nothing pushed anywhere).
# Usage, from the repo root:  bash tests/promotion/merge.sh .github/workflows/merge-beta-to-main.yml
# Needs git, bash and Python 3 with PyYAML. Run it after ANY change to the promotion workflow or
# .github/scripts/merge-beta-into-main.sh. Scratch repos go to a temp dir ($PROMOTION_HARNESS_WORK).
#   New layout (jobs gate/promote + .github/scripts/merge-beta-into-main.sh next to the
#   workflow): scenarios run the script itself, and an end-to-end section runs the gate's merge
#   step, then promote's rebuild and push steps, lifted from the YAML.
#   Old layout (single job merge-beta-into-main): the merge step is lifted from the YAML.
set -uo pipefail
# Inside a git hook, git exports GIT_DIR / GIT_INDEX_FILE and the like, and every git call
# below would then write into the REAL repository instead of the throwaway ones. Drop them all.
for v in $(compgen -e | grep '^GIT_' || true); do unset "$v"; done
YML="$1"
H="$(cd "$(dirname "$0")" && pwd)"
WORK="${PROMOTION_HARNESS_WORK:-$(mktemp -d)}"; mkdir -p "$WORK"
STEP="$WORK/merge-step.sh"; rm -f "$STEP" "$WORK"/yml-step-*.sh
export GH_TOKEN=dummy-token MERGE_DATE=1700000000
MODE="$("${PYTHON:-python}" -I "$H/lift.py" "$YML" "$WORK")" || { echo "harness: could not read $YML"; exit 2; }
if [ "$MODE" = new ]; then
  SCRIPT="$(dirname "$YML")/../scripts/merge-beta-into-main.sh"
  [ -s "$SCRIPT" ] || { echo "harness: $SCRIPT is missing"; exit 2; }
  cp "$SCRIPT" "$STEP"
fi
[ -s "$STEP" ] || { echo "harness: merge step is empty"; exit 2; }
echo "harness mode: $MODE"

PASS=0; FAIL=0
ok()  { echo "  PASS $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL $1"; FAIL=$((FAIL+1)); }

g() { git -c user.name=t -c user.email=t@t -c core.autocrlf=false -c init.defaultBranch=main "$@"; }

# setup <name>: makes origin.git with main = base commit, and a dev clone at $W/dev
setup() {
  W="$WORK/$1"; rm -rf "$W"; mkdir -p "$W"
  g init -q --bare "$W/origin.git"
  g clone -q "$W/origin.git" "$W/dev" 2>/dev/null
  cd "$W/dev"
  printf 'line1\nline2\nline3\n' > a.txt
  printf 'bee\n' > b.txt
  printf 'sea\n' > c.txt
  printf 'x\ny\nz\n' > x.txt
  mkdir -p "dir with space"; printf 'orig\n' > "dir with space/ü file.txt"
  printf 'Title\n=======\n\ntext\n' > README.md
  mkdir -p .github/scripts; cp "$STEP" .github/scripts/merge-beta-into-main.sh
  g add -A; g commit -qm base; g push -q origin main
  g checkout -qb beta; g push -q origin beta; g checkout -q main
}
commit_on() { cd "$W/dev"; g checkout -q "$1"; shift; eval "$@"; g add -A; g commit -qm "change on $(git rev-parse --abbrev-ref HEAD)"; g push -q origin HEAD; g checkout -q main; }

# run the step like the runner does: fresh clone of main, identity, outputs file
runstep() {
  cd "$W"; rm -rf run; g clone -q origin.git run 2>/dev/null; cd run
  git config user.name bot; git config user.email bot@x; git config core.autocrlf false
  export GITHUB_OUTPUT="$W/out.txt" RUNNER_TEMP="$W/tmp"; : > "$GITHUB_OUTPUT"; mkdir -p "$RUNNER_TEMP"
  bash "$STEP" > "$W/log.txt" 2>&1; RC=$?
  RESULT="$(sed -n 's/^result=//p' "$GITHUB_OUTPUT" | tail -1)"
  ORIGIN_MAIN_BEFORE_AFTER="$(git -C "$W/origin.git" rev-parse main)"
}
tree_eq_beta() { [ -z "$(git diff --name-only beta HEAD)" ]; }

echo "S1 clean merge"
setup s1; commit_on beta "printf 'new\n' > n.txt"; MAIN0=$(git -C "$W/origin.git" rev-parse main); runstep
[ $RC -eq 0 ] && [ "$RESULT" = clean ] && tree_eq_beta && ok "clean, tree = beta" || { bad "S1 rc=$RC result=$RESULT"; cat "$W/log.txt"; }
[ "$(git -C "$W/origin.git" rev-parse main)" = "$MAIN0" ] && ok "merge step pushed nothing" || bad "S1 origin main moved"
grep -q '^merged_sha=[0-9a-f]\{40\}$' "$W/out.txt" && ok "merged_sha output written" || bad "S1 no merged_sha"

echo "S2 content conflict -> -X theirs"
setup s2; commit_on main "printf 'line1\nMAIN\nline3\n' > a.txt"; commit_on beta "printf 'line1\nBETA\nline3\n' > a.txt"; runstep
[ $RC -eq 0 ] && [ "$RESULT" = conflicts-resolved ] && [ "$(sed -n 2p a.txt)" = BETA ] && ok "beta's hunk won" || { bad "S2 rc=$RC result=$RESULT"; cat "$W/log.txt"; }
grep -q '^a.txt$' "$W/out.txt" && ok "a.txt listed as conflicted" || bad "S2 conflicts not listed"

echo "S3 modify/delete: beta DELETED, main modified"
setup s3; commit_on main "printf 'bee-main\n' > b.txt"; commit_on beta "git rm -q b.txt"; runstep
[ $RC -eq 0 ] && [ "$RESULT" = conflicts-force-resolved ] && [ ! -e b.txt ] && ! git cat-file -e HEAD:b.txt 2>/dev/null && ok "beta's deletion honoured" || { bad "S3 rc=$RC result=$RESULT"; cat "$W/log.txt"; }
tree_eq_beta && ok "tree = beta" || bad "S3 tree differs: $(git diff --name-only beta HEAD)"

echo "S4 modify/delete: main DELETED, beta modified"
setup s4; commit_on main "git rm -q c.txt"; commit_on beta "printf 'sea-beta\n' > c.txt"; runstep
[ $RC -eq 0 ] && [ "$RESULT" = conflicts-force-resolved ] && [ "$(git show HEAD:c.txt)" = sea-beta ] && ok "beta's file restored" || { bad "S4 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S5 beta carries conflict markers -> refused"
setup s5; commit_on beta "printf 'ok\n<<<<<<< HEAD\nA\n=======\nB\n>>>>>>> beta\n' > portal.html"; MAIN0=$(git -C "$W/origin.git" rev-parse main); runstep
[ $RC -ne 0 ] && [[ "$RESULT" == refused* ]] && grep -q portal.html <<<"$RESULT" && ok "refused, names portal.html" || { bad "S5 rc=$RC result=$RESULT"; cat "$W/log.txt"; }
[ "$(git -C "$W/origin.git" rev-parse main)" = "$MAIN0" ] && ok "origin main untouched" || bad "S5 origin main moved"

echo "S6 modify/delete on a path with a space and a non-ASCII name"
setup s6; commit_on main "printf 'main\n' > 'dir with space/ü file.txt'"; commit_on beta "git rm -q 'dir with space/ü file.txt'"; runstep
[ $RC -eq 0 ] && [ "$RESULT" = conflicts-force-resolved ] && tree_eq_beta && ok "odd path resolved to beta" || { bad "S6 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S7 a Markdown ======= underline alone is not a marker"
setup s7; commit_on beta "printf 'More\n=======\n' >> README.md"; runstep
[ $RC -eq 0 ] && [ "$RESULT" = clean ] && ok "not refused" || { bad "S7 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S8 rename/rename (main x->y, beta x->z)"
setup s8; commit_on main "git mv x.txt y.txt"; commit_on beta "git mv x.txt z.txt"; runstep
[ $RC -eq 0 ] && tree_eq_beta && git cat-file -e HEAD:z.txt && ! git cat-file -e HEAD:y.txt 2>/dev/null && ok "beta's rename kept, main's dropped ($RESULT)" || { bad "S8 rc=$RC result=$RESULT tree-diff: $(git diff --name-only beta HEAD 2>/dev/null)"; cat "$W/log.txt"; }

echo "S9 add/add with different content"
setup s9; commit_on main "printf 'main\n' > d.txt"; commit_on beta "printf 'beta\n' > d.txt"; runstep
[ $RC -eq 0 ] && [ "$(git show HEAD:d.txt)" = beta ] && ok "beta's add won ($RESULT)" || { bad "S9 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S10 main-only hotfix file is kept and reported"
setup s10; commit_on main "printf 'hotfix\n' > e.txt"; commit_on beta "printf 'new\n' > n.txt"; runstep
[ $RC -eq 0 ] && git cat-file -e HEAD:e.txt && grep -q 'e.txt' "$W/out.txt" && ok "kept and named in beta_diff" || { bad "S10 rc=$RC result=$RESULT"; cat "$W/log.txt"; cat "$W/out.txt"; }

echo "S11 nothing new on beta"
setup s11; runstep
[ $RC -eq 0 ] && grep -q 'nothing new on beta' "$W/out.txt" && ok "no-op week ($RESULT)" || { bad "S11 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S12 modify/delete AND a marker-carrying content conflict in the same week"
setup s12; commit_on main "printf 'bee-main\n' > b.txt; printf 'line1\nMAIN\nline3\n' > a.txt"; commit_on beta "git rm -q b.txt; printf 'line1\nBETA\nline3\n' > a.txt"; runstep
[ $RC -eq 0 ] && [ "$RESULT" = conflicts-force-resolved ] && tree_eq_beta && ! git grep -q '^<<<<<<< ' HEAD -- . && ok "both resolved to beta, no markers" || { bad "S12 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S13 dir/file: beta replaced directory lib/ with a FILE, main edited lib/x.js -> refused"
setup s13; commit_on main "mkdir -p lib; printf 'x\n' > lib/x.js; git add -A; git commit -qm addlib; git push -q origin main"; cd "$W/dev"; g checkout -q beta; g merge -q main; g push -q origin beta; g checkout -q main
commit_on main "printf 'x-main\n' > lib/x.js"; commit_on beta "git rm -rq lib; printf 'libfile\n' > lib"; MAIN0=$(git -C "$W/origin.git" rev-parse main); runstep
[ $RC -ne 0 ] && [[ "$RESULT" == refused* ]] && [ "$(git -C "$W/origin.git" rev-parse main)" = "$MAIN0" ] && ok "refused, production untouched ($RESULT)" || { bad "S13 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S14 directory rename on main + new file in the old directory on beta -> refused"
setup s14; commit_on main "mkdir -p d; printf '1\n' > d/a.txt; printf '2\n' > d/b.txt; git add -A; git commit -qm d; git push -q origin main"; cd "$W/dev"; g checkout -q beta; g merge -q main; g push -q origin beta; g checkout -q main
commit_on main "git mv d e"; commit_on beta "printf 'new\n' > d/new.txt"; runstep
[ $RC -ne 0 ] && [[ "$RESULT" == refused* ]] && ok "refused ($RESULT)" || { bad "S14 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S15 glob characters in a conflicted path do not touch other files"
setup s15; commit_on main "printf 'g\n' > 'x[ab].txt'; printf 'keep-a\n' > xa.txt; git add -A; git commit -qm glob; git push -q origin main"; cd "$W/dev"; g checkout -q beta; g merge -q main; g push -q origin beta; g checkout -q main
commit_on main "printf 'g-main\n' > 'x[ab].txt'"; commit_on beta "git --literal-pathspecs rm -q 'x[ab].txt'"; runstep
[ $RC -eq 0 ] && git cat-file -e HEAD:xa.txt && ! git cat-file -e 'HEAD:x[ab].txt' 2>/dev/null && tree_eq_beta && ok "only x[ab].txt removed, xa.txt kept ($RESULT)" || { bad "S15 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S16 beta changes a workflow file -> refused with the twin-commit reason; with the twin on main -> passes"
setup s16; commit_on beta "mkdir -p .github/workflows; printf 'name: x\n' > .github/workflows/x.yml"; runstep
[ $RC -ne 0 ] && grep -q 'twin commit' <<<"$RESULT" && ok "refused, says twin commit" || { bad "S16a rc=$RC result=$RESULT"; cat "$W/log.txt"; }
commit_on main "mkdir -p .github/workflows; printf 'name: x\n' > .github/workflows/x.yml"; runstep
[ $RC -eq 0 ] && tree_eq_beta && ok "twin on main -> promotes ($RESULT)" || { bad "S16b rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S17 unexpected failure before the merge still writes the outputs"
setup s17; git -C "$W/origin.git" branch -D beta >/dev/null; runstep
[ $RC -ne 0 ] && [[ "$RESULT" == failed* ]] && grep -q '^main_before=[0-9a-f]\{40\}$' "$W/out.txt" && grep -q '^merge_date=1700000000$' "$W/out.txt" && ok "result=$RESULT, outputs written" || { bad "S17 rc=$RC result=$RESULT"; cat "$W/log.txt"; cat "$W/out.txt"; }

echo "S18 a main-only deletion of a file beta still has -> refused (fail closed)"
setup s18; commit_on main "git rm -q b.txt"; commit_on beta "printf 'new\n' > n.txt"; runstep
[ $RC -ne 0 ] && grep -q 'missing from the merge' <<<"$RESULT" && ok "refused ($RESULT)" || { bad "S18 rc=$RC result=$RESULT"; cat "$W/log.txt"; }

echo "S19 a bad MERGE_DATE is refused, and beta_sha + merge_date are written on success"
setup s19; commit_on beta "printf 'new\n' > n.txt"; T0=$(date -u +%Y-%m-%dT%H:%M:%SZ); runstep
BS=$(sed -n 's/^beta_sha=//p' "$W/out.txt"); [ $RC -eq 0 ] && [ "$BS" = "$(git -C "$W/origin.git" rev-parse beta)" ] && grep -q '^merge_date=1700000000$' "$W/out.txt" && ok "beta_sha=$BS" || bad "S19 rc=$RC beta_sha=$BS"; MERGE_DATE=soon runstep; [ $RC -ne 0 ] && grep -q 'MERGE_DATE' <<<"$RESULT" && ok "bad MERGE_DATE refused" || bad "S19b rc=$RC $RESULT"

echo "S21 a busy week: 50 commits with long subjects (~4600 chars) are all listed, uncut"
setup s21; cd "$W/dev"; g checkout -q beta
for i in $(seq 1 55); do printf '%s\n' "$i" > "busy$i.txt"; g add -A; g commit -qm "Busy week commit $i: a long realistic subject line about the designer, the portal and pricing"; done
g push -q origin beta; g checkout -q main
runstep; NC=$(awk '/^commits<<__EOF__$/{f=1;next} /^__EOF__$/{f=0} f' "$W/out.txt" | grep -c 'Busy week commit')
[ $RC -eq 0 ] && [ "$NC" = 50 ] && ! grep -q 'more characters' "$W/out.txt" && ok "50 of 50 listed, no cut" || bad "S21 rc=$RC listed=$NC"

echo "S20 the script is deterministic: two fresh runs with the same inputs give the same SHA (tier 3)"
setup s20; commit_on main "printf 'bee-main\n' > b.txt; printf 'line1\nMAIN\nline3\n' > a.txt"; commit_on beta "git rm -q b.txt; printf 'line1\nBETA\nline3\n' > a.txt"
runstep; S1=$(sed -n 's/^merged_sha=//p' "$W/out.txt"); runstep; S2=$(sed -n 's/^merged_sha=//p' "$W/out.txt")
[ -n "$S1" ] && [ "$S1" = "$S2" ] && ok "same SHA twice ($RESULT)" || bad "S20 $S1 vs $S2"

if [ "$MODE" = new ]; then
  # clone like actions/checkout, identity like the workflow, then one YAML step (env passed through)
  ystep() {
    rm -rf "$W/$1"; g clone -q "$W/origin.git" "$W/$1" 2>/dev/null; cd "$W/$1"
    git config user.name bot; git config user.email bot@x; git config core.autocrlf false
    export GITHUB_OUTPUT="$W/out-$1.txt" RUNNER_TEMP="$W/tmp-$1"; : > "$GITHUB_OUTPUT"; mkdir -p "$RUNNER_TEMP"
    bash -e "$WORK/yml-step-$2.sh" > "$W/log-$1.txt" 2>&1; echo $?
  }
  out() { sed -n "s/^$2=//p" "$W/out-$1.txt" | tail -1; }
  # snapshot pins main, beta and the date (what the snapshot job does with ls-remote)
  snap() { MB=$(git -C "$W/origin.git" rev-parse main); BS=$(git -C "$W/origin.git" rev-parse beta); MD=1700000555; }
  gate() { snap; RCG=$(EXPECT_MAIN=$MB BETA_SHA=$BS MERGE_DATE=$MD ystep gate gate-merge); MS=$(out gate merged_sha); }

  echo "E1 gate -> promote handoff on a tier-3 week: rebuilt SHA matches, push lands it"
  setup e1; commit_on main "printf 'bee-main\n' > b.txt"; commit_on beta "git rm -q b.txt; printf 'n\n' > n.txt"
  gate
  [ "$RCG" = 0 ] && [ -n "$MS" ] && [ "$(out gate merge_date)" = "$MD" ] && [ "$(out gate beta_sha)" = "$BS" ] && ok "gate merged the pinned commits ($(out gate result))" || { bad "E1 gate rc=$RCG"; cat "$W/log-gate.txt"; }
  commit_on beta "printf 'later\n' > later.txt"
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" = 0 ] && [ "$(git -C "$W/promote" rev-parse HEAD)" = "$MS" ] && ok "promote rebuilt the same commit although beta moved on" || { bad "E1 remerge rc=$RCP"; cat "$W/log-promote.txt"; }
  cd "$W/promote"; export GITHUB_OUTPUT="$W/out-push.txt"; : > "$GITHUB_OUTPUT"
  MERGED_SHA=$MS bash -e "$WORK/yml-step-promote-push.sh" > "$W/log-push.txt" 2>&1; RCU=$?
  [ $RCU -eq 0 ] && [ "$(git -C "$W/origin.git" rev-parse main)" = "$MS" ] && grep -q '^pushed=yes$' "$W/out-push.txt" && ok "pushed exactly the gated SHA" || { bad "E1 push rc=$RCU"; cat "$W/log-push.txt"; }
  ! git -C "$W/origin.git" cat-file -e main:later.txt 2>/dev/null && ok "beta's later commit did not ride along" || bad "E1 later.txt reached main"

  echo "E2 a different MERGE_DATE cannot be pushed"
  setup e2; commit_on beta "printf 'n\n' > n.txt"; gate
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$((MD+1)) ystep promote promote-remerge)
  [ "$RCP" != 0 ] && grep -q '^refusal=rebuilt [0-9a-f]\{40\}, which is not the commit the gate checked$' "$W/out-promote.txt" && ok "refused: rebuilt SHA differs" || { bad "E2 rc=$RCP"; cat "$W/log-promote.txt"; }

  echo "E3 main moved between gate and promote -> refused before the script runs"
  setup e3; commit_on beta "printf 'n\n' > n.txt"; gate
  commit_on main "printf 'hot\n' > hot.txt"
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" != 0 ] && grep -q '^refusal=main moved after the snapshot' "$W/out-promote.txt" && ok "refused: main moved" || { bad "E3 rc=$RCP"; cat "$W/log-promote.txt"; }

  echo "E4 beta force-pushed so it no longer contains the gated commit -> refused"
  setup e4; commit_on beta "printf 'n\n' > n.txt"; gate
  cd "$W/dev"; g checkout -q beta; g reset -q --hard HEAD~1; printf 'other\n' > o.txt; g add -A; g commit -qm rewrite; g push -q -f origin beta; g checkout -q main
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" != 0 ] && grep -qE '^result=refused' "$W/out-promote.txt" && ok "refused: $(out promote result)" || { bad "E4 rc=$RCP"; cat "$W/log-promote.txt"; cat "$W/out-promote.txt"; }

  echo "E5 the gate passed nothing (refused merge) -> promote refuses"
  setup e5; RCP=$(EXPECT_MAIN= EXPECT_SHA= BETA_SHA= MERGE_DATE= ystep promote promote-remerge)
  [ "$RCP" != 0 ] && grep -q '^refusal=the gate passed no merge' "$W/out-promote.txt" && ok "refused" || { bad "E5 rc=$RCP"; cat "$W/log-promote.txt"; }

  echo "E6 re-running promote after its push landed: main contains the gated merge -> no push, notes can run"
  setup e6; commit_on beta "printf 'n\n' > n.txt"; gate
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" = 0 ] && [ "$(out promote push)" = yes ] && ok "first run: rebuilt, push=yes" || { bad "E6a rc=$RCP"; cat "$W/log-promote.txt"; }
  cd "$W/promote"; export GITHUB_OUTPUT="$W/out-push.txt"; : > "$GITHUB_OUTPUT"; MERGED_SHA=$MS bash -e "$WORK/yml-step-promote-push.sh" > "$W/log-push.txt" 2>&1
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" = 0 ] && [ "$(out promote result)" = "already on main" ] && [ "$(out promote push)" = no ] && [ "$(out promote merged_sha)" = "$MS" ] && ok "re-run: already on main, push=no (push step skipped)" || { bad "E6 rc=$RCP $(out promote result)"; cat "$W/log-promote.txt"; }

  echo "E10 re-run after the push landed AND a hotfix went on top -> still 'already on main'"
  cd "$W/dev"; g fetch -q origin; g checkout -q main; g reset -q --hard origin/main
  commit_on main "printf 'hot\n' > hot.txt"
  git -C "$W/origin.git" cat-file -e main:hot.txt && [ "$(git -C "$W/origin.git" rev-parse main^1)" = "$MS" ] && ok "the hotfix really landed on top of the promoted merge" || bad "E10 hotfix did not land"
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" = 0 ] && [ "$(out promote result)" = "already on main" ] && [ "$(out promote push)" = no ] && ok "contained -> already on main" || { bad "E10 rc=$RCP $(out promote result)"; cat "$W/log-promote.txt"; }

  echo "E9 a gate that reports main's OWN tip on a week with new work is refused (no shortcut, no notes)"
  setup e9; commit_on beta "printf 'feature\n' > feature.txt"; gate
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MB BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" != 0 ] && grep -q '^refusal=rebuilt' "$W/out-promote.txt" && ! grep -q '^push=' "$W/out-promote.txt" && ok "refused; no push decision" || { bad "E9 rc=$RCP"; cat "$W/log-promote.txt"; cat "$W/out-promote.txt"; }
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" = 0 ] && [ "$(out promote push)" = yes ] && ok "the honest SHA still promotes" || bad "E9b rc=$RCP"

  echo "E11 an honest nothing-new week: rebuild to main itself, push=yes (a no-op), not the shortcut"
  setup e11; gate
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$MS BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$MS" = "$MB" ] && [ "$RCP" = 0 ] && [ "$(out promote push)" = yes ] && [ "$(out promote result)" = clean ] && ok "rebuilt to main's own SHA" || { bad "E11 rc=$RCP ms=$MS mb=$MB $(out promote result)"; cat "$W/log-promote.txt"; }

  echo "E7 a gate that reports the SHA of a DIFFERENT beta commit cannot get it shipped"
  setup e7; commit_on beta "printf 'A\n' > bypass.txt"; OLDBETA=$(git -C "$W/origin.git" rev-parse beta); commit_on beta "git rm -q bypass.txt; printf 'n\n' > n.txt"
  snap
  # what a lying gate would compute: main + the OLD beta commit, same date
  RCF=$(EXPECT_MAIN=$MB BETA_SHA=$OLDBETA MERGE_DATE=$MD ystep forged gate-merge); FORGED=$(out forged merged_sha)
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA=$FORGED BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ -n "$FORGED" ] && [ "$RCP" != 0 ] && grep -q '^refusal=rebuilt' "$W/out-promote.txt" && [ "$(git -C "$W/origin.git" rev-parse main)" = "$MB" ] && ok "refused; main untouched" || { bad "E7 rc=$RCP forged=$FORGED"; cat "$W/log-promote.txt"; }

  echo "E8 the gate refuses when main moved after the snapshot"
  setup e8; commit_on beta "printf 'n\n' > n.txt"; snap; commit_on main "printf 'hot\n' > hot.txt"
  RCG=$(EXPECT_MAIN=$MB BETA_SHA=$BS MERGE_DATE=$MD ystep gate gate-merge)
  [ "$RCG" != 0 ] && grep -q '^refusal=main moved after the snapshot' "$W/out-gate.txt" && ok "gate refused" || { bad "E8 rc=$RCG"; cat "$W/log-gate.txt"; }

  echo "E12 a gate SHA carrying a newline cannot write promote's outputs"
  setup e12; commit_on beta "printf 'n\n' > n.txt"; gate
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA="$MS"$'\n'"refusal=already on main" BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" != 0 ] && [ "$(out promote refusal)" = "the gate reported a merge SHA that is not a commit id" ] && ! grep -q 'already on main' "$W/out-promote.txt" && ok "refused; nothing injected" || { bad "E12 rc=$RCP"; cat "$W/out-promote.txt"; }

  echo "E13 a revision expression instead of a SHA is refused"
  RCP=$(EXPECT_MAIN=$MB EXPECT_SHA='main@{now}' BETA_SHA=$BS MERGE_DATE=$MD ystep promote promote-remerge)
  [ "$RCP" != 0 ] && grep -q '^refusal=the gate reported a merge SHA that is not a commit id$' "$W/out-promote.txt" && ok "refused" || { bad "E13 rc=$RCP"; cat "$W/out-promote.txt"; }
  export MERGE_DATE=1700000000
fi

echo
echo "harness: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
