# -Yes: agree up front (unattended runs); without it the user is asked before anything is changed
param([switch]$Yes)

$ErrorActionPreference = 'Stop'
$Registry     = 'https://<company>.jfrog.io/artifactory/api/npm/<npm-repo>/'
$NodeVersion  = 'v24.19.0'
$NodeZipUrl   = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
$NodeHome     = Join-Path $env:LOCALAPPDATA 'Programs\nodejs'
$NpmGlobal    = Join-Path $env:APPDATA 'npm'
$PinnedNode   = Join-Path $NpmGlobal 'node.exe'
$PinMarker    = Join-Path $NpmGlobal 'node.exe.installed-by-graft-script'
$MinNodeMajor = 20
$InUseMsg     = 'Node.js or graft is in use. Close editors/terminals running node or graft, then run this again.'
# Offline package looked up next to this script before falling back to $Registry; any suffix after
# -win32-x64 is accepted (e.g. "nanonets-graft-0.20.0-win32-x64 - Copy.tgz", "... (1).tgz")
$OfflinePkgRegex = '^nanonets-graft-(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?-win32-x64(.*)\.tgz$'
# What `graft build --deep` uses when GRAFT_BASE_URL / ANTHROPIC_BASE_URL / GRAFT_MODEL are not set
$DefaultLlmUrl   = 'https://llm-gateway.ve42034x.automotive-wan.com/v1'
$DefaultLlmModel = 'gemini-3.8-flash'
$LlmTimeoutSec   = 15

function Get-NodeVersion([string]$exe) {
    [version]((& $exe --version).Trim().TrimStart('v'))
}

function Get-CurrentNode {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    [pscustomobject]@{ Path = $cmd.Source; Version = Get-NodeVersion $cmd.Source }
}

function Remove-NodeHome {
    if (Test-Path $NodeHome) {
        # Windows allows renaming the folder of a running node.exe; that process keeps working from the renamed copy
        $old = "$NodeHome.old-$(Get-Date -Format yyyyMMddHHmmss)"
        try { Rename-Item $NodeHome (Split-Path $old -Leaf) } catch { throw $InUseMsg }
    }
    # Copies still in use by a running node.exe are removed on a later run
    Get-ChildItem (Split-Path $NodeHome) -Directory -Filter "$(Split-Path $NodeHome -Leaf).old-*" -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

function Install-PortableNode {
    $zip = Join-Path $env:TEMP "node-$NodeVersion.zip"
    $tmp = Join-Path $env:TEMP "node-$NodeVersion-extract"
    Write-Host "Downloading Node.js $NodeVersion..."
    Invoke-WebRequest $NodeZipUrl -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip $tmp -Force
    New-Item -ItemType Directory -Force (Split-Path $NodeHome) | Out-Null
    Remove-NodeHome
    Move-Item (Join-Path $tmp "node-$NodeVersion-win-x64") $NodeHome
    Remove-Item $zip, $tmp -Recurse -Force
}

# npm's graft.cmd shim runs %APPDATA%\npm\node.exe when it exists, otherwise `node` from PATH
function Set-PinnedNode {
    $src = Join-Path $NodeHome 'node.exe'
    if ((Test-Path $PinnedNode) -and -not (Test-Path $PinMarker)) {
        Write-Warning "$PinnedNode exists and was not created by this script; leaving it alone."
        return $false
    }
    if ((Test-Path $PinnedNode) -and ((Get-NodeVersion $PinnedNode) -eq (Get-NodeVersion $src))) { return $false }
    try { Copy-Item $src $PinnedNode -Force } catch { throw $InUseMsg }
    Set-Content $PinMarker (Get-NodeVersion $src).ToString()
    Write-Host "graft will run on Node.js $(Get-NodeVersion $src) ($PinnedNode)."
    return $true
}

function Remove-PinnedNode {
    if (-not ((Test-Path $PinMarker) -and (Test-Path $PinnedNode))) { return $false }
    try { Remove-Item $PinnedNode -Force } catch { throw $InUseMsg }
    Remove-Item $PinMarker -Force
    Write-Host "Removed $PinnedNode; graft will use the Node.js on PATH."
    return $true
}

# npm's graft.ps1 shim is unsigned, so PowerShell needs at least RemoteSigned to run it.
# Returns $true when PowerShell can run graft.ps1 (after enabling it for this user where allowed).
function Enable-UserScripts {
    $gpo = @('MachinePolicy', 'UserPolicy') | ForEach-Object { Get-ExecutionPolicy -Scope $_ } |
        Where-Object { $_ -ne 'Undefined' } | Select-Object -First 1
    $user    = Get-ExecutionPolicy -Scope CurrentUser
    $machine = Get-ExecutionPolicy -Scope LocalMachine
    # 'Default' means Restricted on Windows client editions
    $blocking = @('Restricted', 'AllSigned', 'Default')

    if ($gpo) { return $gpo -notin $blocking }
    if ($user -ne 'Undefined') { return $user -notin $blocking }
    if ($machine -eq 'AllSigned') { return $false }
    # Undefined everywhere means Restricted on Windows client editions
    if ($machine -in @('Restricted', 'Default', 'Undefined')) {
        # Raises a SecurityException under this script's -ExecutionPolicy Bypass, but the setting is still saved
        try { Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force -ErrorAction Stop }
        catch [System.Security.SecurityException] { }
        if ((Get-ExecutionPolicy -Scope CurrentUser) -ne 'RemoteSigned') { return $false }
        Write-Host "PowerShell execution policy for $env:USERNAME set to RemoteSigned so 'graft' works in PowerShell."
    }
    return $true
}

# Newest nanonets-graft-X.Y.Z-win32-x64.tgz next to this script (a release beats a prerelease of the same version)
function Find-OfflinePackage {
    if (-not $PSScriptRoot) { return $null }
    Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'nanonets-graft-*-win32-x64*.tgz' -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.Name -match $OfflinePkgRegex) {
                $ver = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
                [pscustomobject]@{
                    File    = $_
                    Version = [version]$ver
                    Release = -not $Matches[4]
                    Label   = "$ver$($Matches[4])"
                }
            }
        } |
        Sort-Object Version, Release, { $_.File.LastWriteTime } |
        Select-Object -Last 1
}

# ---- LLM settings for `graft build --deep` ----
# graft reads GRAFT_BASE_URL then ANTHROPIC_BASE_URL, GRAFT_API_KEY then ANTHROPIC_AUTH_TOKEN, and GRAFT_MODEL.

# The value a NEW terminal will see: user scope wins over machine scope; this process is the last resort
function Get-LlmSetting([string]$Name) {
    foreach ($scope in 'User', 'Machine', 'Process') {
        $v = [Environment]::GetEnvironmentVariable($Name, $scope)
        if ($v -and $v.Trim()) { return $v.Trim() }
    }
    return $null
}

function Save-LlmSetting([string]$Name, [string]$Value) {
    [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
    Set-Item -Path "Env:$Name" -Value $Value
    Write-Host "  Saved $Name for $env:USERNAME; new terminals will use it."
}

function Format-Secret([string]$Value) {
    if (-not $Value) { return '(none)' }
    if ($Value.Length -le 12) { return '****' }
    return $Value.Substring(0, 4) + '...' + $Value.Substring($Value.Length - 4)
}

function Format-Source([string]$Name) {
    if ($Name -eq 'default') { return 'built-in default' }
    return "from $Name"
}

function Test-CanPrompt {
    try { return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected } catch { return $false }
}

function Read-Line([string]$Prompt) {
    return "$(Read-Host -Prompt $Prompt)".Trim()
}

function Read-Secret([string]$Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return "$([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))".Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Like graft: the URL as configured, then with the /v1 suffix toggled
function Get-LlmUris([string]$BaseUrl, [string]$Path) {
    $base = $BaseUrl.Trim().TrimEnd('/')
    $toggled = if ($base -match '/v1$') { $base.Substring(0, $base.Length - 3) } else { "$base/v1" }
    return @("$base/$Path", "$toggled/$Path")
}

# Status 0 means no HTTP response at all (DNS, TLS, timeout, connection refused)
function Invoke-Llm([string]$Method, [string]$Uri, [string]$Key, [string]$Auth = 'bearer', [string]$Body) {
    $headers = @{ 'anthropic-version' = '2023-06-01' }
    if ($Key) {
        if ($Auth -eq 'bearer') { $headers['Authorization'] = "Bearer $Key" } else { $headers['x-api-key'] = $Key }
    }
    $req = @{ Uri = $Uri; Method = $Method; Headers = $headers; UseBasicParsing = $true; TimeoutSec = $LlmTimeoutSec; ErrorAction = 'Stop' }
    if ($Body) { $req.Body = [Text.Encoding]::UTF8.GetBytes($Body); $req.ContentType = 'application/json' }
    try {
        $r = Invoke-WebRequest @req
        return [pscustomobject]@{ Status = [int]$r.StatusCode; Content = [string]$r.Content }
    } catch {
        $status = 0
        $resp = $_.Exception.Response
        if ($resp) { try { $status = [int]$resp.StatusCode } catch { $status = 0 } }
        $content = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        # Windows PowerShell 5.1 leaves ErrorDetails empty for some error responses; read the body directly
        if ($resp -is [System.Net.HttpWebResponse] -and -not ($_.ErrorDetails -and $_.ErrorDetails.Message)) {
            try {
                $stream = $resp.GetResponseStream()
                if ($stream.CanSeek) { $stream.Position = 0 }
                $text = (New-Object IO.StreamReader $stream).ReadToEnd()
                if ($text) { $content = $text }
            } catch { }
        }
        return [pscustomobject]@{ Status = $status; Content = [string]$content }
    }
}

# A 5xx (often a proxy that cannot reach the host) counts as not available
function Test-Responded($Response) {
    return $Response.Status -ne 0 -and $Response.Status -lt 500
}

# $null when the URL answers, otherwise a short reason
function Get-LlmUrlProblem([string]$BaseUrl) {
    $r = Invoke-Llm GET (Get-LlmUris $BaseUrl 'models')[0] $null
    if (Test-Responded $r) { return $null }
    if ($r.Status) { return "HTTP $($r.Status)" }
    return $r.Content
}

function ConvertTo-ModelIds([string]$Json) {
    try { $j = $Json | ConvertFrom-Json } catch { return @() }
    $items = if ($j.data) { $j.data } elseif ($j.models) { $j.models } else { @() }
    return @($items | ForEach-Object {
            if ($_ -is [string]) { $_ } elseif ($_.id) { $_.id } elseif ($_.name) { $_.name }
        } | Where-Object { $_ } | Sort-Object -Unique)
}

# State: ok | auth | unreachable | unlisted (the endpoint does not list its models)
function Get-LlmModels([string]$BaseUrl, [string]$Key) {
    foreach ($uri in Get-LlmUris $BaseUrl 'models') {
        $r = $null
        foreach ($auth in 'bearer', 'x-api-key') {
            $r = Invoke-Llm GET $uri $Key $auth
            if (-not $Key -or $r.Status -notin 401, 403) { break }
        }
        if (-not (Test-Responded $r)) { return [pscustomobject]@{ State = 'unreachable'; Models = @() } }
        if ($r.Status -in 401, 403) { return [pscustomobject]@{ State = 'auth'; Models = @() } }
        if ($r.Status -ge 200 -and $r.Status -lt 300) {
            $ids = @(ConvertTo-ModelIds $r.Content)
            if ($ids.Count) { return [pscustomobject]@{ State = 'ok'; Models = $ids } }
        }
    }
    return [pscustomobject]@{ State = 'unlisted'; Models = @() }
}

# For endpoints without a model list: one tiny chat request. State: ok | auth | model | unknown
function Test-LlmChat([string]$BaseUrl, [string]$Key, [string]$Model) {
    $body = '{"model":' + ($Model | ConvertTo-Json) + ',"max_tokens":16,"messages":[{"role":"user","content":"Reply with OK."}]}'
    $modelError = 'model.{0,60}(not found|does not exist|not exist|invalid|unknown|not supported|unsupported|no such|not available|unavailable)|(invalid|unknown|unsupported|no such).{0,20}model'
    foreach ($uri in Get-LlmUris $BaseUrl 'chat/completions') {
        $r = Invoke-Llm POST $uri $Key 'bearer' $body
        if ($r.Status -ge 200 -and $r.Status -lt 300) { return 'ok' }
        if ($r.Status -in 401, 403) { return 'auth' }
        if (($r.Status -in 400, 404, 422) -and ($r.Content -match $modelError)) { return 'model' }
    }
    return 'unknown'
}

# graft also tries a prefixed id (google/gemini-...) under its bare form
function Test-ModelServed([string]$Model, [string[]]$Ids) {
    $bare = ($Model -split '/')[-1]
    foreach ($id in $Ids) { if ($id -eq $Model -or $id -eq $bare) { return $true } }
    return $false
}

# State: ok | auth | unreachable | unknown; ModelState: ok | missing | unknown
function Test-LlmAccess([string]$BaseUrl, [string]$Key, [string]$Model) {
    $m = Get-LlmModels $BaseUrl $Key
    if ($m.State -eq 'ok') {
        $modelState = if (Test-ModelServed $Model $m.Models) { 'ok' } else { 'missing' }
        return [pscustomobject]@{ State = 'ok'; Models = $m.Models; ModelState = $modelState }
    }
    if ($m.State -in 'auth', 'unreachable') {
        return [pscustomobject]@{ State = $m.State; Models = @(); ModelState = 'unknown' }
    }
    switch (Test-LlmChat $BaseUrl $Key $Model) {
        'ok'    { return [pscustomobject]@{ State = 'ok'; Models = @(); ModelState = 'ok' } }
        'auth'  { return [pscustomobject]@{ State = 'auth'; Models = @(); ModelState = 'unknown' } }
        'model' { return [pscustomobject]@{ State = 'ok'; Models = @(); ModelState = 'missing' } }
    }
    return [pscustomobject]@{ State = 'unknown'; Models = @(); ModelState = 'unknown' }
}

# Returns @{ Value; Reachable } or $null when skipped
function Read-LlmUrl([string]$Suggest) {
    while ($true) {
        $hint = if ($Suggest) { "Enter = $Suggest" } else { 'Enter = skip' }
        $in = Read-Line "  LLM API URL to save as GRAFT_BASE_URL ($hint, S = skip for now)"
        if ($in -in 's', 'skip') { return $null }
        if (-not $in) {
            if ($Suggest) { return [pscustomobject]@{ Value = $Suggest; Reachable = $true } }
            return $null
        }
        $uri = $null
        if (-not [Uri]::TryCreate($in, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin 'http', 'https') {
            Write-Host "  '$in' is not a valid http(s) URL (expected e.g. https://my-gateway.example.com/v1)."
            continue
        }
        $in = $in.TrimEnd('/')
        $problem = Get-LlmUrlProblem $in
        if (-not $problem) { return [pscustomobject]@{ Value = $in; Reachable = $true } }
        Write-Host "  $in is not reachable either: $problem"
        if ((Read-Line '  Save it anyway? [y/N]') -match '^(y|yes)$') { return [pscustomobject]@{ Value = $in; Reachable = $false } }
    }
}

# Returns @{ Value; Access } or $null when skipped
function Read-LlmKey([string]$BaseUrl, [string]$Model, $Alt) {
    while ($true) {
        $hint = if ($Alt) { "Enter = use the working key from $($Alt.Name)" } else { 'Enter = skip' }
        $in = Read-Secret "  API key to save as GRAFT_API_KEY, input hidden ($hint, S = skip for now)"
        if ($in -in 's', 'skip') { return $null }
        if (-not $in) {
            if ($Alt) { return [pscustomobject]@{ Value = $Alt.Value; Access = $Alt.Access } }
            return $null
        }
        $access = Test-LlmAccess $BaseUrl $in $Model
        if ($access.State -eq 'auth') { Write-Host '  That key is rejected too (HTTP 401/403).'; continue }
        if ($access.State -ne 'ok') { Write-Host '  Could not verify that key against the endpoint; saving it anyway.' }
        return [pscustomobject]@{ Value = $in; Access = $access }
    }
}

# Returns @{ Value; State } or $null when skipped
function Read-LlmModel([string[]]$Ids, [string]$Suggest, [string]$BaseUrl, [string]$Key) {
    while ($true) {
        $hint = if ($Suggest) { "Enter = $Suggest" } else { 'Enter = skip' }
        $what = if ($Ids.Count) { 'Model number or id' } else { 'Model id' }
        $in = Read-Line "  $what to save as GRAFT_MODEL ($hint, S = skip for now)"
        if ($in -in 's', 'skip') { return $null }
        if (-not $in) {
            if ($Suggest) { return [pscustomobject]@{ Value = $Suggest; State = 'ok' } }
            return $null
        }
        $n = 0
        if ($Ids.Count -and [int]::TryParse($in, [ref]$n)) {
            if ($n -ge 1 -and $n -le $Ids.Count) { return [pscustomobject]@{ Value = $Ids[$n - 1]; State = 'ok' } }
            Write-Host "  Pick a number from 1 to $($Ids.Count)."
            continue
        }
        if ($Ids.Count) {
            if (Test-ModelServed $in $Ids) { return [pscustomobject]@{ Value = $in; State = 'ok' } }
            Write-Host "  '$in' is not in the endpoint's model list."
            if ((Read-Line '  Save it anyway? [y/N]') -match '^(y|yes)$') { return [pscustomobject]@{ Value = $in; State = 'missing' } }
            continue
        }
        switch (Test-LlmChat $BaseUrl $Key $in) {
            'ok'    { return [pscustomobject]@{ Value = $in; State = 'ok' } }
            'model' { Write-Host "  The endpoint does not serve '$in'." }
            default {
                Write-Host "  Could not verify '$in' against the endpoint; saving it anyway."
                return [pscustomobject]@{ Value = $in; State = 'unknown' }
            }
        }
    }
}

function Invoke-LlmSetup {
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $canPrompt = Test-CanPrompt

    Write-Host ''
    Write-Host "Checking the LLM endpoint, API key and model that 'graft build --deep' will use..."

    # URL: the first one set wins in graft, so a broken GRAFT_BASE_URL hides a working default
    $urls = @(@(
        [pscustomobject]@{ Name = 'GRAFT_BASE_URL'; Value = (Get-LlmSetting 'GRAFT_BASE_URL') },
        [pscustomobject]@{ Name = 'ANTHROPIC_BASE_URL'; Value = (Get-LlmSetting 'ANTHROPIC_BASE_URL') },
        [pscustomobject]@{ Name = 'default'; Value = $DefaultLlmUrl }
    ) | Where-Object { $_.Value })
    $url = $urls[0]
    $urlState = 'ok'
    $problem = Get-LlmUrlProblem $url.Value
    if ($problem) {
        $urlState = 'unreachable'
        Write-Warning "LLM API URL $($url.Value) ($(Format-Source $url.Name)) is not reachable: $problem"
        $suggest = $null
        foreach ($c in @($urls | Select-Object -Skip 1)) {
            $p = Get-LlmUrlProblem $c.Value
            if ($p) { Write-Host "  $($c.Value) ($(Format-Source $c.Name)) is not reachable either: $p"; continue }
            Write-Host "  $($c.Value) ($(Format-Source $c.Name)) is reachable."
            $suggest = $c.Value
            break
        }
        if ($canPrompt) {
            $picked = Read-LlmUrl $suggest
            if ($picked) {
                Save-LlmSetting 'GRAFT_BASE_URL' $picked.Value
                $url = [pscustomobject]@{ Name = 'GRAFT_BASE_URL'; Value = $picked.Value }
                $urlState = if ($picked.Reachable) { 'ok' } else { 'unreachable' }
            }
        }
    }

    # Key and model can only be checked against an endpoint that answers
    $keys = @(@(
        [pscustomobject]@{ Name = 'GRAFT_API_KEY'; Value = (Get-LlmSetting 'GRAFT_API_KEY') },
        [pscustomobject]@{ Name = 'ANTHROPIC_AUTH_TOKEN'; Value = (Get-LlmSetting 'ANTHROPIC_AUTH_TOKEN') }
    ) | Where-Object { $_.Value })
    $key = if ($keys.Count) { $keys[0] } else { $null }
    $keyValue = if ($key) { $key.Value } else { $null }
    $model = [pscustomobject]@{ Name = 'GRAFT_MODEL'; Value = (Get-LlmSetting 'GRAFT_MODEL') }
    if (-not $model.Value) { $model = [pscustomobject]@{ Name = 'default'; Value = $DefaultLlmModel } }
    $keyState = 'unchecked'
    $modelState = 'unchecked'

    if ($urlState -eq 'ok') {
        $access = Test-LlmAccess $url.Value $keyValue $model.Value
        if ($access.State -eq 'auth') {
            if ($key) {
                Write-Warning "The API key $($key.Name) ($(Format-Secret $key.Value)) is rejected by $($url.Value) (HTTP 401/403): it is incorrect or expired."
            } else {
                Write-Warning "$($url.Value) needs an API key, but neither GRAFT_API_KEY nor ANTHROPIC_AUTH_TOKEN is set."
            }
            $alt = $null
            foreach ($c in @($keys | Select-Object -Skip 1)) {
                $a = Test-LlmAccess $url.Value $c.Value $model.Value
                if ($a.State -eq 'ok') {
                    Write-Host "  The key in $($c.Name) ($(Format-Secret $c.Value)) is accepted."
                    $alt = [pscustomobject]@{ Name = $c.Name; Value = $c.Value; Access = $a }
                    break
                }
                Write-Host "  The key in $($c.Name) ($(Format-Secret $c.Value)) is not accepted either."
            }
            if ($canPrompt) {
                $picked = Read-LlmKey $url.Value $model.Value $alt
                if ($picked) {
                    Save-LlmSetting 'GRAFT_API_KEY' $picked.Value
                    $key = [pscustomobject]@{ Name = 'GRAFT_API_KEY'; Value = $picked.Value }
                    $keyValue = $picked.Value
                    $access = $picked.Access
                }
            }
        }
        $keyState = switch ($access.State) { 'ok' { 'ok' } 'auth' { 'rejected' } default { 'unverified' } }

        if ($keyState -eq 'ok') {
            $modelState = $access.ModelState
            if ($modelState -eq 'missing') {
                Write-Warning "Model '$($model.Value)' ($(Format-Source $model.Name)) is not available at $($url.Value)."
                $ids = @($access.Models)
                if ($ids.Count) {
                    Write-Host '  Models served by the endpoint:'
                    for ($i = 0; $i -lt $ids.Count; $i++) { Write-Host ('  {0,4}. {1}' -f ($i + 1), $ids[$i]) }
                }
                $suggest = $null
                if ($model.Name -ne 'default' -and $ids.Count -and (Test-ModelServed $DefaultLlmModel $ids)) { $suggest = $DefaultLlmModel }
                if ($canPrompt) {
                    $picked = Read-LlmModel $ids $suggest $url.Value $keyValue
                    if ($picked) {
                        Save-LlmSetting 'GRAFT_MODEL' $picked.Value
                        $model = [pscustomobject]@{ Name = 'GRAFT_MODEL'; Value = $picked.Value }
                        $modelState = $picked.State
                    }
                }
            }
        }
    }

    $urlNote = @{ ok = 'reachable'; unreachable = 'NOT reachable' }[$urlState]
    $keyNote = @{ ok = 'accepted'; rejected = 'REJECTED (incorrect or expired)'; unverified = 'could not be verified'; unchecked = 'not checked (endpoint not reachable)' }[$keyState]
    if ($keyState -eq 'ok' -and -not $key) { $keyNote = 'none needed' }
    if ($keyState -eq 'rejected' -and -not $key) { $keyNote = 'NOT SET (the endpoint needs one)' }
    $modelNote = @{ ok = 'available'; missing = 'NOT available'; unknown = 'could not be verified'; unchecked = 'not checked' }[$modelState]
    $keyShown = if ($key) { "$(Format-Secret $key.Value) ($(Format-Source $key.Name))" } else { '(none)' }

    Write-Host ''
    Write-Host "Summary: 'graft build --deep' will use"
    Write-Host "  LLM API URL : $($url.Value) ($(Format-Source $url.Name)) - $urlNote"
    Write-Host "  API key     : $keyShown - $keyNote"
    Write-Host "  Model       : $($model.Value) ($(Format-Source $model.Name)) - $modelNote"
    $provider = Get-LlmSetting 'GRAFT_PROVIDER'
    if ($provider) { Write-Host "  Provider    : $provider (from GRAFT_PROVIDER)" }
    if ($urlState -ne 'ok' -or $keyState -ne 'ok' -or $modelState -ne 'ok') {
        if (-not $canPrompt) { Write-Host '  (No interactive console, so nothing was asked.)' }
        Write-Host "  'graft build --deep' may fail until this is fixed. Fix it later with 'graft api url', 'graft api key' and 'graft model',"
        Write-Host '  or set GRAFT_BASE_URL / GRAFT_API_KEY / GRAFT_MODEL for your user and open a new terminal.'
    }
}

# 0. Nothing is downloaded, installed or changed before the user agrees
$plannedPkg = Find-OfflinePackage
$graftSource = if ($plannedPkg) { "the offline package $($plannedPkg.File.Name) next to this script" } else { "the npm registry $Registry (npm login may ask for credentials)" }
Write-Host "This script will install or upgrade graft for user $env:USERNAME (no admin rights needed). It may:"
Write-Host "  - download Node.js $NodeVersion from nodejs.org into $NodeHome, if no suitable Node.js is found"
Write-Host "  - add $NodeHome and $NpmGlobal to your user PATH and set the npm prefix"
Write-Host "  - install graft globally with npm from $graftSource"
Write-Host '  - set the PowerShell execution policy for your user to RemoteSigned, so graft runs in PowerShell'
Write-Host '  - check the LLM endpoint, API key and model and, if you choose to, save GRAFT_BASE_URL / GRAFT_API_KEY / GRAFT_MODEL'
if ($Yes) {
    Write-Host 'Proceeding (-Yes was given).'
} elseif (-not (Test-CanPrompt)) {
    Write-Host 'No interactive console to ask for agreement; nothing was changed. Run again with -Yes to install unattended.'
    exit 2
} elseif ((Read-Line 'Do you agree and want to continue? [y/N]') -notmatch '^(y|yes)$') {
    Write-Host 'Installation cancelled; nothing was downloaded, installed or changed.'
    exit 2
}
Write-Host ''

$wanted    = [version]$NodeVersion.TrimStart('v')
$reinstall = $false
$pin       = $false

# 1. A recent machine-wide Node makes the per-user copy unnecessary
$machineDir = [Environment]::GetEnvironmentVariable('Path', 'Machine') -split ';' |
    Where-Object { $_ -and (Test-Path (Join-Path $_ 'node.exe')) } | Select-Object -First 1
$machineVer = $null
if ($machineDir) { $machineVer = Get-NodeVersion (Join-Path $machineDir 'node.exe') }

if ($machineVer -and $machineVer.Major -ge $MinNodeMajor -and (Test-Path $NodeHome)) {
    Write-Host "Machine-wide Node.js $machineVer found; removing the per-user copy."
    Remove-NodeHome
    $userParts = @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ -and $_ -ne $NodeHome })
    [Environment]::SetEnvironmentVariable('Path', ($userParts -join ';'), 'User')
    $env:Path = (($env:Path -split ';') | Where-Object { $_ -ne $NodeHome }) -join ';'
    $reinstall = $true
}

# 2. Make sure graft has a recent enough Node
$cur  = Get-CurrentNode
$ours = $cur -and $cur.Path.StartsWith($NodeHome, [StringComparison]::OrdinalIgnoreCase)

if (-not $cur) {
    Install-PortableNode
} elseif ($ours) {
    if ($cur.Version -lt $wanted) {
        Write-Host "Upgrading Node.js $($cur.Version) -> $wanted"
        if ($cur.Version.Major -ne $wanted.Major) { $reinstall = $true }
        Install-PortableNode
    } else {
        Write-Host "Using Node.js $($cur.Version) ($($cur.Path))."
    }
} elseif ($cur.Version.Major -lt $MinNodeMajor) {
    # An old Node this script cannot upgrade (e.g. machine-wide): give graft its own
    Write-Host "Node.js $($cur.Version) at $($cur.Path) is too old for graft; graft gets its own Node.js $wanted."
    $pin = $true
    $portableExe = Join-Path $NodeHome 'node.exe'
    if (-not (Test-Path $portableExe) -or (Get-NodeVersion $portableExe) -lt $wanted) { Install-PortableNode }
} else {
    Write-Host "Using Node.js $($cur.Version) ($($cur.Path))."
}

if ($pin) {
    if (Set-PinnedNode) { $reinstall = $true }
} elseif (Remove-PinnedNode) {
    $reinstall = $true
}

# 3. User-level PATH (no admin); this session uses the per-user Node first
New-Item -ItemType Directory -Force $NpmGlobal | Out-Null
$parts = @(([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ })
foreach ($p in @($NodeHome, $NpmGlobal)) {
    if ((Test-Path $p) -and ($parts -notcontains $p)) { $parts += $p }
}
[Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
$env:Path = "$NpmGlobal;$env:Path"
if (Test-Path $NodeHome) { $env:Path = "$NodeHome;$env:Path" }

# 4. npm configuration and graft: the newest offline package next to this script, else the registry
& npm config set prefix $NpmGlobal --location=user

$installArgs = @('install', '-g')
$offline = $plannedPkg
if ($offline) {
    Write-Host "Installing graft $($offline.Label) from the offline package $($offline.File.FullName)"
    $installArgs += $offline.File.FullName
} else {
    if ($Registry -match '<[^>]+>') {
        throw "No offline graft package (nanonets-graft-X.Y.Z-win32-x64.tgz) next to this script, and the npm registry in install-graft.ps1 is still a placeholder: $Registry"
    }
    Write-Host "No offline graft package (nanonets-graft-X.Y.Z-win32-x64.tgz) next to this script; installing from $Registry"
    & npm config set '@nanonets:registry' $Registry --location=user
    & npm login --registry $Registry --scope=@nanonets     # remove if anonymous read is allowed
    $installArgs += '@nanonets/graft'
}

# Reinstall when the Node running graft changed, so its native modules match
if ($reinstall) { $installArgs += '--force' }
& npm @installArgs
if ($LASTEXITCODE -ne 0) { throw 'graft install failed' }

# 5. Let `graft` run from PowerShell terminals
if (-not (Enable-UserScripts)) {
    # Without graft.ps1, PowerShell resolves `graft` to graft.cmd, which the execution policy does not affect
    $ps1Shim = Join-Path $NpmGlobal 'graft.ps1'
    if (Test-Path $ps1Shim) { Remove-Item $ps1Shim -Force }
    Write-Host "PowerShell blocks scripts on this PC, so 'graft' will run through graft.cmd. Run this installer again after 'graft upgrade'."
}

& graft --version

# 6. LLM endpoint, key and model for `graft build --deep` (problems here never fail the install)
try {
    Invoke-LlmSetup
} catch {
    Write-Warning "Could not check the LLM settings for 'graft build --deep': $($_.Exception.Message)"
}

Write-Host 'Done. Open a NEW terminal to use graft.'
Write-Host ''
Write-Host 'REMINDER: in each repository where graft should be used, open a terminal in the repository ROOT folder and run:' -ForegroundColor Yellow
Write-Host '    graft init' -ForegroundColor Yellow
Write-Host '(or from anywhere: graft init <path-to-repository-root>)' -ForegroundColor Yellow
Write-Host 'This builds the repository graph and wires graft into the AI coding agents used with that repository.' -ForegroundColor Yellow
