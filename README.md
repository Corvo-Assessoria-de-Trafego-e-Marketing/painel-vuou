# Painel Vuou · Meta + Google Ads

Dashboard estático de performance com **filtro de data livre**, que se atualiza sozinho de hora em hora.

```
index.html   →  lê  →  data.json        (GitHub Pages serve os dois)
                        ▲
                        │ commit automático a cada hora
              .github/workflows/update-data.yml
                        │
              scripts/fetch-meta.mjs  →  Meta Marketing API
```

Mesmo sistema de design e mesma engenharia do [painel Geoplas](https://brenofergon.github.io/painel-geoplas/) e do [painel Ricardo Mello](https://corvoassessoriatm.github.io/painel-ricardo-mello/).

---

## Campanhas do Meta: agrupadas pelo NOME (C1 · C2 · C3)

Na Vuou cada impulsionamento de post vira uma campanha nova no Meta, então uma lista fixa de IDs ficava velha em dias — em set/2026 três campanhas (duas ativas) gastavam fora do painel. Agora **não existe lista de IDs**: toda campanha da conta cujo nome traz `C1`, `C2` ou `C3` (`CRV-C1-…`, `CRV-C-C3-…`) entra sozinha no grupo, e o grupo soma as campanhas dele.

| Grupo | Métrica principal | Apoio |
|---|---|---|
| **C1** · tráfego / impulsionamentos | visitas ao perfil | seguidores, cliques no link |
| **C2** · vídeo | quem viu 50%+ | ThruPlay, hook rate, retenção 50% |
| **C3** · mensagens | conversas iniciadas | contatos por mensagem, conversas novas |

- **Campanha nova só aparece se o nome seguir o padrão.** Sem C1/C2/C3 no nome ela fica fora — e o log do Actions avisa quais ficaram.
- **Alcance de grupo:** alcance é gente única e não soma entre campanhas. Quando mais de uma campanha do grupo veiculou no período, o alcance do grupo aparece como — com a explicação; o da conta inteira continua valendo.
- Configuração dos grupos (rótulos e métricas): bloco `GROUPS` no topo de `scripts/fetch-meta.mjs`.

**Por que visitas ao perfil e não seguidores na C1?** Visitas é o que a Meta otimiza nos impulsionamentos e o que tem volume; seguidores ainda é pouco para significar algo. Quando a base crescer, é só trocar `kpi` e `kpi2` de lugar no grupo C1.

## Google Ads (aba "Google Ads")

Conta `784-306-6364`. Mesmo código do painel da Geoplas: `scripts/fetch-google.mjs` gera `data-google.json`.

- **G1** fixada pelo ID: `00-LEAD-CONTATO-WHATS-MADRID` (`24220495323`). **Todas as outras campanhas** com gasto desde `GOOGLE_SINCE` (ativas, pausadas, removidas) entram como G2, G3… — o total bate com o "Total: conta" do gerenciador.
- Seletor de campanha com busca (ativas com bolinha verde), palavras-chave, termos de pesquisa (clique numa palavra-chave filtra os termos), anúncios, grupos de recursos do PMax e o quadro "o que está contando como conversão".
- **Acesso:** o script descobre sozinho se entra direto na conta ou pela MCC `914-731-2925`.
- **Credenciais:** os mesmos 4 secrets da Geoplas — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_DEVELOPER_TOKEN`, `GOOGLE_REFRESH_TOKEN` — cadastrados **neste** repositório (secret de repositório não é compartilhado entre repositórios). Sem eles o passo do Google é pulado e o painel fica só com Meta.
- `node scripts/gerar-refresh-token.mjs` (no seu terminal, não pelo chat) testa o acesso à conta da Vuou antes de cadastrar.

## Alcance: por que ele não aparece em intervalo personalizado

Alcance é **gente única**. Quem vê o anúncio em três dias é uma pessoa, não três — então o alcance de um período **não é a soma dos dias**. Somar inflava o número em até 90% na visão "Tudo".

Por isso o painel busca na Meta o alcance real de **cada atalho de período** (último dia, 7, 30, 90 dias, este mês, tudo), por conta e por campanha, e guarda em `data.json` → `reach.windows`. Quando você escolhe um atalho, o número exibido é o oficial da Meta.

Em **intervalo de datas personalizado** o alcance aparece como **—**, porque calcular gente única num intervalo arbitrário exige uma nova consulta à API. Inventar uma estimativa ali seria pior que não mostrar. Todo o resto — investimento, impressões, cliques, resultados e o ranking de criativos — continua funcionando normalmente em qualquer intervalo.

A frequência (impressões ÷ alcance) segue a mesma regra.

## Filtro de período

- **Atalhos:** hoje, ontem, 7, 30, 90 dias, este mês, tudo. Igual aos gerenciadores: **7, 30 e 90 dias terminam ontem**; Hoje, Este mês e Tudo vão até hoje.
- **Data livre:** os dois campos de data aceitam qualquer intervalo dentro do histórico. KPIs, funil, gráfico e ranking de criativos recalculam juntos.

O recorte roda no navegador sobre as linhas diárias por anúncio guardadas em `data.json` — por isso qualquer intervalo funciona sem ida à API.

---

## Ligar a atualização automática (~10 min)

### 1) Token da Meta (System User — não expira)

Já existe um no `.env` do repositório da Corvo (chave `META_TOKEN`), com `ads_read` e `ads_management`. Se precisar gerar outro: **business.facebook.com → Configurações do Negócio → Usuários do sistema**, adicionar a conta **`Vuou - 01`** (ID `1337690884685109`) em *Ativos atribuídos*, e gerar token com os escopos `ads_read` e `read_insights`.

### 2) Guardar como secret

**Settings → Secrets and variables → Actions → New repository secret**

- `META_TOKEN` = _(o token)_
- *(Opcional)* `AD_ACCOUNT_ID` = `1337690884685109` — já é o padrão no script.
- *(Opcional, em **Variables**)* `SINCE` = `2026-08-24` — início do histórico.

Pela linha de comando, de dentro da pasta que tem o `.env`:

```bash
gh secret set META_TOKEN -R BrenoFergon/painel-vuou < <(grep '^META_TOKEN=' .env | cut -d= -f2-)
```

### 3) GitHub Pages

**Settings → Pages → Source: _Deploy from a branch_ → `main` / `/ (root)`.**

### Rodar agora

**Actions → Atualizar dados Meta Ads → Run workflow**, ou:

```bash
gh workflow run "Atualizar dados Meta Ads" -R BrenoFergon/painel-vuou
```

> Sem o secret, o painel continua funcionando com os dados semeados, mas **não se atualiza** — o job falha toda hora.

---

## Dados que já vêm no repositório

Histórico real puxado da Meta e **conferido contra os agregados oficiais**: no recorte 24/08 → 26/08 o investimento bate centavo a centavo (R$ 42,71), assim como impressões, cliques, visitas ao perfil e seguidores.

- **7 linhas** diárias por anúncio · **2 anúncios** · **24/08/2026 → 27/08/2026**
- As **capas dos criativos** já vêm em `thumbs/`, em 160 px (teto sem token). O `data.json` marca `thumbs_lowres: true`; na primeira rodada do Actions o script baixa tudo de novo em 400 px.

## Ajustes rápidos

- **Frequência:** `cron` em `.github/workflows/update-data.yml`.
- **Grupos do Meta e KPI de cada um:** bloco `GROUPS` em `scripts/fetch-meta.mjs` (as campanhas entram pelo nome).
- **Campanha do Google fixada:** bloco `PLAN` em `scripts/fetch-google.mjs`.
- **Visual e textos:** `index.html`.

## Rodar local

```bash
npx serve .
```

`file://` não funciona — o navegador bloqueia a leitura do `data.json`.

---

**Corvo Assessoria de Tráfego e Marketing** · conta `1337690884685109`
