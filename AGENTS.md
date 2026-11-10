# Orientação para IAs e pessoas: painel-vuou

Este repositório guarda o painel de Google Ads da Vuou. Este arquivo vale para o Claude Code
(via `CLAUDE.md`), o Codex e qualquer pessoa que trabalhe aqui.

- Não publique, não altere contas, não envie mensagens e não use credenciais
  sem pedido explícito e escopo confirmado.

## Segurança (obrigatório)

O padrão completo está em `docs/SEGURANCA.md` (cópia do padrão comum da Corvo;
a fonte fica no segundo cérebro, em `docs/SEGURANCA.md`). O essencial:

- **Segredos:** nunca escreva senha, token ou chave em arquivo versionado, nem
  em documentação ou exemplo. Leia do cofre (`~/.corvo/credentials`), de `.env`
  ou `.dev.vars` locais, ou dos secrets da Cloudflare, do Supabase ou do GitHub.
  Se encontrar um segredo no repositório, não o use: avise quem pediu a tarefa.
- **Checagem de commit:** rode uma vez neste clone
  `git config core.hooksPath .githooks`. Todo commit passa por
  `.githooks/checar-segredos.ps1`, e o GitHub repete a checagem no workflow
  "Checagem de segredos". Nunca use `--no-verify` nem desligue o hook.
- **Dados pessoais:** não grave no repositório nome, e-mail, telefone, CPF,
  conversas ou planilhas de leads, pacientes e clientes. Nunca publique esses
  dados em repositório público, Pages, painel aberto ou log.
- **Código:** SQL com parâmetros, HTML escapado, chave fora da URL, assinatura
  validada em webhook, RLS no Supabase e cabeçalhos de segurança.
- **Ferramentas:** não adicione servidor MCP, pacote `npx -y` ou dependência
  nova sem a revisão de uma pessoa. Versão sempre fixa.
- **Antes de publicar** (push que publica, deploy): passe a mudança pelo
  **Crivo** (skill do segundo cérebro, `.claude/skills/Crivo`; se não estiver
  disponível aqui, peça uma revisão de segurança do diff) e só publique com
  veredito **PODE SUBIR** e a aprovação de uma pessoa. Nunca crie repositório
  público nem mude a visibilidade de um.

## Regras deste repositório

- **Este repositório é PÚBLICO.** Código, dados, histórico e logs do Actions
  ficam visíveis para qualquer pessoa. Nunca coloque aqui dado pessoal, planilha,
  print de conta ou qualquer informação do cliente que não possa ser pública.
- O workflow `update-data.yml` roda de hora em hora com os secrets do Google Ads.
  Nunca imprima token no log; use permissões mínimas e actions fixadas por SHA.
  O token do Google deve ser só de leitura e só desta conta.
- Os commits automáticos de dados (`data*.json`, `thumbs/`) não passam pelo hook;
  a checagem do GitHub (`segredos.yml`) cobre o resto.
