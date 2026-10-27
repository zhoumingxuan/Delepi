@echo off
REM 用途：在 Windows 上一键启动 Delepi 自动更新服务端（监听 0.0.0.0:8080）。
REM 使用前请先安装依赖：python -m pip install -r requirements.txt
chcp 65001 >nul
cd /d "%~dp0"
python -m uvicorn app:app --host 0.0.0.0 --port 8080
