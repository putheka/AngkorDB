#!/bin/sh
# Checks a built AngkorDB.app (and, if given, the .dmg) the way Gatekeeper will (ANG-57).
#   dev/release/verify-signing.sh path/to/AngkorDB.app [path/to/AngkorDB.dmg]
# Exit status is non-zero when the signature is not valid. A build signed with a Developer ID and
# notarized passes every step; an unsigned or ad-hoc one fails the last two, and says so.
set -u
app="${1:?usage: verify-signing.sh AngkorDB.app [AngkorDB.dmg]}"
dmg="${2:-}"
status=0

step() { printf '\n== %s\n' "$1"; }

step "codesign: the signature is intact and covers everything"
codesign --verify --deep --strict --verbose=2 "$app" || status=1

step "codesign: how it is signed (identity, hardened runtime flag, team)"
codesign -dvv "$app" 2>&1 | grep -E "Authority|TeamIdentifier|flags|Identifier|Signature" || true
codesign -dvv "$app" 2>&1 | grep -q "flags=.*runtime" || { echo "NOT hardened: the 'runtime' flag is missing"; status=1; }

step "entitlements"
codesign -d --entitlements :- "$app" 2>/dev/null || true

step "spctl: would Gatekeeper let it run?"
spctl -a -vv "$app" || status=1

if [ -n "$dmg" ]; then
  step "stapler: is the notarization ticket attached to the dmg?"
  xcrun stapler validate "$dmg" || status=1
  step "spctl: would Gatekeeper open the dmg?"
  spctl -a -vv -t open --context context:primary-signature "$dmg" || status=1
fi

[ "$status" -eq 0 ] && echo "\nAll good." || echo "\nNot ready to ship: see the failing steps above."
exit "$status"
