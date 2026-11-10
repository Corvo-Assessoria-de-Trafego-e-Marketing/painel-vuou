<#
    Checagem de segredos da Corvo
    -----------------------------
    Procura senhas, tokens e chaves nos arquivos que estao PREPARADOS para o
    proximo commit (git add). Nunca mostra o valor inteiro: so o comeco, mascarado.

    Quem chama:
      - o hook de commit (.githooks/pre-commit), em qualquer commit feito a mao,
        pelo GitHub Desktop ou por uma IA;
      - o sincronizador (sync-corvo.ps1), com -Remover, antes do commit automatico.

    Uso:
      .\checar-segredos.ps1            # so confere; sai com 1 se achar algo
      .\checar-segredos.ps1 -Remover   # tira do commit os arquivos com segredo
      .\checar-segredos.ps1 -Quieto    # sem texto quando estiver tudo certo

    Saida: 0 = nada encontrado; 1 = encontrou segredo; 2 = erro ao rodar.

    Se o gitleaks estiver instalado (winget install Gitleaks.Gitleaks), ele roda
    junto, com as regras de .gitleaks.toml. Sem ele, as regras abaixo continuam
    valendo. Para liberar um falso positivo, fale com o responsavel tecnico:
    nao use "git commit --no-verify".
#>

[CmdletBinding()]
param(
    [switch]$Remover,
    [switch]$Quieto
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$LimiteBytes = 2MB

# Dados pessoais (LGPD). 'avisar' so alerta; 'barrar' trata como segredo (o arquivo nao sobe).
# Fica em 'avisar' ate os dados pessoais que ja estao no repositorio irem para o lugar certo.
$ModoDadosPessoais = 'avisar'
$LimiteContatos = 10    # e-mails ou telefones distintos num mesmo arquivo; um CPF valido ja conta

# ------------------------------------------------------------------
# regras
# ------------------------------------------------------------------

# Arquivos que nunca devem ir para o Git, mesmo forcados com "git add -f".
$NomesProibidos = @(
    '(^|/)\.env$',
    '(^|/)\.env\.(?!example$|exemplo$|sample$|modelo$)[^/]+$',
    '(^|/)[^/]+\.env$',
    '(^|/)\.dev\.vars$',
    '\.(pem|p12|pfx|key|jks|keystore)$',
    '(^|/)id_(rsa|ed25519|ecdsa|dsa)$',
    '(^|/)(credentials|service[-_]?account)[^/]*\.json$',
    '(^|/)client_secret[^/]*\.json$'
)

# Padroes de segredo dentro do conteudo. A IA da Corvo trabalha com estes servicos.
$Regras = @(
    @{ Nome = 'Token do GitHub';                 Padrao = '\b(gh[pousr]_[A-Za-z0-9]{36,})' },
    @{ Nome = 'Token do GitHub (fine-grained)';  Padrao = '\b(github_pat_[A-Za-z0-9_]{60,})' },
    @{ Nome = 'Token da Meta (Facebook)';        Padrao = '(?<![A-Za-z0-9+/])(EAA[A-Za-z0-9]{60,400})(?![A-Za-z0-9+/=])' },
    @{ Nome = 'Refresh token do Google';         Padrao = '(?<![A-Za-z0-9])(1//0[A-Za-z0-9_\-]{30,})' },
    @{ Nome = 'Access token do Google';          Padrao = '\b(ya29\.[A-Za-z0-9_\-]{30,})' },
    @{ Nome = 'Segredo OAuth do Google';         Padrao = '\b(GOCSPX-[A-Za-z0-9_\-]{20,})' },
    @{ Nome = 'Chave privada';                   Padrao = '(-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----)' },
    @{ Nome = 'Chave da AWS';                    Padrao = '\b((?:AKIA|ASIA)[0-9A-Z]{16})\b' },
    @{ Nome = 'Chave secreta do Stripe';         Padrao = '\b((?:sk|rk)_live_[0-9A-Za-z]{20,})' },
    @{ Nome = 'Token do Slack';                  Padrao = '\b(xox[abposr]-[0-9A-Za-z\-]{10,})' },
    @{ Nome = 'Chave da Anthropic';              Padrao = '\b(sk-ant-[A-Za-z0-9_\-]{20,})' },
    @{ Nome = 'Chave da OpenAI';                 Padrao = '\b(sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{40,})' },
    @{ Nome = 'Chave secreta do Supabase';       Padrao = '\b(sb_secret_[A-Za-z0-9_\-]{20,})' },
    @{ Nome = 'Token da Cloudflare (cfut/cfat)'; Padrao = '\b(cf[ua]t_[A-Za-z0-9_\-]{30,})' },
    @{ Nome = 'URL com senha embutida';          Padrao = '\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)://[^:\s/@]+:[^@\s/]{6,}@)' }
)

# JWT: so bloqueia se for chave de servico (service_role do Supabase).
# Chave "anon" do Supabase e publica por desenho e nao bloqueia.
$PadraoJwt = '\b(eyJ[A-Za-z0-9_\-]{10,}\.(eyJ[A-Za-z0-9_\-]{10,})\.[A-Za-z0-9_\-]{10,})'

# Dados pessoais: lista de contatos (muitos e-mails ou celulares) ou CPF valido.
# Para liberar um arquivo revisado (ex.: dados ficticios), escreva nele: corvo-dados: permitido
$PadraoEmail = '[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+'
$EmailGenerico = '(?i)^(contato|suporte|atendimento|comercial|vendas|financeiro|noreply|no-reply|sac|privacidade|dpo|admin|hello|info|example|exemplo|teste|test|user|usuario|email|seu-?email|nome)@|@(example|exemplo|email|dominio|domain|test|teste|sentry|users\.noreply\.github)\.'
$PadraoFone = '(?<![\d.,/-])(?:\+?55[\s.-]?)?\(?[1-9]\d\)?[\s.-]?9\d{4}[\s.-]?\d{4}(?![\d.,/-])'
$PadraoCpf = '(?<![\d.])(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})(?![\d.-])'
$PastasDeExemplo = '(^|/)(node_modules|sample-data|fixtures|__fixtures__|testdata|test-data)/'

# ------------------------------------------------------------------
# utilidades
# ------------------------------------------------------------------

function Texto-Office {
    # Extrai o texto de um .docx ou .xlsx (documento, cabecalhos, rodapes, celulas).
    # Devolve $null se o arquivo nao for um ZIP valido.
    param([byte[]]$Bytes)
    try {
        Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
        $ms = New-Object System.IO.MemoryStream(, $Bytes)
        $zip = New-Object System.IO.Compression.ZipArchive($ms, [System.IO.Compression.ZipArchiveMode]::Read)
        $sb = New-Object System.Text.StringBuilder
        foreach ($e in $zip.Entries) {
            if ($e.FullName -match '^(word/(document|header\d*|footer\d*|footnotes|comments)\.xml|xl/sharedStrings\.xml|xl/worksheets/sheet\d+\.xml)$') {
                $leitor = New-Object System.IO.StreamReader($e.Open(), [System.Text.Encoding]::UTF8)
                $xml = $leitor.ReadToEnd(); $leitor.Close()
                # cada paragrafo, linha ou celula vira uma linha; o resto das tags vira espaco
                $xml = $xml -replace '</(w:p|row|si)>', "`n" -replace '<[^>]+>', ' '
                [void]$sb.Append([System.Net.WebUtility]::HtmlDecode($xml)).Append("`n")
            }
        }
        $zip.Dispose()
        return $sb.ToString()
    } catch { return $null }
}

function Cpf-Valido {
    param([string]$Digitos)
    if ($Digitos.Length -ne 11 -or ($Digitos.ToCharArray() | Sort-Object -Unique).Count -eq 1) { return $false }
    $n = $Digitos.ToCharArray() | ForEach-Object { [int]"$_" }
    foreach ($t in 9, 10) {
        $soma = 0
        for ($i = 0; $i -lt $t; $i++) { $soma += $n[$i] * ($t + 1 - $i) }
        if ((($soma * 10) % 11) % 10 -ne $n[$t]) { return $false }
    }
    return $true
}

function Git-Bytes {
    # Roda o git e devolve a saida como bytes (sem conversao de texto).
    param([string[]]$Argumentos)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'git'
    $psi.Arguments = ($Argumentos | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $ms = New-Object System.IO.MemoryStream
    $p.StandardOutput.BaseStream.CopyTo($ms)
    [void]$p.StandardError.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { return $null }
    return ,$ms.ToArray()
}

function Mascarar {
    param([string]$Valor)
    if ($Valor.Length -le 8) { return ('*' * $Valor.Length) }
    return $Valor.Substring(0, [Math]::Min(6, [int]($Valor.Length / 4))) + '****' + " ($($Valor.Length) caracteres)"
}

function Parece-Exemplo {
    # Evita bloquear documentacao com valores de exemplo (ghp_xxxx..., EAAAAAA...).
    param([string]$Valor)
    $distintos = ($Valor.ToCharArray() | Sort-Object -Unique).Count
    if ($distintos -lt 10) { return $true }
    if ($Valor -match '(?i)(x{6,}|exemplo|example|placeholder|seu_?token|your_?token|0123456789|abcdefgh)') { return $true }
    return $false
}

function Base64Url-Texto {
    param([string]$Parte)
    $s = $Parte.Replace('-', '+').Replace('_', '/')
    switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
    try { return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) } catch { return '' }
}

# ------------------------------------------------------------------
# arquivos preparados para o commit
# ------------------------------------------------------------------

$raizBytes = Git-Bytes @('rev-parse', '--show-toplevel')
if ($null -eq $raizBytes) {
    Write-Host 'checar-segredos: esta pasta nao e um repositorio Git.' -ForegroundColor Red
    exit 2
}
$Raiz = [System.Text.Encoding]::UTF8.GetString($raizBytes).Trim()

$listaBytes = Git-Bytes @('-c', 'core.quotepath=off', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT')
if ($null -eq $listaBytes) {
    Write-Host 'checar-segredos: nao consegui listar os arquivos preparados.' -ForegroundColor Red
    exit 2
}
$arquivos = @([System.Text.Encoding]::UTF8.GetString($listaBytes).Split([char]0) | Where-Object { $_ })

# Ao fechar uma juncao de versoes (ex.: conflito resolvido pelo sincronizador), o que veio
# igual do servidor ja esta no GitHub, e barrar aqui so travaria a maquina. Nesse caso,
# confere apenas o que tambem difere da versao do servidor: trabalho local e copias de conflito.
$emJuncao = $false
if ($null -ne (Git-Bytes @('rev-parse', '-q', '--verify', 'MERGE_HEAD'))) {
    $difBytes = Git-Bytes @('-c', 'core.quotepath=off', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRT', 'MERGE_HEAD')
    if ($null -ne $difBytes) {
        $emJuncao = $true
        $locais = @{}
        foreach ($n in [System.Text.Encoding]::UTF8.GetString($difBytes).Split([char]0)) { if ($n) { $locais[$n] = $true } }
        $arquivos = @($arquivos | Where-Object { $locais.ContainsKey($_) })
    }
}

$achados = New-Object System.Collections.ArrayList
$dadosPessoais = New-Object System.Collections.ArrayList

foreach ($arq in $arquivos) {
    foreach ($p in $NomesProibidos) {
        if ($arq -match $p) {
            [void]$achados.Add([pscustomobject]@{ Arquivo = $arq; Linha = '-'; Regra = 'Arquivo de segredo (nao vai para o Git)'; Trecho = '' })
            break
        }
    }

    $bytes = Git-Bytes @('cat-file', 'blob', ":$arq")
    if ($null -eq $bytes -or $bytes.Length -eq 0 -or $bytes.Length -gt $LimiteBytes) { continue }
    if ($arq -match '\.(docx|xlsx)$') {
        # Word e Excel sao ZIP: le o texto de dentro, em memoria, sem gravar nada em disco
        $texto = Texto-Office $bytes
        if ($null -eq $texto) { continue }
    } else {
        $amostra = [Math]::Min($bytes.Length, 8000)
        if ([Array]::IndexOf($bytes, [byte]0, 0, $amostra) -ge 0) { continue }   # binario
        $texto = [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    $linhas = $texto -split "`n"

    if ($arq -notmatch $PastasDeExemplo -and $texto -notmatch 'corvo-dados:\s*permitido') {
        $emails = @{}; $fones = @{}; $cpfs = @{}
        foreach ($m in [regex]::Matches($texto, $PadraoEmail)) {
            if ($m.Value -notmatch $EmailGenerico) { $emails[$m.Value.ToLower()] = 1 }
        }
        foreach ($m in [regex]::Matches($texto, $PadraoFone)) {
            $d = $m.Value -replace '\D', ''
            if ($d.Length -gt 11) { $d = $d.Substring($d.Length - 11) }
            $fones[$d] = 1
        }
        foreach ($m in [regex]::Matches($texto, $PadraoCpf)) {
            $d = $m.Groups[1].Value + $m.Groups[2].Value + $m.Groups[3].Value + $m.Groups[4].Value
            if (Cpf-Valido $d) { $cpfs[$d] = 1 }
        }
        if ($emails.Count -ge $LimiteContatos -or $fones.Count -ge $LimiteContatos -or $cpfs.Count -ge 1) {
            [void]$dadosPessoais.Add([pscustomobject]@{ Arquivo = $arq; Emails = $emails.Count; Fones = $fones.Count; Cpfs = $cpfs.Count })
        }
    }

    for ($i = 0; $i -lt $linhas.Count; $i++) {
        $linha = $linhas[$i]
        if ($linha.Length -lt 20) { continue }
        if ($linha -match 'corvo-segredo:\s*permitido') { continue }   # liberacao pontual revisada

        foreach ($r in $Regras) {
            foreach ($m in [regex]::Matches($linha, $r.Padrao)) {
                $v = $m.Groups[1].Value
                if ($r.Nome -ne 'Chave privada' -and $r.Nome -ne 'URL com senha embutida' -and (Parece-Exemplo $v)) { continue }
                [void]$achados.Add([pscustomobject]@{ Arquivo = $arq; Linha = $i + 1; Regra = $r.Nome; Trecho = (Mascarar $v) })
            }
        }

        foreach ($m in [regex]::Matches($linha, $PadraoJwt)) {
            $carga = Base64Url-Texto $m.Groups[2].Value
            if ($carga -match '"role"\s*:\s*"service_role"') {
                [void]$achados.Add([pscustomobject]@{ Arquivo = $arq; Linha = $i + 1; Regra = 'Chave service_role do Supabase'; Trecho = (Mascarar $m.Groups[1].Value) })
            }
        }
    }
}

# ------------------------------------------------------------------
# gitleaks, se estiver instalado
# ------------------------------------------------------------------

$gitleaks = Get-Command gitleaks -ErrorAction SilentlyContinue
if ($gitleaks -and $arquivos.Count -gt 0) {
    $relatorio = [System.IO.Path]::GetTempFileName()
    try {
        $cfg = Join-Path $Raiz '.gitleaks.toml'
        $argsGl = @('git', '--staged', '--redact', '--no-banner', '--exit-code', '0', '--log-level', 'error',
                    '--report-format', 'json', '--report-path', $relatorio)
        if (Test-Path -LiteralPath $cfg) { $argsGl += @('--config', $cfg) }
        Push-Location $Raiz
        try { & $gitleaks.Source @argsGl 2>$null | Out-Null } finally { Pop-Location }
        $json = Get-Content -LiteralPath $relatorio -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        if ($json) {
            foreach ($f in (ConvertFrom-Json $json)) {
                if ($emJuncao -and ($arquivos -notcontains $f.File)) { continue }
                $ja = $achados | Where-Object { $_.Arquivo -eq $f.File -and "$($_.Linha)" -eq "$($f.StartLine)" }
                if (-not $ja) {
                    [void]$achados.Add([pscustomobject]@{ Arquivo = $f.File; Linha = $f.StartLine; Regra = "gitleaks: $($f.RuleID)"; Trecho = '(mascarado)' })
                }
            }
        }
    } catch {
        Write-Host "checar-segredos: o gitleaks falhou ($($_.Exception.Message)); segui so com as regras internas." -ForegroundColor Yellow
    } finally {
        Remove-Item -LiteralPath $relatorio -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------------
# resultado
# ------------------------------------------------------------------

if ($dadosPessoais.Count -gt 0) {
    if ($ModoDadosPessoais -eq 'barrar') {
        foreach ($d in $dadosPessoais) {
            [void]$achados.Add([pscustomobject]@{ Arquivo = $d.Arquivo; Linha = '-'; Regra = 'Dados pessoais (LGPD)'
                Trecho = ("{0} e-mails, {1} telefones, {2} CPF" -f $d.Emails, $d.Fones, $d.Cpfs) })
        }
    } else {
        Write-Host ''
        Write-Host '=== ATENCAO: DADOS PESSOAIS NO COMMIT (LGPD) ===' -ForegroundColor Yellow
        foreach ($d in $dadosPessoais) {
            Write-Host ("  dados pessoais: {0}  ({1} e-mails, {2} telefones, {3} CPF)" -f $d.Arquivo, $d.Emails, $d.Fones, $d.Cpfs) -ForegroundColor Yellow
        }
        Write-Host 'Lista de contatos e CPF de clientes, leads ou pacientes nao devem ficar no Git: todo o time'
        Write-Host 'recebe uma copia e o historico guarda para sempre. Guarde no Drive restrito ou na Central e'
        Write-Host 'deixe aqui so o link. Por enquanto e so um aviso; o commit segue. Regras: docs/SEGURANCA.md'
    }
}

if ($achados.Count -eq 0) {
    if (-not $Quieto) { Write-Host "checar-segredos: nenhum segredo nos $($arquivos.Count) arquivo(s) preparados." -ForegroundColor Green }
    exit 0
}

Write-Host ''
Write-Host '=== POSSIVEL SEGREDO NO COMMIT ===' -ForegroundColor Red
foreach ($a in $achados) {
    Write-Host ("  {0}:{1}  {2}  {3}" -f $a.Arquivo, $a.Linha, $a.Regra, $a.Trecho) -ForegroundColor Red
}
Write-Host ''
Write-Host 'Senha, token e chave nao vao para o GitHub. Guarde no cofre (~/.corvo/credentials)'
Write-Host 'ou num arquivo .env (ja ignorado) e leia de la. Se for falso positivo, fale com o'
Write-Host 'responsavel tecnico. Nao use --no-verify.'

if ($Remover) {
    foreach ($arq in ($achados | Select-Object -ExpandProperty Arquivo -Unique)) {
        [void](Git-Bytes @('reset', '-q', '--', $arq))
        Write-Host "  tirado do commit: $arq" -ForegroundColor Yellow
    }
}

exit 1
