#!/usr/bin/env bash
# .github/scripts/merge-beta-into-main.sh
#
# The merge half of the weekly beta->main promotion (.github/workflows/merge-beta-to-main.yml).
# It merges beta into the checked-out main, beta winning every conflict, and REFUSES (exit 1)
# whenever it cannot produce a tree that is honestly "main + beta, beta won". It never pushes.
#
# It runs TWICE per promotion, in two jobs: once in `gate`, which then runs preflight (npm
# code, no secrets), and again in `promote`, which holds the write token and must push only
# what the gate checked. Both runs get the same main, the same beta commit and the same
# MERGE_DATE, so they produce the same merge commit SHA, and `promote` refuses unless they do.
# Keep it deterministic: no wall-clock time, randomness or environment-dependent content may
# reach the commit.
#
# ⚠️ Run it from a COPY (cp to $RUNNER_TEMP first). It lives in the tree it merges, and bash
# reads a script while it runs, so `git merge` rewriting this file mid-run would corrupt it.
#
# Inputs (environment):
#   MERGE_DATE      required. Unix seconds; pinned author and committer date of the merge.
#   BETA_SHA        optional. Merge exactly this beta commit (it must be on origin's beta).
#                   Unset: whatever origin's beta is now.
#   GH_TOKEN        token for the fetch (passed per command, never stored in .git/config).
#   GITHUB_OUTPUT   where the outputs go.  RUNNER_TEMP  scratch directory.
# Outputs: result, merged_sha, main_before, beta_sha, merge_date, commits, conflicts, beta_diff.
# Every exit writes them, a refusal or an unexpected failure included.
set -euo pipefail

COMMITS=""
RESULT="failed before the merge"
CONFLICTS=""
MERGED_SHA=""
BETA_DIFF=""
MAIN_BEFORE=""
BETA_AT=""
EMITTED=0

# Every value is capped (pure bash, no pipe): outputs travel through environments, where Linux
# refuses any single string over 128 KB. 16000 characters fits a busy 50-commit week (about
# 4500) with room to spare, and stays under that limit even at 4 bytes per character.
cap() {
  local s="$1" n="${2:-16000}"
  if [ "${#s}" -le "$n" ]; then printf '%s' "$s"; else printf '%s ... (%d more characters)' "${s:0:$n}" "$(( ${#s} - n ))"; fi
}
emit() {
  {
    echo "result=$(cap "$RESULT" 1000)"
    echo "merged_sha=$MERGED_SHA"
    echo "main_before=$MAIN_BEFORE"
    echo "beta_sha=$BETA_AT"
    echo "merge_date=${MERGE_DATE:-}"
    echo "commits<<__EOF__"
    cap "$COMMITS"; echo
    echo "__EOF__"
    echo "conflicts<<__EOF__"
    cap "$CONFLICTS"; echo
    echo "__EOF__"
    echo "beta_diff<<__EOF__"
    cap "$BETA_DIFF"; echo
    echo "__EOF__"
  } >> "$GITHUB_OUTPUT"
  EMITTED=1
}
refuse() {
  echo "::error::Promotion refused: $1"
  RESULT="refused ($1)"
  emit
  exit 1
}
trap 'rc=$?; if [ "$EMITTED" != 1 ]; then RESULT="failed (exit $rc, see the run log)"; emit; fi' EXIT

[[ "${MERGE_DATE:-}" =~ ^[0-9]+$ ]] || refuse "MERGE_DATE is not a unix timestamp"
# The merge commit's identity and dates are fixed, so the gate and promote runs agree.
export GIT_AUTHOR_DATE="$MERGE_DATE +0000" GIT_COMMITTER_DATE="$MERGE_DATE +0000"

AUTH="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${GH_TOKEN:-}" | base64 | tr -d '\n')"
echo "::add-mask::$AUTH"

MAIN_BEFORE="$(git rev-parse HEAD)"
git -c "http.https://github.com/.extraheader=$AUTH" fetch origin beta:beta

if [ -n "${BETA_SHA:-}" ]; then
  # The exact commit the gate merged. beta may have moved on since; anything newer waits for
  # the next promotion, and a beta that no longer CONTAINS that commit was rewritten: refuse.
  git cat-file -e "${BETA_SHA}^{commit}" 2>/dev/null || refuse "beta commit $BETA_SHA is not on origin"
  git merge-base --is-ancestor "$BETA_SHA" beta || refuse "origin's beta no longer contains $BETA_SHA (force-pushed?)"
  git branch -f beta "$BETA_SHA"
fi
BETA_AT="$(git rev-parse beta)"

# Cap with git's own -50, NEVER "| head -50". Under `set -o pipefail`, head closes the pipe as
# soon as it has its 50 lines; once beta is more than ~50 commits ahead git log is still
# writing, takes SIGPIPE, and exits 141 - aborting before the merge ever runs. That is what
# silently skipped the 2026-08-03 promotion (beta was 124 ahead). The bug is invisible on
# small weeks, so do not "simplify" this back into a pipe.
COMMITS="$(git log --oneline --no-decorate -50 main..beta)"
if [ -z "$COMMITS" ]; then
  COMMITS="(nothing new on beta this week)"
fi

if git merge --no-ff beta -m "chore: weekly auto-merge of beta into main"; then
  RESULT="clean"
else
  CONFLICTS="$(git diff --name-only --diff-filter=U | sort -u)"
  # A merge that failed without a conflicted path failed for some other reason, and nothing
  # below knows how to fix that.
  [ -n "$CONFLICTS" ] || refuse "git merge failed without reporting a conflicted path"
  git merge --abort
  if git merge --no-ff -X theirs beta -m "chore: weekly auto-merge of beta into main (conflicts auto-resolved, beta won)"; then
    RESULT="conflicts-resolved"
  else
    # -X theirs only resolves CONTENT hunks. What is left here is modify/delete, rename/rename,
    # add/add of different kinds and the like, and for a modify/delete path there is no
    # "theirs" stage at all. The old workflow ran
    #   git checkout --theirs -- . 2>/dev/null || true ; git add -A
    # which exited non-zero on exactly those paths, swallowed the error and staged whatever
    # git had left: beta's deletion silently REVERTED while the report said beta won, or a file
    # committed with its conflict markers still in it, then pushed unconditionally. A marker in
    # portal.html or index.html takes every tenant's portal and public designer down.
    #
    # Resolve each path to beta's side EXPLICITLY: beta's entry where beta has the path
    # (rev-parse, not cat-file, so a gitlink counts), beta's deletion where it does not.
    # NUL-separated and --literal-pathspecs, so no path name can be mangled or read as a glob
    # that touches OTHER files. A path git invented while moving beta's entry aside (lib~beta,
    # a directory-rename target) looks like a beta deletion here; the "missing from the merge"
    # check below refuses those.
    while IFS= read -r -d '' p; do
      if git rev-parse -q --verify "beta:$p" >/dev/null; then
        git --literal-pathspecs checkout beta -- "$p"
      else
        git --literal-pathspecs rm -q -f --ignore-unmatch -- "$p"
      fi
    done < <(git diff --name-only -z --diff-filter=U)
    STILL="$(git ls-files -u | cut -f2 | sort -u)"
    [ -z "$STILL" ] || refuse "paths still unmerged after taking beta's side: $(echo "$STILL" | tr '\n' ' ')"
    # No `git add -A`: every conflicted path was resolved above and every other path was
    # merged and staged by git, so the commit takes exactly that.
    git commit -q -m "chore: weekly auto-merge of beta into main (conflicts force-resolved, beta won)"
    RESULT="conflicts-force-resolved"
  fi
fi

MERGED_SHA="$(git rev-parse HEAD)"

# The merge commit must contain beta, and the checkout must BE that commit: the gate's
# preflight reads the working tree, and promote pushes MERGED_SHA.
git merge-base --is-ancestor beta HEAD || refuse "the merge commit does not contain beta"
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "the working tree differs from the merge commit"

# "Beta wins" means every file on beta is in what ships. This catches what the resolve loop
# cannot see: git moving beta's file aside on a directory/file clash or a directory rename,
# and a gitlink. Main-only deletions are refused too (rare, and a refusal is the safe side).
LOST="$(git diff --name-only --no-renames --diff-filter=D beta HEAD)"
[ -z "$LOST" ] || refuse "files on beta are missing from the merge: $(echo "$LOST" | tr '\n' ' ')"

# This workflow's token can never push a workflow change (see the workflow's header), so say
# so now rather than fail at the push with a bare "refusing to allow" error.
if ! git diff --quiet "$MAIN_BEFORE" HEAD -- .github/workflows; then
  refuse "beta changes $(git diff --name-only "$MAIN_BEFORE" HEAD -- .github/workflows | tr '\n' ' ')- commit the same change to main by hand first (twin commit), then promote"
fi

# Conflict markers anywhere in the COMMITTED tree, on every path through the merge above,
# because a marker can also reach beta in a commit pushed with --no-verify. A file counts only
# when it has BOTH an opening and a closing marker at the start of a line, the same rule
# preflight uses, so a Markdown underline or a quoted example cannot block a promotion.
MARKED="$(comm -12 \
  <(git grep -lI -e '^<<<<<<< ' HEAD -- . | sed 's/^HEAD://' | sort -u) \
  <(git grep -lI -e '^>>>>>>> ' HEAD -- . | sed 's/^HEAD://' | sort -u))"
[ -z "$MARKED" ] || refuse "conflict markers in: $(echo "$MARKED" | tr '\n' ' ')"

# Where main ends up different from beta. Usually nothing: main only ever receives beta.
# Reported, not refused, so a deliberate hotfix on main is seen. Through a file rather than
# "| head", for the SIGPIPE reason above.
git diff --name-only beta HEAD > "$RUNNER_TEMP/beta-diff.txt"
N="$(wc -l < "$RUNNER_TEMP/beta-diff.txt" | tr -d ' ')"
if [ "$N" -gt 0 ]; then
  BETA_DIFF="${N} file(s) on main differ from beta: $(sed -n '1,40p' "$RUNNER_TEMP/beta-diff.txt" | tr '\n' ' ')"
fi

emit
