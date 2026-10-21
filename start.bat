@echo off
rem One-click build and run for Windows.
rem   start.bat            build dist\btdemo.exe, then start it on port 8080 and open the browser
rem   start.bat 9000       same, on port 9000
rem   start.bat pack       only build dist\ (btdemo.exe + config + README) and zip it to dist\btdemo-windows.zip
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set PORT=8080
set PACK=
if /i "%~1"=="pack" (set PACK=1) else if not "%~1"=="" set PORT=%~1

where go >nul 2>nul
if errorlevel 1 (
  echo [btdemo] 没有找到 Go，请先安装 Go 1.22 或更新版本：https://go.dev/dl/
  pause
  exit /b 1
)

echo [btdemo] 正在编译...
if not exist dist mkdir dist
go build -trimpath -ldflags "-s -w" -o dist\btdemo.exe .\cmd\server
if errorlevel 1 (
  echo [btdemo] 编译失败
  pause
  exit /b 1
)
if exist dist\config rmdir /s /q dist\config
xcopy /e /i /q /y config dist\config >nul
copy /y README.md dist\README.md >nul

if defined PACK (
  if exist dist\btdemo-windows.zip del /q dist\btdemo-windows.zip
  powershell -NoProfile -Command "Compress-Archive -Path dist\btdemo.exe,dist\config,dist\README.md -DestinationPath dist\btdemo-windows.zip"
  if errorlevel 1 (
    echo [btdemo] 打包失败
    pause
    exit /b 1
  )
  echo [btdemo] 已打包：dist\btdemo-windows.zip
  exit /b 0
)

echo [btdemo] 启动服务：http://localhost:%PORT%  （关闭此窗口或按 Ctrl+C 停止）
rem open the browser once the server has had a moment to start
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
dist\btdemo.exe -addr :%PORT% -config dist\config
pause
