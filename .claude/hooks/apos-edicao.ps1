<#
    Lint depois da edicao (hook PostToolUse do Claude Code)
    -------------------------------------------------------
    Depois que a IA edita um arquivo .js/.jsx/.ts/.tsx, roda o ESLint do proprio
    projeto nesse arquivo e devolve os erros para a IA corrigir. Nao altera o arquivo.
    So age se o projeto tiver configuracao do ESLint e node_modules; senao, nao faz nada.
#>

$ErrorActionPreference = 'Stop'

try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $dados = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }

$arquivo = "$($dados.tool_input.file_path)"
if (-not $arquivo -or $arquivo -notmatch '\.(js|jsx|ts|tsx|mjs|cjs)$' -or -not (Test-Path -LiteralPath $arquivo)) { exit 0 }

# sobe a partir do arquivo ate achar o projeto (package.json com ESLint instalado)
$pasta = Split-Path -Parent $arquivo
$projeto = $null
for ($i = 0; $i -lt 8 -and $pasta; $i++) {
    if (Test-Path -LiteralPath (Join-Path $pasta 'package.json')) { $projeto = $pasta; break }
    $pasta = Split-Path -Parent $pasta
}
if (-not $projeto) { exit 0 }

$eslint = Join-Path $projeto 'node_modules\.bin\eslint.cmd'
$temConfig = @(Get-ChildItem -LiteralPath $projeto -Filter 'eslint.config.*' -File -ErrorAction SilentlyContinue).Count -gt 0
if (-not $temConfig -or -not (Test-Path -LiteralPath $eslint)) { exit 0 }

Push-Location $projeto
try {
    $ErrorActionPreference = 'Continue'
    $saida = & $eslint --no-warn-ignored $arquivo 2>&1 | ForEach-Object { "$_" }
    $codigo = $LASTEXITCODE
} finally { Pop-Location }

if ($codigo -eq 1) {
    [Console]::Error.WriteLine("ESLint apontou problemas em ${arquivo}:")
    [Console]::Error.WriteLine((($saida | Select-Object -Last 30) -join "`n"))
    exit 2
}
exit 0
