@echo off
color 09
title Wicked Alt Manager - Update
echo.
echo ============================================
echo   Wicked Alt Manager - Update Dependencies
echo ============================================
echo.

echo [INFO] Updating npm packages...
call npm update

echo [INFO] Building...
call npm run build
if %errorlevel% neq 0 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo [OK] Update complete. Restart your bot to apply changes.
echo.
pause
