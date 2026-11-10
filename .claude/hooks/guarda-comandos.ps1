<#
    Guarda de comandos da Corvo (hook PreToolUse do Claude Code)
    ------------------------------------------------------------
    Roda antes de todo comando que a IA manda para o terminal (ferramentas Bash e
    PowerShell). Recebe em stdin o JSON do Claude Code e decide:

      BARRA (saida 2)      o que nunca deve ser feito pela IA: pular a checagem de
                           segredos, ler senhas, forcar push, tornar repositorio publico,
                           rodar script baixado da internet, apagar a raiz do disco.
      PEDE CONFIRMACAO     o que publica ou e dificil de desfazer: git push, deploy
                           (Cloudflare, Supabase), merge de PR, mudar secrets, reset --hard.
      TESTA                antes de "git commit", roda "npm test" se o projeto tiver testes.

    E uma checagem por texto: cobre os casos comuns, nao e infalivel. A barreira
    principal contra segredos continua sendo o hook do Git (.githooks/).
    Regras e motivos: docs/SEGURANCA.md. Para mudar algo aqui, fale com o responsavel tecnico.

    Teste manual:
      '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' |
          powershell -NoProfile -ExecutionPolicy Bypass -File .claude\hooks\guarda-comandos.ps1
#>

$ErrorActionPreference = 'Stop'

try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try {
    $bruto = [Console]::In.ReadToEnd()
    $dados = $bruto | ConvertFrom-Json
} catch { exit 0 }

$cmd = "$($dados.tool_input.command)"
if (-not $cmd.Trim()) { exit 0 }

function Barrar([string]$motivo) {
    [Console]::Error.WriteLine("COMANDO BARRADO pelo harness de seguranca da Corvo: $motivo")
    [Console]::Error.WriteLine('Nao tente contornar. Se for mesmo necessario, explique o motivo a pessoa e peca que ela rode fora da IA. Regras: docs/SEGURANCA.md')
    exit 2
}

function Perguntar([string]$motivo) {
    $saida = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'ask'; permissionDecisionReason = "Harness da Corvo: $motivo" } }
    [Console]::Out.WriteLine(($saida | ConvertTo-Json -Compress -Depth 5))
    exit 0
}

# ------------------------------------------------------------------
# 1. nunca: pular ou desligar a checagem de segredos
# ------------------------------------------------------------------

if ($cmd -match '\bgit\b[^|;&]*\b(commit|push|merge)\b[^|;&]*--no-verify') {
    Barrar '--no-verify pula a checagem de segredos do commit.'
}
if ($cmd -match 'core\.hookspath' -and $cmd -notmatch 'core\.hookspath[=\s]+["'']?\.githooks["'']?(\s|$)' -and $cmd -notmatch 'config\s+(--get\s+)?core\.hookspath\s*$') {
    Barrar 'mudar core.hooksPath desliga a checagem de segredos deste repositorio.'
}

# ------------------------------------------------------------------
# 2. nunca: ler ou copiar senhas, tokens e chaves
# ------------------------------------------------------------------

$arqSegredo = '(?<![\w.-])(?!process\.env|meta\.env)(\.env(\.(local|production|development|prod|dev|staging))?|[\w-]+\.env|\.dev\.vars(\.[\w-]+)?)(?![\w.-])'
$cofre = '(\.corvo[\\/]+credentials|[\\/]\.ssh[\\/]|\.aws[\\/]+credentials|(?<![\w-])id_(rsa|ed25519|ecdsa)(?!\.pub)(?![\w-])|\.(pem|pfx|p12)(?![\w.-]))'
$leitores = '(?<![\w-])(cat|type|more|less|head|tail|bat|nl|strings|xxd|od|base64|gc|get-content|select-string|sls|grep|egrep|rg|findstr|awk|sed|source|import-csv)(?![\w-])'
$copiadores = '(?<![\w-])(cp|copy|copy-item|mv|move|move-item|scp|rsync|curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|compress-archive|zip|tar)(?![\w-])'

if ($cmd -match "$leitores[^|;&\r\n]*($arqSegredo|$cofre)") {
    Barrar 'esse comando mostra o conteudo de um arquivo de senhas, tokens ou chaves. A IA nao le segredos; use o nome da variavel, nao o valor.'
}
if ($cmd -match "(open|readfile\w*|readalltext|read_text|readlines|loadtxt)\W{0,3}[`"'][^`"']*($arqSegredo|$cofre)") {
    Barrar 'esse comando le um arquivo de senhas, tokens ou chaves por script.'
}
if ($cmd -match "$copiadores[^|;&\r\n]*$cofre") {
    Barrar 'esse comando copia ou envia o cofre de credenciais ou uma chave privada.'
}

# ------------------------------------------------------------------
# 3. nunca: reescrever historico remoto, expor ou apagar repositorio
# ------------------------------------------------------------------

if ($cmd -match '\bgit\b[^|;&]*\bpush\b' ) {
    $forcado = ($cmd -match '\bpush\b[^|;&]*\s(--force|-f)(\s|$)') -or ($cmd -match '\bpush\b[^|;&]*\s\+[\w./-]+')
    $comLease = $cmd -match '--force-with-lease'
    if ($forcado -or ($comLease -and $cmd -match '(\s|:|/)(main|master)(\s|$)')) {
        Barrar 'push forcado sobrescreve o historico no GitHub e pode apagar o trabalho do time.'
    }
}
if ($cmd -match '\bgh\s+repo\s+delete\b') { Barrar 'a IA nao apaga repositorios.' }
if ($cmd -match '\bgh\s+repo\s+create\b[^|;&]*--public' -or $cmd -match '\bgh\s+repo\s+edit\b[^|;&]*--visibility[=\s]+public') {
    Barrar 'a IA nao cria repositorio publico nem torna um repositorio publico. Isso e decisao do owner.'
}

# ------------------------------------------------------------------
# 4. nunca: rodar script baixado da internet sem revisar; apagar a raiz
# ------------------------------------------------------------------

if ($cmd -match '\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|node)\b' -or
    $cmd -match '\b(irm|iwr|invoke-restmethod|invoke-webrequest)\b[^|]*\|\s*(iex|invoke-expression)\b' -or
    $cmd -match '\b(iex|invoke-expression)\b[^|;&]*(irm|iwr|invoke-restmethod|invoke-webrequest|downloadstring)') {
    Barrar 'baixa um script da internet e executa direto, sem ninguem revisar o conteudo.'
}
if ($cmd -match '\brm\s+(-[a-z]*r[a-z]*\s+)+(-[a-z]+\s+)*["'']?(/|~|~/|\$HOME|[a-z]:[\\/]?|/[a-z]/?)["'']?(\s|$)' -or
    $cmd -match '\b(remove-item|rmdir|rd|del)\b[^|;&]*\s["'']?([a-z]:[\\/]?|~|\$HOME|\$env:USERPROFILE)["'']?(\s+-|\s*$)') {
    Barrar 'apaga a raiz do disco ou a pasta do usuario.'
}

# ------------------------------------------------------------------
# 5. testes antes do commit (onde o projeto tem testes)
# ------------------------------------------------------------------

if ($cmd -match '\bgit\b[^|;&]*\bcommit\b' -and $cmd -notmatch '--help|--dry-run') {
    foreach ($pasta in @("$($dados.cwd)", "$env:CLAUDE_PROJECT_DIR") | Where-Object { $_ } | Select-Object -Unique) {
        $pkg = Join-Path $pasta 'package.json'
        if (-not (Test-Path -LiteralPath $pkg)) { continue }
        $teste = ''
        try { $teste = "$((Get-Content -LiteralPath $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).scripts.test)" } catch { }
        if (-not $teste -or $teste -match 'no test specified') { break }
        if (-not (Test-Path -LiteralPath (Join-Path $pasta 'node_modules'))) {
            [Console]::Error.WriteLine('Aviso do harness: este projeto tem testes, mas node_modules nao existe. Rode "npm ci" e "npm test" antes de publicar.')
            break
        }
        Push-Location $pasta
        try {
            $ErrorActionPreference = 'Continue'
            $saidaTeste = & cmd.exe /d /c 'npm test 2>&1' | ForEach-Object { "$_" }
            $codigo = $LASTEXITCODE
        } finally { Pop-Location; $ErrorActionPreference = 'Stop' }
        if ($codigo -ne 0) {
            [Console]::Error.WriteLine(($saidaTeste | Select-Object -Last 40) -join "`n")
            Barrar 'os testes falharam (npm test). Corrija antes de commitar.'
        }
        break
    }
}

# ------------------------------------------------------------------
# 6. pede confirmacao de uma pessoa: publicar e acoes dificeis de desfazer
# ------------------------------------------------------------------

if ($cmd -match '\bgit\b[^|;&]*\bpush\b') {
    Perguntar 'git push envia para o GitHub (em repositorio de sistema, push na main publica). Passou pelo Crivo e alguem aprovou?'
}
if ($cmd -match '\bwrangler(@\S+)?\s+(pages\s+)?(deploy|publish)\b' -or $cmd -match '\bnpm\s+run\s+\S*deploy' -or
    $cmd -match '\bsupabase\s+(db\s+(push|reset)|functions\s+deploy|migration\s+repair)\b') {
    Perguntar 'esse comando publica em producao (Cloudflare ou Supabase). Passou pelo Crivo e alguem aprovou?'
}
if ($cmd -match '\bwrangler(@\S+)?\s+(secret\s+(put|delete|bulk)|d1\s+(execute|migrations\s+apply)[^|;&]*--remote|r2\s+object\s+(put|delete)|kv\s+\S+\s+(put|delete))' -or
    $cmd -match '\bsupabase\s+secrets\s+(set|unset)\b' -or $cmd -match '\bgh\s+secret\s+(set|delete|remove)\b') {
    Perguntar 'esse comando altera segredos ou dados de producao.'
}
if ($cmd -match '\bgh\s+(pr\s+merge|workflow\s+(run|enable|disable)|release\s+create|repo\s+(create|edit|rename|archive))\b' -or
    $cmd -match '\bgh\s+api\b[^|;&]*(-X|--method)\s*(DELETE|PATCH|PUT|POST)') {
    Perguntar 'esse comando altera o repositorio ou a organizacao no GitHub.'
}
if ($cmd -match '\bgit\b[^|;&]*\b(reset\s+--hard|clean\s+-[a-z]*f|filter-repo|filter-branch)\b') {
    Perguntar 'esse comando descarta trabalho local ou reescreve historico.'
}

exit 0
