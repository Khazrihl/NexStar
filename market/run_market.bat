@echo off
echo Starting NexStar Market Terminal...
echo.

REM Check Python exists where expected
if not exist "python\python.exe" (
    echo ERROR: python\python.exe not found.
    echo Make sure your Python folder is in the same directory as this bat file.
    pause
    exit /b 1
)

REM Check proxy script exists
if not exist "nl_market_proxy.py" (
    echo ERROR: nl_market_proxy.py not found.
    echo Make sure all NexStar files are in the same folder as this bat file.
    pause
    exit /b 1
)

REM Start the proxy in a new window so it stays running
start "NexStar Market Proxy" cmd /k python\python.exe nl_market_proxy.py

REM Give the proxy a moment to start
timeout /t 2 /nobreak >nul

REM Open the market viewer in the default browser
start nexus-market-viewer.html

echo Market proxy running. Close the proxy window to stop.
