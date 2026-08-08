@echo off
title FERRO - Iniciando servidor
cd /d "C:\Users\Ruber_Lu\Documents\Sistem_de_Gestao_de_Academia"

echo Iniciando o servidor do FERRO...
echo (esta janela pode ser fechada depois que o navegador abrir)
echo.

start "FERRO - Servidor" cmd /k "npm run dev"

timeout /t 6 /nobreak >nul
start "" "http://localhost:5173"

exit
