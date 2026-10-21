@echo off
rem One-click build and run for Windows.
rem   start.bat            build dist\btdemo.exe, then start it and open the browser
rem                        (the port is addr in config\world.yaml)
rem   start.bat 9000       same, but on port 9000
rem   start.bat build      only build dist\btdemo.exe (with config\ next to it), don't start it
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set ARGS=
set BUILDONLY=
if /i "%~1"=="build" (set BUILDONLY=1) else if not "%~1"=="" set ARGS=-addr %~1

where go >nul 2>nul
if errorlevel 1 (
  echo [btdemo] 没有找到 Go，请先安装 Go 1.22 或更新版本：https://go.dev/dl/
  pause
  exit /b 1
)

rem pick up trees exported from BtTree since the last build
echo [btdemo] 更新行为树注册表...
go generate ./internal/ai/trees
if errorlevel 1 (
  echo [btdemo] 生成 registry.go 失败
  pause
  exit /b 1
)

rem build the browser client into web\dist (embedded into the exe)
where npm >nul 2>nul
if errorlevel 1 (
  if exist web\dist\index.html (
    echo [btdemo] 没有找到 Node.js，沿用上次构建的前端 web\dist
  ) else (
    echo [btdemo] 没有找到 Node.js，无法构建前端。请先安装 Node.js 20 或更新版本：https://nodejs.org/
    pause
    exit /b 1
  )
) else (
  echo [btdemo] 构建前端...
  pushd web
  if not exist node_modules (
    call npm ci --no-audit --no-fund
    if errorlevel 1 (
      popd
      echo [btdemo] 安装前端依赖失败
      pause
      exit /b 1
    )
  )
  call npm run build
  if errorlevel 1 (
    popd
    echo [btdemo] 前端构建失败
    pause
    exit /b 1
  )
  popd
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

if defined BUILDONLY (
  echo [btdemo] 已编译：dist\btdemo.exe
  exit /b 0
)

echo [btdemo] 启动服务（端口见 config\world.yaml 的 addr；关闭此窗口或按 Ctrl+C 停止）
dist\btdemo.exe -config dist\config -open %ARGS%
pause
