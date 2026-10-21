@echo off
rem Re-export the behavior trees in bt\ to Go and refresh the registry.
rem Uses the owlbt CLI from BtTree. Set OWLBT to override, e.g.
rem   set OWLBT=node ..\BtTree\packages\server\dist\cli.js
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
if not defined OWLBT set OWLBT=owlbt
call %OWLBT% export bt --format go
if errorlevel 1 (
  echo [btdemo] 导出行为树失败
  exit /b 1
)
go generate ./internal/ai/trees
if errorlevel 1 exit /b 1
echo [btdemo] 行为树已导出到 internal\ai\trees
