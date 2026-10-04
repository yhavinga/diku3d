#!/bin/sh
# Contact sheet of takes: first, middle and last frame of each, one row per take.
#   tools/promo/sheet.sh OUT.jpg TAKEDIR...
out=$1; shift
rows=""
tmp=$(mktemp -d)
for d in "$@"; do
  n=$(basename "$d")
  set -- $(ls "$d"/f*.jpg | sort)
  count=$#
  first=$1; eval mid=\${$(( (count + 1) / 2 ))}; eval last=\${$count}
  magick montage -label "$n" "$first" -label "" "$mid" -label "" "$last" -tile 3x1 -geometry 480x270+2+2 -pointsize 16 "$tmp/$n.jpg"
  rows="$rows $tmp/$n.jpg"
done
magick montage $rows -tile 1x -geometry +0+0 "$out"
