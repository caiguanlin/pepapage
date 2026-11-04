#!/usr/bin/env bash
# Export, courseware, and reader flow for a completed project (the project is marked completed directly in the DB).
# Usage (from yueya-server/): bash docs/smoke-test-book-completed.sh
B=http://localhost:8080
WT=${WORKER_TOKEN:-dev-worker-token}
MYSQL=${MYSQL:-"/d/devSoft/MySQL/MySQL Server 8.0/bin/mysql.exe"}
U="smoke$(date +%s)"
j() { python -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
show() { echo "== $1"; echo "$2" | head -c 600; echo; }

R=$(curl -s -X POST $B/api/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$U@test.com\",\"password\":\"pass12345\",\"nickname\":\"$U\"}")
T=$(echo "$R" | j "['data']['token']")
H="Authorization: Bearer $T"
R=$(curl -s -X POST $B/api/book-projects -H "$H" -H 'Content-Type: application/json' -d '{"title":"smoke-done","audioMode":"single","sourceType":"pdf","sourceFileName":"a.pdf"}')
P=$(echo "$R" | j "['data']['id']")
echo "project=$P"

"$MYSQL" -uroot -proot yueya -e "UPDATE book_project SET status='completed', current_step_index=4, processing_steps='[{\"key\":\"ocr\",\"status\":\"completed\",\"progress\":100},{\"key\":\"audio_conversion\",\"status\":\"completed\",\"progress\":100},{\"key\":\"transcription\",\"status\":\"completed\",\"progress\":100},{\"key\":\"alignment\",\"status\":\"completed\",\"progress\":100}]' WHERE id=$P" 2>/dev/null

J='Content-Type: application/json'
curl -s -X PUT "$B/api/book-projects/$P/files/json?name=aux-code.json" -H "$H" -H "$J" -d '{"auxCode":7}' >/dev/null
curl -s -X PUT "$B/api/book-projects/$P/files/json?name=book-alignment.json" -H "$H" -H "$J" \
  -d '{"alignments":[{"sentenceIndex":0,"start":0.5,"end":1.5,"confidence":0.9},{"sentenceIndex":1,"start":-1,"end":-1,"confidence":0}]}' >/dev/null
show reader "$(curl -s $B/api/book-projects/$P/reader -H "$H")"

R=$(curl -s -X POST $B/api/book-projects/$P/exports -H "$H" -H "$J" -d '{"type":"oid_zip"}')
show export-create "$R"
E=$(echo "$R" | j "['data']['exportId']")
show export-get "$(curl -s $B/api/book-exports/$E -H "$H")"
R=$(curl -s $B/internal/exports/$E -H "X-Worker-Token: $WT")
show internal-export "$R"
KEY="$(echo "$R" | j "['data']['ossPrefix']")exports/$E.zip"
show progress-running "$(curl -s -X POST $B/internal/exports/$E/progress -H "X-Worker-Token: $WT" -H "$J" -d '{"status":"running","progress":40}')"
show progress-done "$(curl -s -X POST $B/internal/exports/$E/progress -H "X-Worker-Token: $WT" -H "$J" -d "{\"status\":\"succeeded\",\"progress\":100,\"fileName\":\"$KEY\"}")"
show export-get-after "$(curl -s $B/api/book-exports/$E -H "$H")"

R=$(curl -s -X POST $B/api/book-courseware/export -H "$H" -H "$J" -d "{\"projectIds\":[\"$P\"],\"folderIds\":[]}")
show courseware-export "$R"
URL=$(echo "$R" | j "['data']['url']")
curl -s -o /tmp/smoke.nexusbookpkg "$URL"
python -c "import zipfile,json;z=zipfile.ZipFile('/tmp/smoke.nexusbookpkg');print(z.namelist());m=json.loads(z.read('manifest.json'));print(m['version'],[ (p['id'],p['auxCode'],p['data'].get('userId')) for p in m['projects']])"

F=$(curl -s -X POST $B/api/book-folders -H "$H" -H "$J" -d '{"name":"imp"}' | j "['data']['id']")
show courseware-import "$(curl -s -X POST "$B/api/book-courseware/import?folderId=$F" -H "$H" -F "file=@/tmp/smoke.nexusbookpkg")"
show list-folder "$(curl -s "$B/api/book-projects?folderId=$F" -H "$H")"
