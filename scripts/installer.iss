[Setup]
AppName=Malia
AppVersion={#AppVersion}
AppPublisher=Lance Oreste
AppPublisherURL=https://github.com/loreste/malia
DefaultDirName={autopf}\Malia
DefaultGroupName=Malia
OutputBaseFilename=malia-win32-x64-setup
OutputDir=.
Compression=lzma2
SolidCompression=yes
ChangesEnvironment=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "malia.exe"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "jse.exe"; DestDir: "{app}\bin"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Check: NeedsAddPath('{app}\bin')

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER,
    'Environment', 'Path', OrigPath)
  then begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Param + ';', ';' + OrigPath + ';') = 0;
end;
