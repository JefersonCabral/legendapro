; Instalador do LegendaPRO (Inno Setup 6). Gerado pelo build.ps1:
;   iscc /DAppVersion=1.0.0 installer.iss
; Pré-requisito: a pasta ..\dist\LegendaPRO já montada pelo build.ps1.
;
; - Instala por usuário (sem admin) em %LOCALAPPDATA%\Programs\LegendaPRO.
; - Atalhos no Menu Iniciar e (opcional) na Área de Trabalho.
; - O desinstalador remove só a pasta do programa. Os dados da pessoa (projetos, presets salvos,
;   modelos baixados, DLLs CUDA) ficam em %LOCALAPPDATA%\LegendaPRO e NÃO são apagados.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppName "LegendaPRO"
#define Src "..\dist\LegendaPRO"

[Setup]
AppId={{6B0E3F2A-8C51-4D7E-9A3B-1F2C4D5E6A70}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=LegendaPRO
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=LegendaPRO-Setup
SetupIconFile={#Src}\LegendaPRO.ico
UninstallDisplayIcon={app}\LegendaPRO.ico
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na Área de Trabalho"; GroupDescription: "Atalhos:"

[InstallDelete]
; atualização por cima de uma versão antiga: tira bibliotecas e código velhos antes de copiar
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\app\legendapro"
Type: filesandordirs; Name: "{app}\app\ui"

[Files]
Source: "{#Src}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\LegendaPRO.bat"; WorkingDir: "{app}"; IconFilename: "{app}\LegendaPRO.ico"; Comment: "Legendas animadas para vídeos"
Name: "{autoprograms}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\LegendaPRO.bat"; WorkingDir: "{app}"; IconFilename: "{app}\LegendaPRO.ico"; Tasks: desktopicon

[Registry]
; link legendapro://abrir: o site abre o motor com um clique (por usuário, sem admin; sai na desinstalação)
Root: HKCU; Subkey: "Software\Classes\legendapro"; ValueType: string; ValueName: ""; ValueData: "URL:LegendaPRO"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\legendapro"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\legendapro\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\LegendaPRO.ico"
Root: HKCU; Subkey: "Software\Classes\legendapro\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\LegendaPRO.bat"" ""%1"""

[Run]
Filename: "{app}\LegendaPRO.bat"; WorkingDir: "{app}"; Description: "Abrir o LegendaPRO agora"; Flags: postinstall nowait skipifsilent shellexec

[UninstallDelete]
; só o que o próprio programa cria dentro da pasta de instalação (caches do Python).
; NUNCA {localappdata}\LegendaPRO: lá ficam os projetos da pessoa.
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\app\legendapro\__pycache__"
Type: filesandordirs; Name: "{app}\__pycache__"
Type: dirifempty; Name: "{app}\app"
Type: dirifempty; Name: "{app}"

[Code]
// Impede instalar dentro da pasta de dados (o desinstalador apagaria a pasta do programa).
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Dados, Dir: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    Dados := Lowercase(RemoveBackslashUnlessRoot(ExpandConstant('{localappdata}\LegendaPRO')));
    Dir := Lowercase(RemoveBackslashUnlessRoot(WizardDirValue));
    if (Dir = Dados) or (Pos(Dados + '\', Dir + '\') = 1) then
    begin
      MsgBox('Essa pasta é onde ficam os seus projetos. Escolha outra pasta para instalar o programa.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and not UninstallSilent then
    MsgBox('O LegendaPRO foi removido.' + #13#10 + #13#10 +
           'Seus projetos e presets continuam em:' + #13#10 + ExpandConstant('{localappdata}\LegendaPRO') + #13#10 +
           'Apague essa pasta à mão se não for mais usar.', mbInformation, MB_OK);
end;
