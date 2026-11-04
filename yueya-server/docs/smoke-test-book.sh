#!/usr/bin/env bash
# 新接口冒烟测试（files / exports / reader / courseware / internal）。用法：bash docs/smoke-test-book.sh
B=http://localhost:8080
WT=${WORKER_TOKEN:-dev-worker-token}
U="smoke$(date +%s)"
j() { python -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
show() { echo "== $1"; echo "$2" | head -c 400; echo; }

R=$(curl -s -X POST $B/api/auth/register -H 'Content-Type: application/json' -d "{\"email\":\"$U@test.com\",\"password\":\"pass1234\"}")
show register "$R"
T=$(echo "$R" | j "['data']['token']")
H="Authorization: Bearer $T"

R=$(curl -s -X POST $B/api/book-projects -H "$H" -H 'Content-Type: application/json' -d '{"title":"smoke","audioMode":"single","sourceType":"pdf","sourceFileName":"a.pdf"}')
show create "$R"
P=$(echo "$R" | j "['data']['id']")

show files-list "$(curl -s $B/api/book-projects/$P/files -H "$H")"
show put-json "$(curl -s -X PUT "$B/api/book-projects/$P/files/json?name=aux-code.json" -H "$H" -H 'Content-Type: application/json' -d '{"auxCode":12}')"
show get-json "$(curl -s "$B/api/book-projects/$P/files/json?name=aux-code.json" -H "$H")"
show get-json-missing "$(curl -s "$B/api/book-projects/$P/files/json?name=book-ocr.json" -H "$H")"
show put-json-forbidden "$(curl -s -X PUT "$B/api/book-projects/$P/files/json?name=book-ocr.json" -H "$H" -H 'Content-Type: application/json' -d '{}')"
show files-url "$(curl -s "$B/api/book-projects/$P/files/url?name=aux-code.json" -H "$H")"
show files-url-404 "$(curl -s -w ' HTTP%{http_code}' "$B/api/book-projects/$P/files/url?name=nope.json" -H "$H")"
show bad-name "$(curl -s "$B/api/book-projects/$P/files/json?name=../x.json" -H "$H")"
show custom-audio-policy "$(curl -s -X POST $B/api/book-projects/$P/upload-policy -H "$H" -H 'Content-Type: application/json' -d '{"kind":"custom_audio","fileName":"a.mp3","boxKey":"p1-b2"}')"
show delete-forbidden "$(curl -s -X DELETE "$B/api/book-projects/$P/files?name=aux-code.json" -H "$H")"
show confirm-ocr-single "$(curl -s -X POST $B/api/book-projects/$P/confirm-ocr -H "$H" -H 'Content-Type: application/json' -d '{}')"
show realign-uploading "$(curl -s -X POST $B/api/book-projects/$P/realign -H "$H" -H 'Content-Type: application/json' -d '{}')"
show reader "$(curl -s $B/api/book-projects/$P/reader -H "$H")"

R=$(curl -s -X POST $B/api/book-projects/$P/exports -H "$H" -H 'Content-Type: application/json' -d '{"type":"pdf"}')
show export-create "$R"
E=$(echo "$R" | j "['data']['exportId']")
show export-get "$(curl -s $B/api/book-exports/$E -H "$H")"
show internal-export-noauth "$(curl -s -w ' HTTP%{http_code}' $B/internal/exports/$E)"
show internal-export "$(curl -s $B/internal/exports/$E -H "X-Worker-Token: $WT")"
show internal-export-progress "$(curl -s -X POST $B/internal/exports/$E/progress -H "X-Worker-Token: $WT" -H 'Content-Type: application/json' -d "{\"status\":\"succeeded\",\"progress\":100,\"fileName\":\"users/x/book-projects/$P/exports/$E.pdf\"}")"
show export-get-after "$(curl -s $B/api/book-exports/$E -H "$H")"

show courseware-export-empty "$(curl -s -X POST $B/api/book-courseware/export -H "$H" -H 'Content-Type: application/json' -d "{\"projectIds\":[\"$P\"],\"folderIds\":[]}")"
show delete-project "$(curl -s -X DELETE $B/api/book-projects/$P -H "$H")"
