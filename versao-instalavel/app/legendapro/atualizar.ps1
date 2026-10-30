# Ajudante da atualização no Windows (chamado por updater.install, fora do programa).
# 1. espera o motor fechar; 2. COPIA a pasta do programa para <pasta>.anterior (copiar funciona mesmo com a
# pasta aberta no Explorer ou presa por outra janela; renomear não); 3. instala a versão nova em silêncio
# por cima; 4. abre o LegendaPRO e confere se ele responde com a versão nova; 5. se não responder em
# 2 minutos, fecha a nova, copia a anterior de volta, abre ela e marca a versão como "falhou".
param(
    [int]$EnginePid,
    [string]$Installer,
    [string]$AppDir,
    [string]$Version,
    [string]$Log,
    [string]$Marker,
    [int]$Port = 0
)
$ErrorActionPreference = "Continue"
$Old = "$AppDir.anterior"
# marcador "instalando" (criado pelo motor ao sair para atualizar): some quando o ajudante termina
$Installing = Join-Path (Split-Path $Log) "instalando"
trap { Remove-Item $Installing -Force -ErrorAction SilentlyContinue; break }

function Note($t) { Add-Content -Path "$Log.ajudante.txt" -Value ("{0:HH:mm:ss} {1}" -f (Get-Date), $t) }

function Find-Version($want) {
    # o motor escolhe uma porta livre entre 7860 e 7869; pode haver outro LegendaPRO aberto em outra porta,
    # então procura a porta que responde com a versão pedida. Só pergunta às portas que estão de fato
    # abertas: no Windows, conectar numa porta fechada demora ~2 s, e varrer as 10 levava ~20 s por rodada.
    $open = @(Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -ge 7860 -and $_.LocalPort -le 7869 } | ForEach-Object { $_.LocalPort } | Sort-Object -Unique)
    foreach ($p in $open) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$p/api/status"
            $j = $r.Content | ConvertFrom-Json
            if ($j.engine -eq "legendapro" -and $j.version -eq $want) { return $p }
        } catch {}
    }
    return $null
}

function Start-Engine($dir) {
    # "legendapro://atualizado" = não abrir outra aba (a página aberta encontra o motor sozinha); na mesma
    # porta de antes, quando se sabe qual era
    $a = @("legendapro://atualizado")
    if ($Port -gt 0) { $a += @("--port", "$Port") }
    Start-Process -FilePath "$dir\LegendaPRO.bat" -ArgumentList $a -WorkingDirectory $dir
}

function Mirror($from, $to) {
    # robocopy /MIR: deixa $to igual a $from; códigos abaixo de 8 = deu certo
    robocopy $from $to /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    return $LASTEXITCODE -lt 8
}

function Give-Up($why) {
    Note $why
    New-Item -ItemType File -Path $Marker -Force | Out-Null
    Remove-Item $Installing -Force -ErrorAction SilentlyContinue
}

Note "atualizando para $Version"
try { Wait-Process -Id $EnginePid -Timeout 60 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 2

if (-not (Mirror $AppDir $Old)) {
    Give-Up "não consegui guardar uma cópia da versão atual; atualização cancelada"
    Start-Engine $AppDir
    exit 1
}
Note "cópia da versão atual guardada em $Old"

$p = Start-Process -FilePath $Installer -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOCANCEL",
    "/DIR=`"$AppDir`"", "/LOG=`"$Log`"") -Wait -PassThru
Note "instalador saiu com código $($p.ExitCode)"

$ok = $false
if ($p.ExitCode -eq 0 -and (Test-Path "$AppDir\LegendaPRO.bat")) {
    Start-Engine $AppDir
    $deadline = (Get-Date).AddSeconds(120)        # 2 minutos de relógio, por mais lentas que sejam as consultas
    while (-not $ok -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 2
        if (Find-Version $Version) { $ok = $true }
    }
}

if ($ok) {
    Note "versão $Version respondendo; apagando a cópia da anterior"
    Remove-Item $Old -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $Installing -Force -ErrorAction SilentlyContinue
    exit 0
}

Note "a versão nova não respondeu: voltando a anterior"
$port = Find-Version $Version
if ($port) {
    # fecha o motor novo que talvez tenha subido sem responder direito
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
# janela do motor novo que não abriu (o .bat fica parado em "aperte uma tecla"): fecha
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$AppDir\LegendaPRO.bat*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
if (Mirror $Old $AppDir) {
    Remove-Item $Old -Recurse -Force -ErrorAction SilentlyContinue
    Give-Up "versão anterior restaurada"
} else {
    Give-Up "não consegui restaurar tudo; a cópia da versão anterior ficou em $Old"
}
Start-Engine $AppDir
exit 1
