@echo off
chcp 65001 >nul
cd /d C:\competitor
echo [1/3] 폴더에서 최신 커뮤니티 엑셀을 대시보드 데이터로 변환...
powershell -ExecutionPolicy Bypass -File scripts\import-community.ps1
echo [2/3] 변경사항 커밋...
git add public/data/community.json
git commit -m "community data update"
echo [3/3] 배포(푸시)...
git pull origin main --no-edit
git push
echo.
echo 완료! 1~2분 후 대시보드 새로고침 버튼을 누르면 반영됩니다.
pause
