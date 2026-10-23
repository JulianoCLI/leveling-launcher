@echo off
rem ---------------------------------------------------------------------------
rem  iniciar.bat - abre o launcher com dois cliques.
rem
rem  Existe porque "npm start" exige abrir um terminal na pasta certa, e o
rem  launcher e pra ser usado, nao desenvolvido. Instala as dependencias na
rem  primeira vez e depois so abre.
rem
rem  Sem acentos de proposito: o console do Windows usa outra tabela de
rem  caracteres e as mensagens sairiam ilegiveis.
rem ---------------------------------------------------------------------------

rem A pasta deste arquivo, nao a de onde o atalho foi chamado.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Node.js nao encontrado.
  echo  Instale em https://nodejs.org e abra este arquivo de novo.
  echo.
  pause
  exit /b 1
)

rem Primeira vez: baixa o Electron e o resto. Demora alguns minutos.
if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo  Primeira execucao: instalando dependencias. Isso pode demorar.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  A instalacao falhou. Verifique a conexao e tente de novo.
    echo.
    pause
    exit /b 1
  )
)

rem Chama o Electron direto, em vez de "npm start", para que esta janela de
rem console feche na hora em vez de ficar aberta atras do launcher.
start "Leveling Launcher" "node_modules\electron\dist\electron.exe" .
exit /b 0
