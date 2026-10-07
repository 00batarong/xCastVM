@echo off
cd /d "%~dp0"
if not exist node_modules\music-metadata (
  echo Installing music-metadata ^(one time only^)...
  call npm install music-metadata
)
echo Starting xCast Player...
node server.js %*
pause
