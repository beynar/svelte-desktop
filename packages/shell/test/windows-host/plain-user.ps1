# Runs `kitop build` in a project as a local user who isn't an administrator, on a machine with
# Developer Mode off: no privilege to make symbolic links. Prints its output, then "exit <code>".
param([string]$Bun, [string]$Dir, [string]$Cwd, [string]$Kitop)
$ErrorActionPreference = 'Stop'
$name = 'kitopplain'
$password = "Kh-$([guid]::NewGuid())"
$secure = ConvertTo-SecureString $password -AsPlainText -Force
if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) { Set-LocalUser -Name $name -Password $secure } else { New-LocalUser -Name $name -Password $secure -PasswordNeverExpires | Out-Null }
reg add 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' /v AllowDevelopmentWithoutDevLicense /t REG_DWORD /d 0 /f | Out-Null
# bun and bunx where that user can read them.
$bin = Join-Path $Dir 'plain-bin'
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item $Bun (Join-Path $bin 'bun.exe') -Force
Copy-Item $Bun (Join-Path $bin 'bunx.exe') -Force
icacls $Dir /grant "${name}:(OI)(CI)F" /T /Q | Out-Null
$log = Join-Path $Dir 'plain.log'
$cmd = Join-Path $Dir 'plain.cmd'
$tmp = Join-Path $Dir 'plain-tmp'
New-Item -ItemType Directory -Force $tmp | Out-Null
Set-Content $cmd "@echo off`r`nset PATH=$bin;%SystemRoot%\system32;%SystemRoot%`r`nset TEMP=$tmp`r`nset TMP=$tmp`r`ncd /d `"$Cwd`"`r`nwhoami /priv | findstr /i symbolic`r`nbun `"$Kitop`" build > `"$log`" 2>&1`r`necho exit %errorlevel% >> `"$log`"`r`n"
$credential = New-Object System.Management.Automation.PSCredential($name, $secure)
$p = Start-Process -FilePath "$env:SystemRoot\system32\cmd.exe" -ArgumentList '/c', "`"$cmd`"" -Credential $credential -WorkingDirectory $Dir -LoadUserProfile -PassThru -Wait -WindowStyle Hidden
"started as $name, cmd exit $($p.ExitCode)"
Get-Content $log
