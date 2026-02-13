@echo off
color 0A
title Wicked Alt Manager - Run
echo.
echo ============================================
echo        Wicked Alt Manager - RUN
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
  echo [INFO] .env created. Edit it and add your DISCORD_TOKEN
  echo.
  pause
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

echo.
echo [OK] Starting Wicked Alt Manager...
echo.
call npm start
echo.
echo [INFO] Bot process ended. This window stays open so you can read logs/errors.
echo [TIP] Use run_forever.bat if you want automatic restart.
pause
