@echo off
color 0C
title Wicked Alt Manager - Auto-Restart (Supervisor)
echo.
echo ============================================
echo   Wicked Alt Manager - Auto-Restart Loop
echo ============================================
echo.

REM Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js not found. Install Node.js 20 LTS.
  pause
  exit /b 1
)

REM Check/create .env
if not exist .env (
  echo [INFO] Creating .env...
  (
    echo # Wicked Alt Manager Configuration
    echo # Get your Discord bot token from: https://discord.com/developers/applications
    echo DISCORD_TOKEN=
  ) > .env
  echo [ERROR] .env created but DISCORD_TOKEN is empty!
  echo [INFO] Edit .env, add your token, then run this script again.
  pause
  exit /b 1
)

REM Install dependencies if needed
if not exist node_modules (
  echo [INFO] Installing dependencies...
  call npm install
  if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Building...
call npm run build
if %errorlevel% neq 0 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo [OK] Alt Manager ready. Starting supervisor loop...
echo.

:loop
echo [%DATE% %TIME%] Starting bot...
node dist/index.js
echo [%DATE% %TIME%] Bot crashed/stopped. Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
