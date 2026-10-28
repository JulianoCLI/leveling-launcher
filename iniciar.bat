@echo off
setlocal
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
cd /d "%~dp0" 2>nul
if errorlevel 1 (
  echo.
  echo  Nao consegui entrar na pasta do launcher:
  echo    %~dp0
  echo.
  echo  Se o projeto esta num caminho de rede, copie para o disco local.
  echo.
  pause
  exit /b 1
)

set "ELECTRON=node_modules\electron\dist\electron.exe"

rem Pega as atualizacoes antes de abrir. Falha de rede, repositorio ausente ou
rem alteracao local nao impedem o launcher de subir: segue com o que ja existe.
where git >nul 2>&1
if not errorlevel 1 (
  if exist ".git" (
    echo.
    echo  Buscando atualizacoes.
    call git pull --ff-only
    if errorlevel 1 (
      echo.
      echo  Nao atualizei. Seguindo com a versao que esta na pasta.
      echo.
    )
  )
)

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
if not exist "%ELECTRON%" (
  echo.
  echo  Primeira execucao: instalando dependencias. Isso pode demorar.
  echo.
  call npm install
)

rem Quem instalou antes do postinstall entrar no package.json ficou com o
rem Electron sem o programa dentro. Baixar na hora e mais rapido que explicar.
if not exist "%ELECTRON%" (
  if exist "node_modules\electron\install.js" (
    echo.
    echo  Baixando o programa do Electron.
    echo.
    call node node_modules\electron\install.js
  )
)

rem Conferir de novo, e nao so antes de instalar. O "npm install" pode terminar
rem sem erro e mesmo assim nao deixar o binario no lugar: o Electron baixa num
rem passo separado, que antivirus, proxy e firewall de empresa costumam cortar.
rem Sem esta conferencia o script mandava o Windows abrir um .exe inexistente, e
rem o usuario via so uma caixa de "nao pode encontrar", sem dica do motivo.
if not exist "%ELECTRON%" (
  echo.
  echo  As dependencias nao ficaram completas: falta o programa do Electron em
  echo    %CD%\%ELECTRON%
  echo.
  echo  O Electron baixa num passo a parte do "npm install", que antivirus,
  echo  proxy ou firewall de empresa costumam bloquear.
  echo.
  echo  Para tentar de novo:
  echo.
  echo    1. Abra o Prompt de Comando nesta pasta
  echo    2. Rode:  node node_modules\electron\install.js
  echo    3. Leia o que aparecer: o erro do download fica no fim
  echo.
  pause
  exit /b 1
)

rem Chama o Electron direto, em vez de "npm start", para que esta janela de
rem console feche na hora em vez de ficar aberta atras do launcher.
start "Leveling Launcher" "%CD%\%ELECTRON%" "%CD%"
exit /b 0
