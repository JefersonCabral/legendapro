<#
  Monta a versão instalável do LegendaPRO (Windows x64, PowerShell 5.1+).

    powershell -ExecutionPolicy Bypass -File build.ps1            # dist + instalador (ou zip)
    powershell -ExecutionPolicy Bypass -File build.ps1 -Zip       # gera também o zip portátil
    powershell -ExecutionPolicy Bypass -File build.ps1 -NoPackage # só a pasta dist\LegendaPRO

  Resultado:
    versao-instalavel\dist\LegendaPRO\          programa pronto (python embutido + app + ffmpeg)
    versao-instalavel\dist\LegendaPRO-Setup.exe  se o Inno Setup 6 (iscc.exe) estiver instalado
    versao-instalavel\dist\LegendaPRO-portatil.zip  se não houver iscc (ou com -Zip)

  Downloads ficam em build\cache\ (não são baixados de novo).
#>
[CmdletBinding()]
param(
    [switch]$Zip,
    [switch]$NoPackage,
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # sem isso o Invoke-WebRequest do PS 5.1 fica muito lento
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ------------------------------------------------------------------ versões fixas
$PyVersion   = "3.12.10"
$PyUrl       = "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip"
$PySha256    = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
$PipVersion  = "26.0.1"
$GetPipUrl   = "https://bootstrap.pypa.io/get-pip.py"
# ffmpeg 7.1.1 (gyan.dev "essentials", GPL): tem h264_nvenc, h264_amf, h264_qsv e libx264.
# 7.1 usa os cabeçalhos NVENC 12.2 (driver NVIDIA 551.76+); versões 8/9 exigem drivers mais novos.
$FfVersion   = "7.1.1"
$FfUrl       = "https://github.com/GyanD/codexffmpeg/releases/download/$FfVersion/ffmpeg-$FfVersion-essentials_build.zip"
$FfSha256    = "04861d3339c5ebe38b56c19a15cf2c0cc97f5de4fa8910e4d47e5e6404e4a2d4"
$NeedEncoders = @("h264_nvenc", "h264_amf", "h264_qsv", "libx264")

# ------------------------------------------------------------------ pastas
$Build   = $PSScriptRoot
$Root    = Split-Path $Build -Parent              # versao-instalavel
$AppSrc  = Join-Path $Root "app"
$Cache   = Join-Path $Build "cache"
$DistDir = Join-Path $Root "dist"
$Out     = Join-Path $DistDir "LegendaPRO"
$PyDir   = Join-Path $Out "python"
$Py      = Join-Path $PyDir "python.exe"
$BinDir  = Join-Path $Out "app\bin"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# Roda um executável sem que o stderr dele vire exceção no PS 5.1; falha se o código de saída != 0.
function Run {
    param([string]$Exe, [string[]]$ArgList)
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Exe @ArgList 2>&1 | ForEach-Object { Write-Host "    $_" }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $old
    }
    if ($code -ne 0) { throw "Falhou ($code): $Exe $($ArgList -join ' ')" }
}

function Get-Cached {
    param([string]$Url, [string]$Name, [string]$Sha256 = "")
    $dst = Join-Path $Cache $Name
    if (-not (Test-Path $dst)) {
        Write-Host "    baixando $Url"
        $part = "$dst.part"
        if (Test-Path $part) { Remove-Item $part -Force }
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($curl) {
            Run $curl.Source @("-fL", "--retry", "3", "-sS", "-o", $part, $Url)
        } else {
            Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing
        }
        Move-Item $part $dst
    } else {
        Write-Host "    em cache: $Name"
    }
    $h = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
    if ($Sha256) {
        if ($h -ne $Sha256.ToLower()) {
            Remove-Item $dst -Force
            throw "SHA256 de $Name não confere (veio $h, esperado $Sha256). O arquivo foi apagado do cache."
        }
    } else {
        Write-Host "    SHA256 $Name = $h"
    }
    return $dst
}

function Expand-Zip($zip, $dest) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)
}

function Write-Utf8NoBom($path, [string[]]$lines, $newline = "`r`n") {
    [IO.File]::WriteAllText($path, (($lines -join $newline) + $newline), (New-Object Text.UTF8Encoding($false)))
}

if (-not (Test-Path (Join-Path $AppSrc "legendapro\server.py"))) { throw "Não achei $AppSrc\legendapro\server.py" }
New-Item -ItemType Directory -Force $Cache, $DistDir | Out-Null

# ------------------------------------------------------------------ 1. limpa o dist
Step "Limpando $Out"
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force $Out | Out-Null

# ------------------------------------------------------------------ 2. Python embutido
Step "Python $PyVersion embutido"
$pyZip = Get-Cached $PyUrl "python-$PyVersion-embed-amd64.zip" $PySha256
Expand-Zip $pyZip $PyDir
# ._pth: zip da stdlib, a própria pasta, a pasta do programa (..\app, onde está o pacote legendapro)
# e "import site" (habilita Lib\site-packages, necessário para o pip e as dependências)
$pth = Get-ChildItem $PyDir -Filter "python3*._pth" | Select-Object -First 1
$stdzip = (Get-ChildItem $PyDir -Filter "python3*.zip" | Select-Object -First 1).Name
Write-Utf8NoBom $pth.FullName @($stdzip, ".", "..\app", "", "import site")
Write-Host "    $($pth.Name): $stdzip; .; ..\app; import site"

# ------------------------------------------------------------------ 3. pip + dependências
Step "pip $PipVersion"
$getPip = Get-Cached $GetPipUrl "get-pip.py"
Run $Py @($getPip, "pip==$PipVersion", "--no-setuptools", "--no-wheel", "--no-warn-script-location",
          "--disable-pip-version-check", "--cache-dir", (Join-Path $Cache "pip"))

Step "Dependências (requirements-dist.txt, --no-deps: lista fechada)"
Run $Py @("-m", "pip", "install", "--no-deps", "--only-binary=:all:", "--no-warn-script-location",
          "--disable-pip-version-check", "--cache-dir", (Join-Path $Cache "pip"),
          "-r", (Join-Path $Build "requirements-dist.txt"))

# Conferência: nada de onnxruntime comum, torch ou nvidia-* (o app baixa as DLLs CUDA sob demanda)
$site = Join-Path $PyDir "Lib\site-packages"
# (o onnxruntime comum teria a pasta "onnxruntime-1.x.dist-info"; o DirectML é "onnxruntime_directml-…")
$proibidos = Get-ChildItem $site -Directory | Where-Object { $_.Name -match '^(torch|nvidia|onnxruntime-\d|onnxruntime_gpu)' }
if ($proibidos) { throw "Pacotes que não deviam estar no dist: $($proibidos.Name -join ', ')" }
if (-not (Get-ChildItem $site -Directory -Filter "onnxruntime_directml-*.dist-info")) { throw "onnxruntime-directml não foi instalado" }

# os .exe de Scripts\ (pip.exe, tqdm.exe…) guardam o caminho absoluto do Python do build: não servem no PC da pessoa
Remove-Item (Join-Path $PyDir "Scripts\*.exe") -Force -ErrorAction SilentlyContinue

# ------------------------------------------------------------------ 4. programa
Step "Copiando o programa ($AppSrc)"
$appDst = Join-Path $Out "app"
$old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
& robocopy $AppSrc $appDst /E /NFL /NDL /NJH /NJS /NP /XD __pycache__ dados bin /XF *.pyc portatil.txt | Out-Null
$rc = $LASTEXITCODE; $ErrorActionPreference = $old
if ($rc -ge 8) { throw "robocopy falhou ($rc)" }

# ------------------------------------------------------------------ 5. ffmpeg
Step "ffmpeg $FfVersion"
$ffZip = Get-Cached $FfUrl "ffmpeg-$FfVersion-essentials_build.zip" $FfSha256
$ffTmp = Join-Path $Cache "ffmpeg-$FfVersion"
if (-not (Test-Path (Join-Path $ffTmp "*\bin\ffmpeg.exe"))) { Expand-Zip $ffZip $ffTmp }
$ffBin = (Get-ChildItem $ffTmp -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1).DirectoryName
New-Item -ItemType Directory -Force $BinDir | Out-Null
Copy-Item (Join-Path $ffBin "ffmpeg.exe"), (Join-Path $ffBin "ffprobe.exe") $BinDir
$lic = Get-ChildItem (Split-Path $ffBin -Parent) -Filter "LICENSE*" | Select-Object -First 1
if ($lic) { Copy-Item $lic.FullName (Join-Path $BinDir "FFMPEG-LICENSE.txt") }
Set-Content -Path (Join-Path $BinDir "FFMPEG-LEIA.txt") -Encoding ASCII -Value @(
    "ffmpeg $FfVersion (build essentials de https://www.gyan.dev/ffmpeg/builds/, licenca GPL v3).",
    "Fonte: https://github.com/GyanD/codexffmpeg/releases/tag/$FfVersion e https://ffmpeg.org/")

$ffExe = Join-Path $BinDir "ffmpeg.exe"
$old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
$enc = (& $ffExe -hide_banner -encoders 2>&1) -join "`n"
$ErrorActionPreference = $old
$faltam = $NeedEncoders | Where-Object { $enc -notmatch "\b$_\b" }
if ($faltam) { throw "O ffmpeg baixado não tem os encoders: $($faltam -join ', ')" }
Write-Host "    encoders ok: $($NeedEncoders -join ', ')"

# ------------------------------------------------------------------ 6. lançador e ícone
Step "Lançador"
Copy-Item (Join-Path $Build "iniciar.py") $Out
# .bat precisa de CRLF e UTF-8 sem BOM (o BOM quebraria a primeira linha)
Write-Utf8NoBom (Join-Path $Out "LegendaPRO.bat") (Get-Content (Join-Path $Build "LegendaPRO.bat") -Encoding UTF8)
Run $Py @("-I", (Join-Path $Build "make_icon.py"), (Join-Path $AppSrc "fonts\Poppins-SemiBold.ttf"), (Join-Path $Out "LegendaPRO.ico"))

# pré-compila o programa (abre mais rápido na primeira vez)
Run $Py @("-m", "compileall", "-q", "-j", "0", (Join-Path $Out "app\legendapro"))

# ------------------------------------------------------------------ 7. conferência rápida
Step "Conferindo o Python do dist"
$check = Join-Path $Cache "_check.py"
Write-Utf8NoBom $check @(
    "import onnxruntime, faster_whisper, ctranslate2, cv2, numpy, PIL, av",
    "import legendapro.server",
    "p = onnxruntime.get_available_providers()",
    "print('onnxruntime', onnxruntime.__version__, p)",
    "print('faster_whisper', faster_whisper.__version__, '| ctranslate2', ctranslate2.__version__, '| cv2', cv2.__version__, '| numpy', numpy.__version__)",
    "assert 'DmlExecutionProvider' in p, 'sem DirectML'")
$env:LEGENDAPRO_DATA = Join-Path $Cache "_data_check"
try { Run $Py @($check) } finally { Remove-Item Env:LEGENDAPRO_DATA; Remove-Item (Join-Path $Cache "_data_check") -Recurse -Force -ErrorAction SilentlyContinue }

$size = (Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("    dist: {0:N0} MB em {1}" -f ($size / 1MB), $Out)

if ($NoPackage) { Write-Host "`nPronto (sem empacotar)."; exit 0 }

# ------------------------------------------------------------------ 8. instalador ou zip
$iscc = $null
foreach ($c in @((Get-Command iscc.exe -ErrorAction SilentlyContinue | ForEach-Object Source),
                 "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
                 "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
                 "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
    if ($c -and (Test-Path $c)) { $iscc = $c; break }
}

if ($iscc) {
    Step "Instalador (Inno Setup: $iscc)"
    Run $iscc @("/Q", "/DAppVersion=$Version", (Join-Path $Build "installer.iss"))
    Write-Host "    $DistDir\LegendaPRO-Setup.exe"
} else {
    Write-Host "`n    Inno Setup 6 (iscc.exe) não encontrado: gerando só o zip portátil." -ForegroundColor Yellow
}

if ($Zip -or -not $iscc) {
    Step "Zip portátil"
    $zipPath = Join-Path $DistDir "LegendaPRO-portatil.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($Out, $zipPath, [IO.Compression.CompressionLevel]::Optimal, $true)
    Write-Host ("    {0} ({1:N0} MB)" -f $zipPath, ((Get-Item $zipPath).Length / 1MB))
}

Write-Host "`nPronto." -ForegroundColor Green
