#!/usr/bin/env bash
# Proves a change to the SHARED host nginx broke no other site (guide §8): records how
# every named site on this host answers, before and after, and lists any difference.
#
#   vhost-check.sh before     # before touching /etc/nginx
#   vhost-check.sh after      # after `nginx -t && systemctl reload nginx`
#
# Read-only: it only sends GET / to each server_name through this host's own address.
# Results in /root/nginx-vhost-check/. Wildcard and regex server names are skipped.
set -uo pipefail

STAGE="${1:-}"
case "$STAGE" in before|after) ;; *) echo "usage: vhost-check.sh before|after" >&2; exit 2 ;; esac
HOST_IP="${HOST_IP:-172.28.80.50}"
DIR=/root/nginx-vhost-check
mkdir -p "$DIR" && chmod 700 "$DIR"

nginx -T 2>/dev/null | sed 's/#.*//' | grep -oE '(^|[[:space:];{])server_name[[:space:]][^;]*' \
  | sed -E 's/.*server_name[[:space:]]+//' | tr -s ' \t' '\n\n' \
  | grep -vE '^(_|~|$)' | grep -v '\*' | sort -u > "$DIR/names-$STAGE.txt"
[ -s "$DIR/names-$STAGE.txt" ] || { echo "STOP - no server_name found in nginx -T (run as root?)" >&2; exit 1; }

while read -r name; do
  http=$(curl -s -o /dev/null -m 8 -w '%{http_code}' --resolve "$name:80:$HOST_IP" "http://$name/")
  https=$(curl -sk -o /dev/null -m 8 -w '%{http_code}' --resolve "$name:443:$HOST_IP" "https://$name/")
  printf '%s http=%s https=%s\n' "$name" "$http" "$https"
done < "$DIR/names-$STAGE.txt" > "$DIR/$STAGE.txt"

echo "$(wc -l < "$DIR/$STAGE.txt") sites recorded in $DIR/$STAGE.txt"
if [ "$STAGE" = after ] && [ -f "$DIR/before.txt" ]; then
  changed=$(awk 'NR == FNR { seen[$1] = $0; next } ($1 in seen) && seen[$1] != $0 { print "CHANGED  " seen[$1] "  ->  " $2 " " $3 }' \
    "$DIR/before.txt" "$DIR/after.txt")
  missing=$(awk 'NR == FNR { seen[$1] = 1; next } !($1 in seen) { print "MISSING  " $1 }' "$DIR/after.txt" "$DIR/before.txt")
  if [ -z "$changed$missing" ]; then
    echo "OK - every site answers exactly as before"
  else
    printf '%s\n' "$changed" "$missing" | sed '/^$/d'
    echo "Some sites answer differently: compare $DIR/before.txt and $DIR/after.txt (a site can change on its own; retry once)."
  fi
fi
