#!/usr/bin/env bash
# Re-run realign on an existing single project, then export oid_zip and pdf.
# Usage: bash yueya-server/docs/e2e-realign-export.sh <email> <password> <projectId>
B=http://localhost:8080
J='Content-Type: application/json'
j() { python -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
show() { echo "== $1"; echo "$2" | head -c ${3:-800}; echo; }
T=$(curl -s -X POST $B/api/auth/login -H "$J" -d "{\"email\":\"$1\",\"password\":\"$2\"}" | j "['data']['token']")
H="Authorization: Bearer $T"; P=$3

show realign "$(curl -s -X POST $B/api/book-projects/$P/realign -H "$H" -H "$J" -d '{}')" 300
for i in $(seq 1 150); do
  R=$(curl -s $B/api/book-projects/$P -H "$H"); st=$(echo "$R" | j "['data']['status']")
  [ "$st" = completed ] || [ "$st" = failed ] && break; sleep 2
done
echo "project final: $(echo "$R" | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['status'],[s['key']+':'+s['status'] for s in d['processingSteps']],d.get('processingError'),d.get('metadata'))")"
show reader "$(curl -s $B/api/book-projects/$P/reader -H "$H" | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(json.dumps({'cueCount':len(d.get('cues',[])),'cues':d.get('cues',[])},ensure_ascii=False))")" 1200

for TYPE in oid_zip pdf; do
  E=$(curl -s -X POST $B/api/book-projects/$P/exports -H "$H" -H "$J" -d "{\"type\":\"$TYPE\"}" | j "['data']['exportId']")
  echo "export $TYPE=$E"
  for i in $(seq 1 150); do
    R=$(curl -s $B/api/book-exports/$E -H "$H"); st=$(echo "$R" | j "['data']['status']")
    [ "$st" = succeeded ] || [ "$st" = failed ] && break; sleep 2
  done
  show "export-$TYPE" "$R" 600
  if [ "$st" = succeeded ]; then
    OUT=/tmp/e2e-export-$TYPE; curl -s -o $OUT "$(echo "$R" | j "['data']['url']")"
    ls -l $OUT; file $OUT 2>/dev/null
    [ $TYPE = oid_zip ] && python -c "import zipfile;z=zipfile.ZipFile('$OUT');print('zip entries:',z.namelist()[:30])"
    [ $TYPE = pdf ] && head -c 8 $OUT && echo
  fi
done
