@echo off
rem Lançador do LegendaPRO (o build.ps1 copia este arquivo para a raiz do dist com quebras CRLF).
rem Fechar esta janela encerra o programa.
chcp 65001 >nul
setlocal
title LegendaPRO
set "LP_HOME=%~dp0"
set "PYTHONNOUSERSITE=1"
set "PYTHONUTF8=1"
if not exist "%LP_HOME%python\python.exe" (
  echo.
  echo   Não encontrei o Python do programa em "%LP_HOME%python".
  echo   Reinstale o LegendaPRO.
  echo.
  pause
  exit /b 1
)
"%LP_HOME%python\python.exe" "%LP_HOME%iniciar.py" %*
if errorlevel 1 (
  echo.
  echo   O LegendaPRO parou com erro. Leia a mensagem acima.
  echo.
  pause
)
endlocal
