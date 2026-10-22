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
# What `graft build --deep` uses when nothing is configured, mirrored from graft (src/ai/providers.ts,
# src/ai/llm/databricks.ts): the Databricks AI Gateway, which is also offered as the fallback endpoint
$DatabricksBaseUrl      = 'https://dbc-b40437c6-87d6.cloud.databricks.com'
$DatabricksDefaultModel = 'claude-sonnet-5-5'
# The model id decides the route (and so the wire format) a request takes on the gateway
$DatabricksRoutePath = [ordered]@{
    anthropic = '/ai-gateway/anthropic'   # Anthropic Messages API
    openai    = '/ai-gateway/openai/v1'   # OpenAI-compatible
    mlflow    = '/ai-gateway/mlflow/v1'   # OpenAI-compatible
    serving   = '/serving-endpoints'      # OpenAI-compatible; the endpoint name is the model id
}
$DatabricksRouteLabel = @{
    anthropic = 'Anthropic (Claude) models'
    openai    = 'OpenAI (GPT) models'
    mlflow    = 'Qwen and other open models'
    serving   = 'Workspace serving endpoints'
}
$DatabricksServingPrefix = 'databricks-'
$DatabricksTagsHeader    = 'Databricks-Ai-Gateway-Request-Tags'
$DatabricksTags          = '{"registry_id": "personal"}'
$DatabricksServiceHeader = 'Databricks-Model-Provider-Service'
$DatabricksService       = 'model_service.models.gcp-models'
# Bare Claude ids and the gateway's service ids for the same model; each is the other's fallback
$DatabricksModelMap = [ordered]@{
    'claude-opus-5-5'           = 'model_service.models.1adp-opus-5-5'
    'claude-opus-5'             = 'model_service.models.1adp-opus-5'
    'claude-sonnet-5-5'         = 'model_service.models.1adp-sonnet-5-5'
    'claude-sonnet-5'           = 'model_service.models.1adp-sonnet-5'
    'claude-opus-4-8'           = 'model_service.models.1adp-opus-4-8'
    'claude-opus-4-7'           = 'model_service.models.1adp-opus-4-7'
    'claude-opus-4-6'           = 'model_service.models.1adp-opus-4-6'
    'claude-sonnet-4-6'         = 'model_service.models.1adp-sonnet-4-6'
    'claude-haiku-5-5'          = 'model_service.models.1adp-haiku-5-5'
    'claude-haiku-4-5-20251001' = 'model_service.models.1adp-haiku-4-5'
}
# Offered for a route that will not list its models once another route has accepted the key
$DatabricksKnownModels = @{
    anthropic = @($DatabricksModelMap.Keys)
    openai    = @('model_service.models.1adp-gpt-6-1-sol')
    mlflow    = @('model_service.models.1adp-qwen3-5-122b')
    serving   = @()
}
$NonChatModelRegex = 'embed|tts|whisper|dall-e|image|moderation|audio|transcri|rerank|speech|realtime'
$ModelErrorRegex   = 'model.{0,60}(not found|does not exist|not exist|invalid|unknown|not supported|unsupported|no such|not available|unavailable)|(invalid|unknown|unsupported|no such).{0,20}model'
# Other endpoints graft falls back to (src/ai/providers.ts, the provider SDKs)
$OpenRouterBaseUrl = 'https://openrouter.ai/api/v1'
$OrcaRouterBaseUrl = 'https://api.orcarouter.ai/v1'
$LiteLlmBaseUrl    = 'http://localhost:4000'
# graft's default model per GRAFT_PROVIDER when GRAFT_MODEL is not set (outside the Databricks gateway)
$DefaultLlmModels = @{
    openai          = 'google/gemini-3.8-flash'
    anthropic       = 'claude-sonnet-5'
    litellm         = 'gemini/gemini-3.8-flash'
    orcarouter      = 'google/gemini-3.8-flash'
    'llm-incubator' = 'gemini-3.8-flash'
}
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

# ---- User PATH (HKCU\Environment\Path) ----
# Read and written raw: [Environment]::SetEnvironmentVariable(..., 'User') on Windows PowerShell 5.1 stores the
# value as REG_SZ with every %VAR% already expanded, so the PATH loses its REG_EXPAND_SZ type and its references.

function Get-UserPathEntries {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    if (-not $key) { return @() }
    try { $raw = "$($key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))" }
    finally { $key.Close() }
    return @($raw -split ';' | Where-Object { $_.Trim() })
}

# Comparable form of a PATH entry: expanded, unquoted, no trailing backslash, case-insensitive
function ConvertTo-PathKey([string]$Entry) {
    return [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"')).TrimEnd('\').ToLowerInvariant()
}

function Set-UserPathEntries([string[]]$Entries) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try { $key.SetValue('Path', ($Entries -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString) }
    finally { $key.Close() }
    # Setting and clearing a variable through .NET broadcasts WM_SETTINGCHANGE, so Explorer (and new
    # terminals started from it) pick up the new PATH without signing out
    [Environment]::SetEnvironmentVariable('GRAFT_INSTALLER_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('GRAFT_INSTALLER_REFRESH', $null, 'User')
}

# Adds $Dirs to the user PATH (first when -First, else last), keeping every other entry as written
function Add-UserPath([string[]]$Dirs, [switch]$First) {
    $old  = @(Get-UserPathEntries)
    $want = @($Dirs | ForEach-Object { ConvertTo-PathKey $_ })
    if ($First) {
        $new = @($Dirs) + @($old | Where-Object { (ConvertTo-PathKey $_) -notin $want })
    } else {
        $have = @($old | ForEach-Object { ConvertTo-PathKey $_ })
        $new  = @($old) + @($Dirs | Where-Object { (ConvertTo-PathKey $_) -notin $have })
    }
    if (($new -join ';') -ne ($old -join ';')) { Set-UserPathEntries $new }
}

function Remove-UserPath([string]$Dir) {
    $old = @(Get-UserPathEntries)
    $new = @($old | Where-Object { (ConvertTo-PathKey $_) -ne (ConvertTo-PathKey $Dir) })
    if ($new.Count -ne $old.Count) { Set-UserPathEntries $new }
}

# Where a NEW terminal will find a command: the machine PATH, then the user PATH, as stored in the registry
function Find-InNewTerminal([string]$Name) {
    $dirs = foreach ($scope in 'Machine', 'User') { "$([Environment]::GetEnvironmentVariable('Path', $scope))" -split ';' }
    foreach ($d in $dirs) {
        if (-not $d.Trim()) { continue }
        foreach ($ext in '.exe', '.cmd', '.bat') {
            try { $f = [IO.Path]::Combine([Environment]::ExpandEnvironmentVariables($d.Trim().Trim('"')), "$Name$ext") } catch { continue }
            if (Test-Path -LiteralPath $f -PathType Leaf) { return $f }
        }
    }
    return $null
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
# Resolved the way graft resolves them (Resolve-LlmTarget mirrors resolveConfig in src/ai/providers.ts):
# GRAFT_BASE_URL, ANTHROPIC_BASE_URL, ... and, with nothing configured, the Databricks AI Gateway.

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

# 'default' / 'default:<what>' name a value graft falls back to; anything else is the variable it came from
function Format-Source([string]$Name) {
    if ($Name -eq 'default') { return "graft's built-in default" }
    if ($Name -like 'default:*') { return "graft's default: $($Name.Substring(8))" }
    return "from $Name"
}

$DatabricksSource = 'default:Databricks AI Gateway'

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
function Invoke-Llm([string]$Method, [string]$Uri, [string]$Key, [string]$Auth = 'bearer', [string]$Body, [hashtable]$Extra) {
    $headers = @{ 'anthropic-version' = '2023-06-01' }
    if ($Extra) { foreach ($name in $Extra.Keys) { $headers[$name] = $Extra[$name] } }
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

# ---- Databricks AI Gateway, mirrored from src/ai/llm/databricks.ts ----

# The workspace root https://<workspace>.cloud.databricks.com of a Databricks URL, else $null. Whatever follows
# the host (/, /ai-gateway, /ai-gateway/anthropic, /v1, ...) is dropped: graft derives the route URL from the model
function Get-DatabricksRoot([string]$Url) {
    $raw = "$Url".Trim()
    if (-not $raw) { return $null }
    if ($raw -notmatch '^[a-z][a-z0-9+.-]*://') { $raw = "https://$raw" }
    $u = $null
    if (-not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$u)) { return $null }
    if ($u.Scheme -notin 'http', 'https' -or $u.UserInfo) { return $null }
    if (-not $u.IsDefaultPort -and $u.Port -ne 443) { return $null }
    $domain = ([Uri]$DatabricksBaseUrl).Host -replace '^[^.]+\.', ''
    $hostName = $u.Host.ToLowerInvariant()
    $dot = $hostName.IndexOf('.')
    if ($dot -le 0 -or $hostName.Substring($dot + 1) -ne $domain) { return $null }
    return "https://$hostName"
}

# Drops Claude Code's context-window suffix: claude-opus-5-5[1m] -> claude-opus-5-5
function ConvertTo-DatabricksModel([string]$Model) {
    return ("$Model".Trim() -replace '\[[^\]]*\]$', '')
}

# Which gateway route serves the model, judged from its id
function Get-DatabricksRoute([string]$Model) {
    $id = (ConvertTo-DatabricksModel $Model).ToLowerInvariant()
    if ($id.StartsWith($DatabricksServingPrefix)) { return 'serving' }
    if ($id -match 'claude|opus|sonnet|haiku') { return 'anthropic' }
    if ($id -match 'gpt|codex|(^|[-./_])o\d') { return 'openai' }
    return 'mlflow'
}

# <root>/ai-gateway/anthropic, <root>/ai-gateway/openai/v1, <root>/ai-gateway/mlflow/v1 or <root>/serving-endpoints
function Get-DatabricksRouteUrl([string]$Root, [string]$Route) {
    return $Root.TrimEnd('/') + $DatabricksRoutePath[$Route]
}

# The request-tags header every gateway request carries, plus the provider-service header a bare Claude id needs
function Get-DatabricksHeaders([string]$Model) {
    $h = @{ $DatabricksTagsHeader = $DatabricksTags }
    $id = ConvertTo-DatabricksModel $Model
    if ($id -and (Get-DatabricksRoute $id) -eq 'anthropic' -and -not $id.StartsWith('model_service.')) {
        $h[$DatabricksServiceHeader] = $DatabricksService
    }
    return $h
}

# The other name of the model in $DatabricksModelMap (bare Claude id <-> gateway service id)
function Get-DatabricksModelFallbacks([string]$Model) {
    $id = ConvertTo-DatabricksModel $Model
    foreach ($k in $DatabricksModelMap.Keys) {
        if ($k -ceq $id) { return @($DatabricksModelMap[$k]) }
        if ($DatabricksModelMap[$k] -ceq $id) { return @($k) }
    }
    return @()
}

# GET with graft's retry of a 429 / 5xx / network error (4 attempts, 300 ms doubling)
function Invoke-DatabricksGet([string]$Uri, [string]$Key) {
    for ($attempt = 1; ; $attempt++) {
        $r = Invoke-Llm GET $Uri $Key 'bearer'
        if ($attempt -ge 4 -or ($r.Status -ne 0 -and $r.Status -ne 429 -and $r.Status -lt 500)) { return $r }
        Start-Sleep -Milliseconds (300 * [math]::Pow(2, $attempt - 1))
    }
}

# Like graft's listServingEndpoints: ready llm/v1/chat endpoints this key may query, minus those whose
# AI Gateway rate limit is 0 (every call refused) or whose record cannot be read
function Get-DatabricksServingEndpoints([string]$Root, [string]$Key) {
    $base = "$($Root.TrimEnd('/'))/api/2.0/serving-endpoints"
    $r = Invoke-DatabricksGet $base $Key
    if ($r.Status -lt 200 -or $r.Status -ge 300) { return [pscustomobject]@{ Response = $r; Ids = @() } }
    try { $listed = @(($r.Content | ConvertFrom-Json).endpoints) } catch { $listed = @() }
    $ids = @(foreach ($e in $listed) {
            if (-not $e -or -not $e.name -or $e.task -ne 'llm/v1/chat' -or $e.permission_level -eq 'CAN_VIEW') { continue }
            $ready = if ($e.state -and $e.state.ready) { $e.state.ready } else { 'READY' }
            if ($ready -ne 'READY') { continue }
            $rec = Invoke-DatabricksGet "$base/$([Uri]::EscapeDataString($e.name))" $Key
            if ($rec.Status -lt 200 -or $rec.Status -ge 300) { continue }
            try { $detail = $rec.Content | ConvertFrom-Json } catch { continue }
            $blocked = @($detail.ai_gateway.rate_limits | Where-Object {
                    $_ -and $_.key -in 'endpoint', 'user' -and (($null -ne $_.calls -and $_.calls -eq 0) -or ($null -ne $_.tokens -and $_.tokens -eq 0))
                }).Count
            if (-not $blocked) { $e.name }
        })
    return [pscustomobject]@{ Response = $r; Ids = $ids }
}

# Like graft's listDatabricksModels + listEndpointModels: each route's chat models; once one route accepted the
# key, a route that lists nothing gets graft's known ids. State: ok | auth | unreachable | unlisted
function Get-DatabricksModels([string]$Root, [string]$Key) {
    $listings = @(foreach ($route in $DatabricksRoutePath.Keys) {
            $url = Get-DatabricksRouteUrl $Root $route
            $listed = @()
            if ($route -eq 'serving') {
                $s = Get-DatabricksServingEndpoints $Root $Key
                $r = $s.Response
                $listed = @($s.Ids)
            } else {
                # The Anthropic route lists its models only when told which provider service to ask
                $extra = @{ $DatabricksTagsHeader = $DatabricksTags }
                if ($route -eq 'anthropic') { $extra[$DatabricksServiceHeader] = $DatabricksService }
                $uri = if ($route -eq 'anthropic') { "$url/v1/models?limit=1000" } else { "$url/models" }
                $r = Invoke-Llm GET $uri $Key 'bearer' $null $extra
                if ($r.Status -ge 200 -and $r.Status -lt 300) { $listed = @(ConvertTo-ModelIds $r.Content) }
            }
            $ids = @($listed | Where-Object { $_ -and $_ -notmatch $NonChatModelRegex -and (Get-DatabricksRoute $_) -eq $route } | Select-Object -Unique)
            [pscustomobject]@{ Route = $route; Url = $url; Ids = $ids; Status = $r.Status }
        })
    if (@($listings | Where-Object { $_.Ids.Count }).Count) {
        $models = @(foreach ($l in $listings) { if ($l.Ids.Count) { $l.Ids } else { $DatabricksKnownModels[$l.Route] } })
        return [pscustomobject]@{ State = 'ok'; Models = $models }
    }
    $state = if (@($listings | Where-Object { $_.Status -in 401, 403 }).Count) { 'auth' }
    elseif (-not @($listings | Where-Object { Test-Responded $_ }).Count) { 'unreachable' }
    else { 'unlisted' }
    return [pscustomobject]@{ State = $state; Models = @() }
}

# One tiny request on the route graft sends the model to (then its mapped fallback id). State: ok | auth | model | unknown
function Test-DatabricksChat([string]$Root, [string]$Key, [string]$Model) {
    $sawModelError = $false
    foreach ($id in @(@(ConvertTo-DatabricksModel $Model) + @(Get-DatabricksModelFallbacks $Model))) {
        $route = Get-DatabricksRoute $id
        $url = Get-DatabricksRouteUrl $Root $route
        $uri = if ($route -eq 'anthropic') { "$url/v1/messages" } else { "$url/chat/completions" }
        $body = '{"model":' + ($id | ConvertTo-Json) + ',"max_tokens":16,"messages":[{"role":"user","content":"Reply with OK."}]}'
        $r = Invoke-Llm POST $uri $Key 'bearer' $body (Get-DatabricksHeaders $id)
        if ($r.Status -ge 200 -and $r.Status -lt 300) { return 'ok' }
        if ($r.Status -in 401, 403) { return 'auth' }
        if (($r.Status -in 400, 404, 422) -and ($r.Content -match $ModelErrorRegex)) { $sawModelError = $true; continue }
        return 'unknown'
    }
    if ($sawModelError) { return 'model' }
    return 'unknown'
}

# $null when the URL answers, otherwise a short reason
function Get-LlmUrlProblem([string]$BaseUrl) {
    $root = Get-DatabricksRoot $BaseUrl
    $probe = if ($root) { "$(Get-DatabricksRouteUrl $root 'anthropic')/v1/models" } else { (Get-LlmUris $BaseUrl 'models')[0] }
    $r = Invoke-Llm GET $probe $null
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
    $root = Get-DatabricksRoot $BaseUrl
    if ($root) { return Test-DatabricksChat $root $Key $Model }
    $body = '{"model":' + ($Model | ConvertTo-Json) + ',"max_tokens":16,"messages":[{"role":"user","content":"Reply with OK."}]}'
    foreach ($uri in Get-LlmUris $BaseUrl 'chat/completions') {
        $r = Invoke-Llm POST $uri $Key 'bearer' $body
        if ($r.Status -ge 200 -and $r.Status -lt 300) { return 'ok' }
        if ($r.Status -in 401, 403) { return 'auth' }
        if (($r.Status -in 400, 404, 422) -and ($r.Content -match $ModelErrorRegex)) { return 'model' }
    }
    return 'unknown'
}

# graft also tries a prefixed id (google/gemini-...) under its bare form, and on the Databricks gateway
# a bare Claude id under its service id (and back)
function Test-ModelServed([string]$Model, [string[]]$Ids) {
    $candidates = @($Model, ($Model -split '/')[-1]) + @(Get-DatabricksModelFallbacks $Model)
    $normalized = ConvertTo-DatabricksModel $Model
    if ($normalized -ne $Model) { $candidates += @($normalized) + @(Get-DatabricksModelFallbacks $normalized) }
    foreach ($id in $Ids) { if ($id -cin $candidates) { return $true } }
    return $false
}

# The model graft uses when GRAFT_MODEL is not set, for the endpoint it resolved to
function Get-DefaultLlmModel([string]$BaseUrl, [string]$Provider) {
    if (Get-DatabricksRoot $BaseUrl) { return $DatabricksDefaultModel }
    $p = if ($Provider -and $DefaultLlmModels.ContainsKey($Provider)) { $Provider } else { 'openai' }
    return $DefaultLlmModels[$p]
}

# Mirrors resolveConfig (src/ai/providers.ts): the URL, key and provider `graft build --deep` will use.
# Url is $null only when graft has no URL to use either (GRAFT_PROVIDER=llm-incubator, or an unknown provider).
# Candidates are the other configured URLs, in graft's order, that the first one set hides.
function Resolve-LlmTarget {
    $s = @{}
    foreach ($n in 'GRAFT_PROVIDER', 'GRAFT_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'ORCAROUTER_API_KEY',
        'GRAFT_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENROUTER_BASE_URL', 'ORCAROUTER_BASE_URL') { $s[$n] = Get-LlmSetting $n }
    $providerDefaulted = -not $s['GRAFT_PROVIDER']
    $provider = if ($providerDefaulted) { 'openai' } else { $s['GRAFT_PROVIDER'] }

    $keyName = @('GRAFT_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'ORCAROUTER_API_KEY' | Where-Object { $s[$_] }) | Select-Object -First 1
    $key = if ($keyName) { [pscustomobject]@{ Name = $keyName; Value = $s[$keyName] } } else { $null }
    # A legacy OpenRouter/OrcaRouter key keeps its old routing: never redirected via ANTHROPIC_BASE_URL or to the gateway
    $legacyRouting = $keyName -in 'OPENROUTER_API_KEY', 'ORCAROUTER_API_KEY'

    $urlNames = if ($legacyRouting) { 'GRAFT_BASE_URL', 'OPENROUTER_BASE_URL', 'ORCAROUTER_BASE_URL' }
    else { 'GRAFT_BASE_URL', 'ANTHROPIC_BASE_URL', 'OPENROUTER_BASE_URL', 'ORCAROUTER_BASE_URL' }
    $configured = @($urlNames | Where-Object { $s[$_] } | ForEach-Object { [pscustomobject]@{ Name = $_; Value = $s[$_] } })
    $url = if ($configured.Count) { $configured[0] } else { $null }
    if (-not $url) {
        $default = if ($provider -eq 'openai' -and $keyName -eq 'OPENROUTER_API_KEY') { @($OpenRouterBaseUrl, 'default:OpenRouter, for OPENROUTER_API_KEY') }
        elseif ($provider -eq 'orcarouter') { @($OrcaRouterBaseUrl, 'default:OrcaRouter gateway, for GRAFT_PROVIDER=orcarouter') }
        elseif ($provider -eq 'openai' -and $providerDefaulted -and -not $legacyRouting) { @($DatabricksBaseUrl, $DatabricksSource) }
        elseif ($provider -eq 'litellm') { @($LiteLlmBaseUrl, 'default:local LiteLLM proxy, for GRAFT_PROVIDER=litellm') }
        elseif ($provider -eq 'anthropic') { @('https://api.anthropic.com', 'default:Anthropic API, for GRAFT_PROVIDER=anthropic') }
        elseif ($provider -eq 'openai') { @('https://api.openai.com/v1', 'default:OpenAI API, for the openai provider without a base URL') }
        else { $null }
        if ($default) { $url = [pscustomobject]@{ Name = $default[1]; Value = $default[0] } }
    }
    return [pscustomobject]@{
        Provider   = $provider
        Key        = $key
        Url        = $url
        Candidates = @($configured | Select-Object -Skip 1)
    }
}

# The model graft uses for this URL: on the Databricks gateway GRAFT_MODEL (context suffix dropped) or
# claude-sonnet-5-5; elsewhere GRAFT_MODEL, GRAFT_OPENROUTER_MODEL, ORCAROUTER_MODEL, then the provider's default
function Resolve-LlmModel([string]$BaseUrl, [string]$Provider) {
    $set = Get-LlmSetting 'GRAFT_MODEL'
    if (Get-DatabricksRoot $BaseUrl) {
        if ($set) { return [pscustomobject]@{ Name = 'GRAFT_MODEL'; Value = (ConvertTo-DatabricksModel $set) } }
        return [pscustomobject]@{ Name = 'default'; Value = $DatabricksDefaultModel }
    }
    foreach ($n in 'GRAFT_MODEL', 'GRAFT_OPENROUTER_MODEL', 'ORCAROUTER_MODEL') {
        $v = Get-LlmSetting $n
        if ($v) { return [pscustomobject]@{ Name = $n; Value = $v } }
    }
    return [pscustomobject]@{ Name = 'default'; Value = (Get-DefaultLlmModel $BaseUrl $Provider) }
}

# One Databricks workspace is one endpoint whatever path follows its host
function Get-UrlKey([string]$Url) {
    $root = Get-DatabricksRoot $Url
    if ($root) { return $root }
    return "$Url".Trim().TrimEnd('/').ToLowerInvariant()
}

# The first reachable URL among $Candidates (printing what was tried), or $null
function Find-ReachableUrl($Candidates) {
    foreach ($c in @($Candidates)) {
        $p = Get-LlmUrlProblem $c.Value
        if ($p) { Write-Host "  $($c.Value) ($(Format-Source $c.Name)) is not reachable: $p"; continue }
        Write-Host "  $($c.Value) ($(Format-Source $c.Name)) is reachable."
        return $c.Value
    }
    return $null
}

# State: ok | auth | unreachable | unknown; ModelState: ok | missing | unknown
function Test-LlmAccess([string]$BaseUrl, [string]$Key, [string]$Model) {
    $root = Get-DatabricksRoot $BaseUrl
    $m = if ($root) { Get-DatabricksModels $root $Key } else { Get-LlmModels $BaseUrl $Key }
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
        Write-Host "  $in is not reachable: $problem"
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

    # URL, key and provider exactly as graft resolves them; with nothing configured that is the Databricks AI Gateway
    $target = Resolve-LlmTarget
    $provider = $target.Provider
    $url = $target.Url
    # The other configured URLs graft would reach if the first were unset, then the Databricks gateway as the fallback
    $fallback = [pscustomobject]@{ Name = $DatabricksSource; Value = $DatabricksBaseUrl }
    $candidates = @(@($target.Candidates) + @($fallback) | Where-Object { -not $url -or (Get-UrlKey $_.Value) -ne (Get-UrlKey $url.Value) })
    $urlState = 'ok'
    $problem = $null
    if (-not $url) {
        $urlState = 'unset'
        Write-Warning "No LLM API URL is configured, and graft has no default one for GRAFT_PROVIDER=${provider}: set GRAFT_BASE_URL."
    } elseif ($problem = Get-LlmUrlProblem $url.Value) {
        $urlState = 'unreachable'
        Write-Warning "LLM API URL $($url.Value) ($(Format-Source $url.Name)) is not reachable: $problem"
    }
    if ($urlState -ne 'ok') {
        $suggest = Find-ReachableUrl $candidates
        if ($canPrompt) {
            $picked = Read-LlmUrl $suggest
            if ($picked) {
                Save-LlmSetting 'GRAFT_BASE_URL' $picked.Value
                $url = [pscustomobject]@{ Name = 'GRAFT_BASE_URL'; Value = $picked.Value }
                $urlState = if ($picked.Reachable) { 'ok' } else { 'unreachable' }
            }
        }
    }
    $urlValue = if ($url) { $url.Value } else { $null }
    $dbRoot = Get-DatabricksRoot $urlValue

    # Key and model can only be checked against an endpoint that answers
    $key = $target.Key
    $seen = @{}
    $keys = @(@($key) + @('GRAFT_API_KEY', 'ANTHROPIC_AUTH_TOKEN' | ForEach-Object { [pscustomobject]@{ Name = $_; Value = (Get-LlmSetting $_) } }) |
        Where-Object { $_ -and $_.Value -and -not $seen.ContainsKey($_.Name) } | ForEach-Object { $seen[$_.Name] = $true; $_ })
    $keyValue = if ($key) { $key.Value } else { $null }
    $model = Resolve-LlmModel $urlValue $provider
    $defaultModel = Get-DefaultLlmModel $urlValue $provider
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
                if ($model.Name -ne 'default' -and $ids.Count -and (Test-ModelServed $defaultModel $ids)) { $suggest = $defaultModel }
                if ($canPrompt) {
                    $picked = Read-LlmModel $ids $suggest $url.Value $keyValue
                    if ($picked) {
                        Save-LlmSetting 'GRAFT_MODEL' $picked.Value
                        $model = [pscustomobject]@{ Name = 'GRAFT_MODEL'; Value = (Resolve-LlmModel $urlValue $provider).Value }
                        $modelState = $picked.State
                    }
                }
            }
        }
    }

    $urlNote = @{ ok = 'reachable'; unreachable = 'NOT reachable'; unset = 'NOT SET' }[$urlState]
    $urlShown = if ($url) { "$($url.Value) ($(Format-Source $url.Name))" } else { '(none)' }
    $keyNote = @{ ok = 'accepted'; rejected = 'REJECTED (incorrect or expired)'; unverified = 'could not be verified'; unchecked = 'not checked (endpoint not reachable or not set)' }[$keyState]
    if ($keyState -eq 'ok' -and -not $key) { $keyNote = 'none needed' }
    if ($keyState -eq 'rejected' -and -not $key) { $keyNote = 'NOT SET (the endpoint needs one)' }
    $modelNote = @{ ok = 'available'; missing = 'NOT available'; unknown = 'could not be verified'; unchecked = 'not checked' }[$modelState]
    $keyShown = if ($key) { "$(Format-Secret $key.Value) ($(Format-Source $key.Name))" } else { '(none)' }

    Write-Host ''
    Write-Host "Summary: 'graft build --deep' will use"
    Write-Host "  LLM API URL : $urlShown - $urlNote"
    Write-Host "  API key     : $keyShown - $keyNote"
    Write-Host "  Model       : $($model.Value) ($(Format-Source $model.Name)) - $modelNote"
    if ($dbRoot) {
        # graft derives the request URL and wire format from the model, as for every Databricks workspace URL
        $route = Get-DatabricksRoute $model.Value
        $wire = if ($route -eq 'anthropic') { 'Anthropic Messages API' } else { 'OpenAI-compatible API' }
        Write-Host "  Request URL : $(Get-DatabricksRouteUrl $dbRoot $route) ($($DatabricksRouteLabel[$route]), $wire, Bearer token)"
        $fb = @(Get-DatabricksModelFallbacks $model.Value)
        if ($fb.Count) { Write-Host "  Fallback id : $($fb[0]) (tried when the gateway does not know $($model.Value))" }
    }
    if (Get-LlmSetting 'GRAFT_PROVIDER') {
        $providerNote = if ($dbRoot) { 'from GRAFT_PROVIDER; the Databricks gateway picks the wire format from the model' } else { 'from GRAFT_PROVIDER' }
        Write-Host "  Provider    : $provider ($providerNote)"
    }
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
    Remove-UserPath $NodeHome
    $env:Path = (($env:Path -split ';') | Where-Object { $_ -and (ConvertTo-PathKey $_) -ne (ConvertTo-PathKey $NodeHome) }) -join ';'
    $reinstall = $true
}

# 2. Make sure graft has a recent enough Node
$cur  = Get-CurrentNode
$ours = $cur -and $cur.Path.StartsWith($NodeHome, [StringComparison]::OrdinalIgnoreCase)

# The per-user Node is the one node/npm should resolve to (not just graft's pinned copy)
$ownNode = -not $cur -or $ours

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
if ((Test-Path $NodeHome) -and $ownNode) {
    # First, so an older Node/npm elsewhere in the user PATH cannot shadow the one installed here
    Add-UserPath @($NodeHome, $NpmGlobal) -First
} else {
    # graft only pins this Node (or uses another one); leave which `node` the user gets alone
    Add-UserPath @(@($NodeHome, $NpmGlobal) | Where-Object { Test-Path $_ })
}
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
    # Same for npm/npx in the per-user Node: without npm.ps1, PowerShell runs npm.cmd
    $ps1Shims = @((Join-Path $NpmGlobal 'graft.ps1'), (Join-Path $NodeHome 'npm.ps1'), (Join-Path $NodeHome 'npx.ps1'))
    foreach ($s in $ps1Shims) { if (Test-Path $s) { Remove-Item $s -Force } }
    Write-Host "PowerShell blocks scripts on this PC, so 'graft' and 'npm' will run through graft.cmd / npm.cmd. Run this installer again after 'graft upgrade'."
}

& graft --version

# 5b. Check what a NEW terminal will find, not this session's adjusted PATH
$pathOk = $true
foreach ($tool in 'node', 'npm', 'graft') {
    $found = Find-InNewTerminal $tool
    if ($found) {
        Write-Host ("New terminals will run {0,-5} from {1}" -f $tool, $found)
    } else {
        $pathOk = $false
        Write-Warning "New terminals will NOT find '$tool': it is in neither the machine nor the user PATH."
    }
}
if (-not $pathOk) {
    Write-Host "  User PATH is now: $((Get-UserPathEntries) -join ';')"
    Write-Host "  Expected it to contain $NodeHome (if Node.js was installed there) and $NpmGlobal."
}

# 6. LLM endpoint, key and model for `graft build --deep` (problems here never fail the install)
try {
    Invoke-LlmSetup
} catch {
    Write-Warning "Could not check the LLM settings for 'graft build --deep': $($_.Exception.Message)"
}

Write-Host 'Done. Open a NEW terminal to use graft and npm.'
Write-Host 'Apps that were already open (VS Code, Visual Studio, JetBrains IDEs, ...) keep the old PATH: restart them first,' -ForegroundColor Yellow
Write-Host 'or sign out and back in if a new terminal still cannot find npm.' -ForegroundColor Yellow
Write-Host ''
Write-Host 'REMINDER: in each repository where graft should be used, open a terminal in the repository ROOT folder and run:' -ForegroundColor Yellow
Write-Host '    graft init' -ForegroundColor Yellow
Write-Host '(or from anywhere: graft init <path-to-repository-root>)' -ForegroundColor Yellow
Write-Host 'This builds the repository graph and wires graft into the AI coding agents used with that repository.' -ForegroundColor Yellow
