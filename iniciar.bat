@echo off
setlocal enabledelayedexpansion
rem ---------------------------------------------------------------------------
rem  iniciar.bat - abre o launcher com dois cliques.
rem
rem  Existe porque "npm start" exige abrir um terminal na pasta certa, e o
rem  launcher e pra ser usado, nao desenvolvido. Instala as dependencias na
rem  primeira vez e depois so abre.
rem
rem  Sem acentos de proposito: o console do Windows usa outra tabela de
rem  caracteres e as mensagens sairiam ilegiveis.
rem
rem  Escrito com "goto" em vez de blocos "if ( ... )" porque a pasta pode ter
rem  parenteses no nome - por exemplo "leveling-launcher-main(1)", o nome que o
rem  navegador da ao segundo download do zip. Dentro de um bloco, o ")" do
rem  caminho fecha o bloco antes da hora e o script quebra.
rem ---------------------------------------------------------------------------

rem A pasta deste arquivo, nao a de onde o atalho foi chamado.
set "RAIZ=%~dp0"
cd /d "%RAIZ%" 2>nul
if not errorlevel 1 goto raiz_ok
echo.
echo  Nao consegui entrar na pasta do launcher:
echo    !RAIZ!
echo.
echo  Se o projeto esta num caminho de rede, copie para o disco local.
echo.
pause
exit /b 1
:raiz_ok

set "ELECTRON=node_modules\electron\dist\electron.exe"

rem Pega as atualizacoes antes de abrir. Falha de rede, repositorio ausente ou
rem alteracao local nao impedem o launcher de subir: segue com o que ja existe.
where git >nul 2>&1
if errorlevel 1 goto sem_git
if not exist ".git" goto sem_git
echo.
echo  Buscando atualizacoes.
call git pull --ff-only
if not errorlevel 1 goto sem_git
echo.
echo  Nao atualizei. Seguindo com a versao que esta na pasta.
echo.
:sem_git

where node >nul 2>&1
if not errorlevel 1 goto tem_node
echo.
echo  Node.js nao encontrado.
echo  Instale em https://nodejs.org e abra este arquivo de novo.
echo.
pause
exit /b 1
:tem_node

rem Primeira vez: baixa o Electron e o resto. Demora alguns minutos.
if exist "%ELECTRON%" goto tem_electron
echo.
echo  Primeira execucao: instalando dependencias. Isso pode demorar.
echo.
call npm install
if not errorlevel 1 goto instalou
echo.
echo  O "npm install" terminou com erro. Veja as mensagens acima.
echo  Causa comum: sem internet, ou proxy / antivirus da empresa bloqueando.
echo.
:instalou

rem Quem instalou antes do postinstall entrar no package.json ficou com o
rem Electron sem o programa dentro. Baixar na hora e mais rapido que explicar.
if exist "%ELECTRON%" goto tem_electron
if not exist "node_modules\electron\install.js" goto tem_electron
echo.
echo  Baixando o programa do Electron.
echo.
call node node_modules\electron\install.js
:tem_electron

rem Conferir de novo, e nao so antes de instalar. O "npm install" pode terminar
rem sem erro e mesmo assim nao deixar o binario no lugar: o Electron baixa num
rem passo separado, que antivirus, proxy e firewall de empresa costumam cortar.
rem Sem esta conferencia o script mandava o Windows abrir um .exe inexistente, e
rem o usuario via so uma caixa de "nao pode encontrar", sem dica do motivo.
if exist "%ELECTRON%" goto abrir
echo.
echo  As dependencias nao ficaram completas: falta o programa do Electron em
echo    !CD!\!ELECTRON!
echo.
echo  O Electron baixa num passo a parte do "npm install", que antivirus,
echo  proxy ou firewall de empresa costumam bloquear.
echo.
echo  Para tentar de novo:
echo.
echo    1. Abra o Prompt de Comando nesta pasta
echo    2. Rode:  npm install
echo    3. Depois:  node node_modules\electron\install.js
echo    4. Leia o que aparecer: o erro do download fica no fim
echo.
pause
exit /b 1

:abrir
rem Chama o Electron direto, em vez de "npm start", para que esta janela de
rem console feche na hora em vez de ficar aberta atras do launcher.
start "Leveling Launcher" "%CD%\%ELECTRON%" "%CD%"
exit /b 0
