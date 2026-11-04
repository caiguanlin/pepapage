# 后端接口冒烟测试：.\docs\smoke-test.ps1（需后端已在 8080 启动）
$ErrorActionPreference = 'Stop'
$base = 'http://localhost:8080/api'

function Call($method, $path, $body = $null, $token = $null) {
    $headers = @{}
    if ($token) { $headers.Authorization = "Bearer $token" }
    $args = @{ Method = $method; Uri = "$base$path"; Headers = $headers; ContentType = 'application/json; charset=utf-8'; SkipHttpErrorCheck = $true; StatusCodeVariable = 'sc' }
    if ($null -ne $body) { $args.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5 -Compress)) }
    $res = Invoke-RestMethod @args
    [pscustomobject]@{ Status = $sc; Code = $res.code; Message = $res.message; Data = $res.data }
}

function Check($name, $res, $expectStatus) {
    $ok = $res.Status -eq $expectStatus
    '{0} {1,-28} HTTP {2}  {3}' -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $res.Status, $res.Message
    if (-not $ok) { $script:failed++ }
}

$failed = 0
$email = "smoke$(Get-Random)@test.com"

Check '未登录访问被拒' (Call GET '/book-projects') 401
$reg = Call POST '/auth/register' @{ email = $email; password = 'password123' }
Check '注册' $reg 200
$token = $reg.Data.token
Check '重复注册' (Call POST '/auth/register' @{ email = $email; password = 'password123' }) 409
Check '错误密码登录' (Call POST '/auth/login' @{ email = $email; password = 'wrong-pass' }) 401
$login = Call POST '/auth/login' @{ email = $email; password = 'password123' }
Check '登录' $login 200
$token = $login.Data.token
Check '当前用户' (Call GET '/auth/me' $null $token) 200

$f1 = Call POST '/book-folders' @{ name = '一年级' } $token
Check '新建文件夹' $f1 200
$f2 = Call POST '/book-folders' @{ name = '上册'; parentId = $f1.Data.id } $token
Check '新建子文件夹' $f2 200
Check '父文件夹移入子文件夹被拒' (Call PUT "/book-folders/$($f1.Data.id)/parent" @{ parentId = $f2.Data.id } $token) 400

$p = Call POST '/book-projects' @{ sourceFileName = '测试绘本.pdf'; folderId = $f1.Data.id; audioMode = 'multi' } $token
Check '创建多音频项目' $p 200
'     标题={0} 状态={1} 阶段={2}' -f $p.Data.title, $p.Data.status, (($p.Data.processingSteps | ForEach-Object { "$($_.key):$($_.status)" }) -join ',')
Check 'EPUB 被拒' (Call POST '/book-projects' @{ sourceFileName = 'a.epub'; audioMode = 'single' } $token) 400
Check '非法语速被拒' (Call POST '/book-projects' @{ sourceFileName = 'a.pdf'; audioMode = 'tts'; ttsSpeed = 3 } $token) 400
Check '文件夹内项目列表' (Call GET "/book-projects?folderId=$($f1.Data.id)" $null $token) 200
Check '搜索项目' (Call GET "/book-projects?keyword=$([uri]::EscapeDataString('测试绘本'))" $null $token) 200
Check '未上传就提交被拒' (Call POST "/book-projects/$($p.Data.id)/submit" @{ sourceFileKey = 'x' } $token) 400
Check '申请上传凭证' (Call POST "/book-projects/$($p.Data.id)/upload-policy" @{ kind = 'source'; fileName = 'a.pdf' } $token) 200

$other = (Call POST '/auth/register' @{ email = "other$(Get-Random)@test.com"; password = 'password123' }).Data.token
Check '他人项目不可见' (Call GET "/book-projects/$($p.Data.id)" $null $other) 404
Check '他人文件不可签名' (Call GET "/storage/signed-url?key=users/1/x.pdf" $null $other) 403

Check '删除文件夹（项目上移）' (Call DELETE "/book-folders/$($f1.Data.id)" $null $token) 200
$after = Call GET "/book-projects/$($p.Data.id)" $null $token
'     删除文件夹后项目 folderId={0}' -f $(if ($after.Data.folderId) { $after.Data.folderId } else { '根目录' })
Check '删除项目' (Call DELETE "/book-projects/$($p.Data.id)" $null $token) 200
Check '退出登录' (Call POST '/auth/logout' $null $token) 200
Check '退出后 token 失效' (Call GET '/auth/me' $null $token) 401

"`n失败 $failed 项"
