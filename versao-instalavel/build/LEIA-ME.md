# Gerar a versão instalável do LegendaPRO

No PowerShell (Windows 10/11 x64), dentro de `versao-instalavel\build\`:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1          # dist + instalador (ou zip, se não houver Inno Setup)
powershell -ExecutionPolicy Bypass -File build.ps1 -Zip     # gera também o zip portátil
powershell -ExecutionPolicy Bypass -File build.ps1 -NoPackage   # só a pasta dist\LegendaPRO
powershell -ExecutionPolicy Bypass -File build.ps1 -Version 1.2.0
```

O que o script faz (tudo com versão fixa; os downloads ficam em `build\cache\` e não são baixados de novo):

1. Python embutido oficial **3.12.10** amd64 (python.org, SHA256 conferido) em `dist\LegendaPRO\python\`. O `python312._pth` recebe `..\app` (onde está o pacote `legendapro`) e `import site`.
2. pip 26.0.1 (get-pip.py) e as dependências de `requirements-dist.txt`, instaladas com `--no-deps` (lista fechada). Assim entra só o `onnxruntime-directml`, e não o `onnxruntime` comum que o faster-whisper pede. Sem torch e sem wheels `nvidia-*`: o app baixa as DLLs CUDA sozinho quando o PC tem placa NVIDIA.
3. Copia `versao-instalavel\app\` (sem `__pycache__`) para `dist\LegendaPRO\app\`.
4. ffmpeg **7.1.1** "essentials" do gyan.dev (GPL, SHA256 conferido): `ffmpeg.exe` e `ffprobe.exe` vão para `app\bin\`. O script confere com `ffmpeg -encoders` que existem `h264_nvenc`, `h264_amf`, `h264_qsv` e `libx264`. A 7.1 funciona com drivers NVIDIA mais antigos do que as versões 8 e 9.
5. Lançador: `LegendaPRO.bat` chama `iniciar.py`. Se o LegendaPRO já está aberto na 7860, só abre o navegador; se a porta está com outro programa, tenta da 7861 à 7869. Fechar a janela encerra o programa. O ícone (`LegendaPRO.ico`) é gerado com o Pillow.
6. Confere se `legendapro.server`, `faster_whisper` e `cv2` importam e se o `onnxruntime` lista o `DmlExecutionProvider`.
7. Se o **Inno Setup 6** estiver instalado (`iscc.exe`), gera `dist\LegendaPRO-Setup.exe` a partir de `installer.iss`. Se não estiver, gera `dist\LegendaPRO-portatil.zip`.

## Instalador (`installer.iss`)

- Instala por usuário, sem pedir administrador, em `%LOCALAPPDATA%\Programs\LegendaPRO`.
- Cria atalho no Menu Iniciar e, se a pessoa marcar a opção, na Área de Trabalho.
- O desinstalador remove só a pasta do programa. Os dados da pessoa ficam em `%LOCALAPPDATA%\LegendaPRO` e **não** são apagados: projetos, presets salvos, modelos e DLLs CUDA.
- Para gerar só o instalador, com o dist já montado: `iscc /DAppVersion=1.0.0 installer.iss`.

## Zip portátil

Para usar o zip, basta extrair e abrir `LegendaPRO.bat`. Os dados continuam indo para `%LOCALAPPDATA%\LegendaPRO`. Para guardar tudo junto do programa (pendrive), crie um arquivo vazio `app\portatil.txt`: os dados passam a ir para `app\dados\`.

## Atualizar as dependências

Resolva a lista de novo para CPython 3.12 / win_amd64 e substitua o `requirements-dist.txt` inteiro:

```
python -m pip install --dry-run --ignore-installed --report rep.json --python-version 3.12 ^
  --platform win_amd64 --implementation cp --only-binary=:all: --target x ^
  numpy opencv-python-headless pillow ctranslate2 av tokenizers huggingface_hub tqdm onnxruntime-directml
```

Depois some o `faster-whisper` à lista. Ele não entra na resolução porque puxaria o `onnxruntime` comum.
Ao trocar a versão do Python ou do ffmpeg no `build.ps1`, atualize também o SHA256 correspondente. Com o valor vazio, o script mostra o hash do arquivo baixado.
