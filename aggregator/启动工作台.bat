@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  个人工作台 · 信息聚合服务 —— 一键启动
rem  双击这个文件就行：它会自动检查 Python 和依赖，
rem  启动服务后自动打开浏览器。不需要记端口和命令。
rem
rem  服务地址固定为 http://127.0.0.1:8787/
rem  想换端口：设置环境变量 AGG_PORT，或直接改 main.py 里的 PORT。
rem  想停止：在这个黑窗口里按 Ctrl + C。
rem ============================================================

cd /d "%~dp0"

echo.
echo   个人工作台 · 信息聚合服务
echo   ========================================
echo.

rem ---- 1. 找 Python ----
set "PY="
where python >nul 2>nul
if %errorlevel%==0 set "PY=python"
if not defined PY (
  where py >nul 2>nul
  if %errorlevel%==0 set "PY=py"
)
if not defined PY (
  echo   [错误] 没有找到 Python。
  echo.
  echo   请先安装 Python 3.10 或以上版本：
  echo     https://www.python.org/downloads/
  echo   安装时记得勾选 "Add Python to PATH"。
  echo.
  pause
  exit /b 1
)
echo   Python: %PY%
%PY% --version

rem ---- 2. 检查依赖，缺了就装 ----
echo.
echo   正在检查依赖...
%PY% -c "import requests, feedparser, parsel, fastapi, uvicorn, cryptography" >nul 2>nul
if %errorlevel%==0 (
  echo   依赖已就绪。
) else (
  echo   首次运行，正在安装依赖（大约需要一两分钟，取决于网速）...
  echo.
  %PY% -m pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/
  if errorlevel 1 (
    echo.
    echo   阿里云镜像没装上，改用官方源再试一次...
    %PY% -m pip install -r requirements.txt
  )
  %PY% -c "import requests, feedparser, parsel, fastapi, uvicorn, cryptography" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败。请手动执行：
    echo     python -m pip install -r requirements.txt
    echo.
    pause
    exit /b 1
  )
  echo   依赖安装完成。
)

rem ---- 3. 启动 ----
echo.
echo   正在启动服务，浏览器会自动打开...
echo   服务地址： http://127.0.0.1:8787/
echo   （停止服务：在这个窗口按 Ctrl + C）
echo.
%PY% main.py

echo.
echo   服务已停止。
pause
