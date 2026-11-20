@echo off
cd /d "%~dp0"
call npm run build:prices
if errorlevel 1 (echo PRICE UPDATE FAILED & pause & exit /b 1)
call npm run pack:bundle
if errorlevel 1 (echo PACK/PUBLISH FAILED - retry publishing with: npm run release:publish & pause & exit /b 1)
echo Now commit kit-build.json, changelog-builds.json, docs\changelog.html (and changelog-grammars.json if changed), then push to origin.
pause