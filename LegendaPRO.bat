@echo off
title LegendaPRO
cd /d "%~dp0"
python -m legendapro.server %*
pause
