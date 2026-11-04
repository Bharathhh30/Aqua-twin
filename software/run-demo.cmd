@echo off
setlocal
cd /d "%~dp0"
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=%TEMP%\aquatwin-uv-cache"
where uv >nul 2>nul
if errorlevel 1 (
  echo uv is required. Install uv, then run this script again.
  exit /b 1
)
echo Starting AquaTwin local software demo...
echo Console:      http://127.0.0.1:8000/console
echo Walkthrough:  http://127.0.0.1:8000/
echo API explorer: http://127.0.0.1:8000/docs
echo Press Ctrl+C to stop.
uv run --project . uvicorn aquatwin.api:app --host 127.0.0.1 --port 8000
