; 方寸 Inno Setup 安装脚本
; 编译：iscc fangcun.iss

[Setup]
AppName=方寸
AppVersion=0.1.0
DefaultDirName={autopf}\方寸
DefaultGroupName=方寸
OutputBaseFilename=方寸_v0.1.0_setup
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
AllowNoIcons=yes

[Files]
Source: "dist\方寸\*"; DestDir: "{app}"; Flags: recursesubdirs

[Icons]
Name: "{group}\方寸"; Filename: "{app}\方寸.exe"
Name: "{group}\卸载方寸"; Filename: "{app}\unins000.exe"
Name: "{autodesktop}\方寸"; Filename: "{app}\方寸.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"

[Run]
Filename: "{app}\方寸.exe"; Description: "立即启动方寸"; Flags: nowait

[Code]
procedure InitializeWizard();
begin
  WizardForm.WelcomeLabel1.Caption := '方寸 tegula';
  WizardForm.WelcomeLabel2.Caption := '本地优先的 AI Agent 任务调度台'#13#10#13#10'安装完成后，方寸将启动在系统托盘中。';
end;
