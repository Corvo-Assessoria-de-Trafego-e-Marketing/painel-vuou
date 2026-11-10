# Padrão de segurança da Corvo (para pessoas e IAs)

> Cópia do padrão comum. A fonte é `docs/SEGURANCA.md` no segundo cérebro (`CorvoAssessoriaOSorg`); atualize lá primeiro.

Este é o padrão comum de segurança para todo repositório da Corvo, seja documento,
sistema, painel ou tracking. Vale para quem programa e para qualquer IA (Claude
Code, Codex) que trabalhe aqui. Os `AGENTS.md` e `CLAUDE.md` dos repositórios
apontam para este arquivo.

## 1. Segredos

- Senha, token, chave de API e chave privada **nunca** entram no Git, nem
  temporariamente, nem em branch, nem em documentação. Apagar depois não resolve:
  o histórico guarda tudo.
- Credenciais ficam no cofre (`~/.corvo/credentials`) ou em `.env`/`.dev.vars`
  locais (ignorados pelo Git). Em produção, use os secrets da Cloudflare
  (`wrangler secret put`), do Supabase (Vault) ou do GitHub Actions.
- Todo commit passa pela checagem de segredos (`.githooks/checar-segredos.ps1`,
  regras em `.gitleaks.toml`). O sincronizador liga essa checagem sozinho; em
  outra máquina, rode uma vez `git config core.hooksPath .githooks`.
- **Nunca** use `git commit --no-verify` nem desligue o hook para "passar". Se a
  checagem acusar um falso positivo, fale com o responsável técnico.
- Se um segredo vazar (commit, print, mensagem, log público): **revogue e gere
  outro na hora** e avise o responsável técnico. Não basta apagar o arquivo.
- Tokens com o mínimo de poder: só leitura quando bastar, um por cliente, nunca
  de conta de administrador.

## 2. Dados pessoais (LGPD)

- Nome, e-mail, telefone, CPF, endereço, conversas e planilhas de leads ou
  pacientes **não** vão para o Git. Isso inclui transcrições e briefings com
  esses dados. Guarde no Drive com acesso restrito e deixe só o link.
- Nunca publique dados pessoais em repositório público, GitHub Pages, painel
  aberto ou log do Actions, nem "só por um tempo".
- Ao enviar para Meta, Google ou outra plataforma, mande e-mail e telefone com
  hash SHA-256, como os sistemas já fazem.
- Toda tabela com dados pessoais precisa de prazo de guarda definido.

## 3. Código de sistemas (Central, CRMs, trackings, painéis)

- **SQL:** sempre com parâmetros (`.prepare(...).bind(...)` no D1, filtros do
  supabase-js). Nome de coluna só de uma lista fixa. Nunca monte SQL com texto
  vindo do usuário.
- **HTML:** escape tudo que vem de fora (`esc()`/`h()`); nada de `innerHTML` com
  dado de lead, WhatsApp ou UTM.
- **APIs:** chave de acesso em cabeçalho, nunca na URL (`?key=`). Login pelo
  Cloudflare Access sempre que a tela for interna. Limite de tentativas nas
  rotas públicas.
- **Webhooks:** valide a assinatura da plataforma (HMAC da Meta, Kiwify e Eduzz;
  hottok da Hotmart) em tempo constante e recuse quando faltar.
- **Repasses** para RD Station, n8n e outros: só os campos esperados, com origem
  conferida. Nada de CORS `*` em rota que escreve.
- **Supabase:** RLS em toda tabela; a política confere se o usuário está ativo;
  função `SECURITY DEFINER` com `REVOKE EXECUTE ... FROM anon, authenticated`
  quando não for para o público. A chave `service_role` só em script
  do servidor, nunca no navegador.
- **Cabeçalhos:** todo site e Worker define CSP, `X-Frame-Options` (ou
  `frame-ancestors`), `X-Content-Type-Options` e `Referrer-Policy`. O modelo é o
  `crm-julia` (`_headers`).
- **Saída da IA não é confiável:** resposta de modelo não decide sozinha status
  de lead, conversão, pagamento ou permissão.
- **GitHub Actions:** `permissions:` mínimas no workflow, actions fixadas por
  SHA, nenhum segredo impresso no log.

## 4. Dependências, MCP e ferramentas

- Não adicione servidor MCP, pacote `npx -y` ou extensão sem revisar quem
  mantém, há quanto tempo existe e o que ele pode acessar. Servidores MCP de
  terceiros ficam na configuração pessoal de quem precisa, não no `.mcp.json` do
  repositório.
- Versão sempre fixa (`pacote@1.2.3`) e lockfile commitado.

## 5. Antes de publicar

Vale para push em repositório de sistema, deploy (Cloudflare, Supabase, Pages)
e mudança em painel:

1. Rode a skill **Crivo** sobre o que mudou. Só siga com veredito
   **PODE SUBIR**, ou com as ressalvas resolvidas.
2. Uma pessoa revisa e aprova. A IA não publica sozinha.
3. Nunca crie repositório público nem mude a visibilidade sem o owner.
4. Atualize o registro de sistemas, conforme o `AGENTS.md`.

## 6. Travas automáticas (harness)

As regras acima não dependem só de atenção. Cada repositório tem travas que
agem sozinhas:

| Trava | Quando age | O que faz |
|---|---|---|
| `.githooks/` e `.gitleaks.toml` | Em todo commit (pessoa, GitHub Desktop, IA, sincronizador) | Barra senha, token e chave, mostrando só valores mascarados. Avisa quando um arquivo, inclusive Word e Excel, traz lista de contatos (10 ou mais e-mails ou celulares) ou CPF; arquivo com dados fictícios pode ser liberado com a linha `corvo-dados: permitido`. |
| `.github/workflows/segredos.yml` | No GitHub, a cada push (repositórios de sistema) | Repete a checagem, para quem commitou sem o hook. |
| `.claude/settings.json` | Sempre que o Claude Code trabalha no repositório | Nega a leitura de `.env`, do cofre e de chaves; pede confirmação antes de a IA editar as próprias travas. |
| `.claude/hooks/guarda-comandos.ps1` | Antes de cada comando da IA no terminal | **Barra:** pular a checagem (`--no-verify`), ler segredos, push forçado, tornar repositório público, apagar repositório, rodar script baixado da internet. **Pede confirmação:** `git push`, deploy (Cloudflare, Supabase), merge de PR, mudança de secrets, `reset --hard`. **Testa:** roda `npm test` antes do commit, onde há testes. |
| `.claude/hooks/apos-edicao.ps1` | Depois de cada edição de código pela IA | Roda o ESLint do projeto no arquivo e devolve os erros para a IA corrigir. |

Se uma trava barrar algo legítimo, fale com o responsável técnico. Não contorne
a trava e não peça à IA para contornar.
