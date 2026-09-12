@echo off
cd /d E:\CODE\CangKu\fangcun
start "" /B pythonw tegula.exe serve > nul 2>&1
ping -n 3 127.0.0.1 > nul
start "" "http://127.0.0.1:8753/startpage"