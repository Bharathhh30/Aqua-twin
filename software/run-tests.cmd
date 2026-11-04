@echo off
setlocal
cd /d "%~dp0"
if not defined UV_CACHE_DIR set "UV_CACHE_DIR=%TEMP%\aquatwin-uv-cache"
where uv >nul 2>nul
if errorlevel 1 (
  echo uv is required. Install uv, then run this script again.
  exit /b 1
)
uv run --project . python -m unittest discover -s tests -v
