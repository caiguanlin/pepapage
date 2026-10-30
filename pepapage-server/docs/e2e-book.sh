#!/usr/bin/env bash
# End-to-end with a running worker: single (book_full -> reader -> oid_zip export) and tts (confirm-ocr).
# Usage (from repo root): bash pepapage-server/docs/e2e-book.sh [pdf] [audio]
B=http://localhost:8080
PDF=${1:-素材/page1.pdf}
AUDIO=${2:-素材/audio1.mp3}
U="e2e$(date +%s)"
J='Content-Type: application/json'
j() { python -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
show() { echo "== $1"; echo "$2" | head -c ${3:-800}; echo; }

upload() { # $1 project $2 kind $3 file -> prints key
  local name; name=$(basename "$3")
  local R; R=$(curl -s -X POST $B/api/book-projects/$1/upload-policy -H "$H" -H "$J" -d "{\"kind\":\"$2\",\"fileName\":\"$name\"}")
  local key host; key=$(echo "$R" | j "['data']['key']"); host=$(echo "$R" | j "['data']['host']")
  curl -s -o /dev/null -w "%{http_code}" "$host" -F "key=$key" -F "policy=$(echo "$R" | j "['data']['policy']")" \
    -F "OSSAccessKeyId=$(echo "$R" | j "['data']['accessKeyId']")" -F "signature=$(echo "$R" | j "['data']['signature']")" \
    -F "success_action_status=200" -F "file=@$3" >&2
  echo " uploaded $key" >&2
  echo "$key"
}

wait_project() { # $1 project $2 max seconds; stops on completed/failed/awaiting-review
  for i in $(seq 1 $2); do
    local R; R=$(curl -s $B/api/book-projects/$1 -H "$H")
    local st; st=$(echo "$R" | j "['data']['status']")
    local steps; steps=$(echo "$R" | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(' '.join(s['key']+':'+s['status'] for s in d['processingSteps']), d.get('processingError',''))")
    [ $((i % 5)) -eq 1 ] && echo "  [$i] $st $steps"
    if [ "$st" = completed ] || [ "$st" = failed ]; then echo "  final $st $steps"; return; fi
    if [ "$3" = tts ] && echo "$steps" | grep -q '^ocr:completed' && [ "$(echo "$R" | j "['data'].get('ocrConfirmed')")" != True ]; then echo "  awaiting review: $steps"; return; fi
    sleep 2
  done
  echo "  timeout"
}

R=$(curl -s -X POST $B/api/auth/register -H "$J" -d "{\"email\":\"$U@test.com\",\"password\":\"pass12345\",\"nickname\":\"$U\"}")
T=$(echo "$R" | j "['data']['token']"); H="Authorization: Bearer $T"
echo "user=$U@test.com / pass12345"

echo "##### single"
P=$(curl -s -X POST $B/api/book-projects -H "$H" -H "$J" -d "{\"title\":\"e2e-single\",\"audioMode\":\"single\",\"sourceType\":\"pdf\",\"sourceFileName\":\"$(basename "$PDF")\"}" | j "['data']['id']")
echo "project=$P"
SK=$(upload $P source "$PDF"); AK=$(upload $P audio "$AUDIO")
show submit "$(curl -s -X POST $B/api/book-projects/$P/submit -H "$H" -H "$J" -d "{\"sourceFileKey\":\"$SK\",\"audioFileKey\":\"$AK\"}")" 300
wait_project $P ${SINGLE_WAIT:-300}
show files "$(curl -s $B/api/book-projects/$P/files -H "$H")" 1500
show reader "$(curl -s $B/api/book-projects/$P/reader -H "$H" | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(json.dumps({'pdf':bool(d.get('pdfUrl')),'audio':bool(d.get('audio')),'pages':d.get('pages'),'cueCount':len(d.get('cues',[])),'cues':d.get('cues',[])[:3],'meta':d['project'].get('metadata')},ensure_ascii=False))")" 1500
E=$(curl -s -X POST $B/api/book-projects/$P/exports -H "$H" -H "$J" -d '{"type":"oid_zip"}' | j "['data']['exportId']")
echo "export=$E"
for i in $(seq 1 90); do
  R=$(curl -s $B/api/book-exports/$E -H "$H"); st=$(echo "$R" | j "['data']['status']")
  if [ "$st" = succeeded ] || [ "$st" = failed ]; then break; fi; sleep 2
done
show export-final "$R" 1200
if [ "$st" = succeeded ]; then
  curl -s -o /tmp/e2e-export.zip "$(echo "$R" | j "['data']['url']")"
  python -c "import zipfile;z=zipfile.ZipFile('/tmp/e2e-export.zip');print('zip entries:',z.namelist()[:20])"
fi

echo "##### tts"
P2=$(curl -s -X POST $B/api/book-projects -H "$H" -H "$J" -d "{\"title\":\"e2e-tts\",\"audioMode\":\"tts\",\"sourceType\":\"pdf\",\"sourceFileName\":\"$(basename "$PDF")\",\"ttsVoice\":\"Bella\",\"ttsSpeed\":1.0}" | j "['data']['id']")
echo "project=$P2"
SK2=$(upload $P2 source "$PDF")
show submit "$(curl -s -X POST $B/api/book-projects/$P2/submit -H "$H" -H "$J" -d "{\"sourceFileKey\":\"$SK2\"}")" 300
wait_project $P2 120 tts
show confirm-ocr "$(curl -s -X POST $B/api/book-projects/$P2/confirm-ocr -H "$H" -H "$J" -d '{}')" 400
wait_project $P2 ${TTS_WAIT:-300}
show reader-tts "$(curl -s $B/api/book-projects/$P2/reader -H "$H" | python -c "import sys,json;d=json.load(sys.stdin)['data'];print(json.dumps({'audio':d.get('audio'),'cueCount':len(d.get('cues',[])),'clips':len(d.get('clips') or []),'cues':d.get('cues',[])[:2]},ensure_ascii=False))")" 1200
