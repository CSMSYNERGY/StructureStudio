#!/bin/sh
# Self-test for the FRESHNESS half of .githooks/pre-push. Run it by hand:
#
#     npm run selftest:pre-push
#
# NOT part of the push gate — it builds real repositories and takes ~40s, which is far too
# slow to sit in front of every push. Same posture as `node scripts/preflight.mjs
# --self-test`: a thing you run when you touch the gate.
#
# WHY IT EXISTS. On 2026-08-04 the freshness check was found to have been INERT for the
# repo's most common push style. It probed the local branch name on origin:
#     git fetch --quiet origin "$(git rev-parse --abbrev-ref HEAD)"
# so `git push origin HEAD:beta` looked for a ref that does not exist on origin, fetch
# exited 128, and the hook printed "could not reach origin — skipping the freshness check"
# and passed. It had presumably been doing that for days. Nothing detected it because
# nothing ever asserted the gate still bites.
#
# Ordinary stale pushes were never actually landing — git rejects those itself, and it only
# ever hands a pre-push hook the REJECT_FETCH_FIRST class of stale ref anyway. The real
# damage was FORCE pushes, which git does not guard at all: a stale
# `git push --force origin HEAD:beta` sailed straight through the inert check and destroyed
# commits a concurrent session had just pushed to beta. Part D below reproduces exactly
# that, against the old hook, and proves this suite catches it.
#
# STRUCTURE
#   A  legitimate pushes must NOT be blocked      (a false refuse blocks every session)
#   B  stale pushes must not land
#   C  the printed remedy must clear the gate
#   D  DISCRIMINATION: the pre-2026-08-04 hook must FAIL A/B. If the old, known-broken
#      hook passes this suite, the suite has stopped testing anything — which is the
#      failure mode that let the original bug live. This part is the whole point.

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "selftest: not inside a git repository" >&2; exit 1; }
HOOK="$ROOT/.githooks/pre-push"
[ -f "$HOOK" ] || { echo "selftest: no hook at $HOOK" >&2; exit 1; }

LAB=$(mktemp -d 2>/dev/null) || { echo "selftest: mktemp -d failed" >&2; exit 1; }
trap 'rm -rf "$LAB"' EXIT HUP INT TERM

# Windows/MAX_PATH: git writes <lab>/origin.git/objects/ab/<38 more chars>, so a deep TMPDIR
# makes pushes die with "Filename too long" / "unpacker error" rather than anything that
# looks like a test failure. Caught for real while developing this: a 180-char temp base.
# core.longpaths is set on every repo below as well, but the check stays because longpaths
# needs opt-in support and this error message is much clearer than git's.
if command -v cygpath >/dev/null 2>&1; then
  LABWIN=$(cygpath -w "$LAB" 2>/dev/null) || LABWIN=$LAB
  if [ "${#LABWIN}" -gt 180 ]; then
    echo "selftest: TMPDIR is too deep for git on Windows (${#LABWIN} chars):" >&2
    echo "  $LABWIN" >&2
    echo "  Re-run with a shorter one, e.g.  TMPDIR=/c/tmp npm run selftest:pre-push" >&2
    exit 1
  fi
fi

pass=0
fail=0
n=0

# ── fixtures ─────────────────────────────────────────────────────────────────
# Fresh bare origin + a clone wired up exactly like a real checkout: the RELATIVE
# core.hooksPath from the runbook, so the clone runs its own copy of the hook.
# $1 = path to the hook to install.
setup() {
  n=$((n + 1))
  W="$LAB/w$n"
  O="$LAB/o$n.git"
  git init -q --bare "$O" || return 1
  git -c core.longpaths=true clone -q "$O" "$W" 2>/dev/null
  cd "$W" || return 1
  git config user.email selftest@example.invalid
  git config user.name selftest
  git config core.autocrlf false
  git config core.longpaths true
  git config core.hooksPath .githooks
  mkdir -p .githooks scripts node_modules/eslint
  cp "$1" .githooks/pre-push
  chmod +x .githooks/pre-push
  # Section 2 stands in as a no-op so a PASS/REFUSE verdict is attributable to the
  # freshness section and nothing else.
  echo 'process.exit(0)' > scripts/preflight.mjs
  echo one > f.txt
  git add -A
  git commit -qm one
  git branch -M beta
  git push -q -u origin beta 2>/dev/null
}

# A concurrent session lands $1 commits on origin/beta. Touches its own file so a rebase
# in the test clone is conflict-free (otherwise part C fails for the wrong reason).
advance_origin() {
  OTHER="$LAB/other$n"
  git -c core.longpaths=true clone -q "$O" "$OTHER" 2>/dev/null
  (
    cd "$OTHER" || exit 1
    git config user.email other@example.invalid
    git config user.name other
    git config core.autocrlf false
    git checkout -q -B beta origin/beta 2>/dev/null
    i=0
    while [ "$i" -lt "$1" ]; do
      i=$((i + 1))
      echo "other $i" >> other.txt
      git add -A
      git commit -qm "other $i"
    done
    git push -q origin beta
  ) || return 1
  cd "$W" || return 1
}

mine() {
  echo "mine $$" >> mine.txt
  git add -A
  git commit -qm "mine"
}

origin_tip() { git --git-dir="$O" rev-parse beta 2>/dev/null; }

ok()   { pass=$((pass + 1)); printf '  ok    %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL  %s\n' "$1"; [ -n "$2" ] && printf '%s\n' "$2" | sed 's/^/          | /' | head -5; }

# check <label> <PASS|REFUSE|BLOCKED> <push args...>
#   PASS    push succeeds
#   REFUSE  our hook refuses (its message is asserted, not just the exit code)
#   BLOCKED push does not land, by the hook or by git's own non-fast-forward check
check() {
  label=$1; expect=$2; shift 2
  out=$(git push "$@" 2>&1); rc=$?
  refused=n
  case $out in *"pre-push: refused"*) refused=y ;; esac
  case $expect in
    PASS)    [ "$rc" -eq 0 ] && ok "$label" || bad "$label" "$out" ;;
    REFUSE)  { [ "$refused" = y ] && [ "$rc" -ne 0 ]; } && ok "$label" || bad "$label" "$out" ;;
    BLOCKED) [ "$rc" -ne 0 ] && ok "$label" || bad "$label" "$out" ;;
  esac
  # The old hook's tell. It must never appear again: it names a failure that cannot
  # actually happen here, because an unreachable origin aborts the push at ref discovery
  # before any hook runs.
  case $out in
    *"could not reach origin"*)
      fail=$((fail + 1)); printf '        !! printed "could not reach origin" — the old false alarm\n' ;;
  esac
}

# The freshness check as it stood before 2026-08-04, kept verbatim as a fixture so part D
# tests the real historical bug rather than a paraphrase of it. Do not "fix" this.
write_old_hook() {
  cat > "$1" <<'OLDHOOK'
#!/bin/sh
cd "$(git rev-parse --show-toplevel)" || exit 1
branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "HEAD" ]; then
  if git fetch --quiet origin "$branch" 2>/dev/null; then
    behind=$(git rev-list --count "HEAD..FETCH_HEAD" 2>/dev/null || echo 0)
    if [ "${behind:-0}" -gt 0 ]; then
      echo "pre-push: refused — origin/$branch has $behind commit(s) you do not have." >&2
      exit 1
    fi
  else
    echo "pre-push: could not reach origin — skipping the freshness check." >&2
  fi
fi
exit 0
OLDHOOK
  chmod +x "$1"
}

OLD_HOOK="$LAB/old-pre-push"
write_old_hook "$OLD_HOOK"

# ── A. legitimate pushes must not be blocked ─────────────────────────────────
echo "A. legitimate pushes are not blocked"
setup "$HOOK" && mine && check "up-to-date, git push origin beta" PASS origin beta
setup "$HOOK" && mine && git checkout -q -b topic/x && check "up-to-date, HEAD:beta from a topic branch" PASS origin HEAD:beta
setup "$HOOK" && mine && git checkout -q --detach && check "up-to-date, HEAD:beta from a detached HEAD" PASS origin HEAD:beta
setup "$HOOK" && check "brand-new branch, absent on origin" PASS origin HEAD:refs/heads/brand-new
setup "$HOOK" && git push -q origin HEAD:refs/heads/doomed 2>/dev/null && check "deleting a remote ref" PASS origin :refs/heads/doomed
setup "$HOOK" && git tag -a v9 -m t && check "pushing a tag" PASS origin v9
setup "$HOOK" && mine && git branch -q side && check "multi-ref push, all current" PASS origin beta side

# ── B. stale pushes must not land ────────────────────────────────────────────
echo "B. stale pushes do not land"
setup "$HOOK" && advance_origin 8 && mine && check "stale, remote tip object absent locally" REFUSE origin beta
setup "$HOOK" && advance_origin 5 && mine && git checkout -q -b topic/y && check "stale via HEAD:beta (the 2026-08-04 bug)" REFUSE origin HEAD:beta
setup "$HOOK" && advance_origin 5 && mine && git checkout -q --detach && check "stale via HEAD:beta, detached HEAD" REFUSE origin HEAD:beta
setup "$HOOK" && advance_origin 2 && mine && git branch -q side && check "multi-ref push, one ref stale" REFUSE origin beta side
setup "$HOOK" && advance_origin 3 && mine && git fetch -q origin beta && check "stale, remote tip present (git's own check)" BLOCKED origin beta
# Objects present AND --force, the only combination git passes through to the hook, so this
# is what exercises counting from the local object database with no fetch.
setup "$HOOK" && advance_origin 3 && mine && git fetch -q origin beta && check "stale + fetched + --force" REFUSE --force origin beta

# ── C. the remedy clears the gate ────────────────────────────────────────────
echo "C. the printed remedy clears the gate"
setup "$HOOK" && advance_origin 4 && mine && git pull -q --rebase origin beta >/dev/null 2>&1 &&
  check "after git pull --rebase origin beta" PASS origin beta

# ── D. discrimination: the old hook must fail this suite ─────────────────────
# Without this, the suite could pass while asserting nothing, which is precisely how the
# original bug survived.
echo "D. the pre-2026-08-04 hook still fails this suite"

# D1 — the old hook waves a stale HEAD:beta straight through, blaming the network.
setup "$OLD_HOOK" && advance_origin 3 && mine && git checkout -q -b topic/z
out=$(git push origin HEAD:beta 2>&1)
case $out in
  *"could not reach origin"*) ok "old hook still reproduces the false 'could not reach origin'" ;;
  *) bad "old hook no longer prints the false network warning — fixture has drifted" "$out" ;;
esac
case $out in
  *"pre-push: refused"*) bad "old hook unexpectedly refused — fixture no longer reproduces the bug" "$out" ;;
  *) ok "old hook does not refuse a stale HEAD:beta (the inert gate)" ;;
esac

# D2 — and the consequence: with the gate inert, a forced push destroys the other
# session's commits. This is the assertion that matters most in the whole file.
setup "$OLD_HOOK" && advance_origin 3 && mine && git checkout -q -b topic/w
before=$(origin_tip)
git push --force origin HEAD:beta >/dev/null 2>&1
after=$(origin_tip)
if [ "$before" != "$after" ] && ! git --git-dir="$O" merge-base --is-ancestor "$before" "$after" 2>/dev/null; then
  ok "old hook lets --force clobber the concurrent session's commits"
else
  bad "old hook no longer clobbers on --force — fixture has drifted" ""
fi

# D3 — the current hook must refuse that same push and leave origin untouched.
setup "$HOOK" && advance_origin 3 && mine && git checkout -q -b topic/v
before=$(origin_tip)
git push --force origin HEAD:beta >/dev/null 2>&1
after=$(origin_tip)
if [ "$before" = "$after" ]; then
  ok "current hook refuses it and preserves those commits"
else
  bad "current hook allowed a stale --force to rewrite origin/beta" ""
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo
echo "-----------------------------------------------"
echo "pre-push self-test: $pass passed, $fail failed"
if [ "$fail" -ne 0 ]; then
  echo "The freshness gate is not behaving as documented in .githooks/pre-push." >&2
  exit 1
fi
echo "freshness gate verified"
