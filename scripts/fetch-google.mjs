// fetch-google.mjs — puxa a Google Ads API e reescreve ../data-google.json
// Rodado pelo GitHub Actions. Node 20+ (fetch global).
// Env obrigatórias (secrets): GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID,
//                             GOOGLE_CLIENT_SECRET, GOOGLE_DEVELOPER_TOKEN
// Env opcionais: GOOGLE_CUSTOMER_ID, GOOGLE_LOGIN_CUSTOMER_ID, GOOGLE_SINCE, GOOGLE_API_VER

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// secrets colados no GitHub costumam trazer espaço/quebra de linha invisível
// no fim — o Google recusa ("OAuth client was not found"). Limpa antes de usar.
const env = k => (process.env[k] || "").trim();

const REFRESH  = env("GOOGLE_REFRESH_TOKEN");
const CLIENT   = env("GOOGLE_CLIENT_ID");
const SECRET   = env("GOOGLE_CLIENT_SECRET");
const DEV_TOK  = env("GOOGLE_DEVELOPER_TOKEN");
const CUSTOMER = (process.env.GOOGLE_CUSTOMER_ID || "7843066364").replace(/-/g, "");
const CLIENTE  = "Vuou";
// Por onde o usuário do token enxerga a conta: direto, ou por uma MCC.
// Padrão "auto": tenta direto e, se o Google recusar, pela MCC 914-731-2925
// (a MCC do Victor, dona do developer token). O script antigo da Vuou usava essa MCC.
// Para forçar: GOOGLE_LOGIN_CUSTOMER_ID = "none" (direto) ou o ID da MCC.
const MCC_RAW  = (process.env.GOOGLE_LOGIN_CUSTOMER_ID || "auto").trim();
const MCC_CANDIDATAS = /^auto$/i.test(MCC_RAW) ? ["", "9147312925"]
  : /^(none|direto)$/i.test(MCC_RAW) ? [""] : [MCC_RAW.replace(/-/g, "")];
let MCC = null;   // definida por descobrirAcesso()
const SINCE    = process.env.GOOGLE_SINCE || "2026-08-24";
const API_VER  = process.env.GOOGLE_API_VER || "v25";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT  = join(ROOT, "data-google.json");

/* ── campanhas monitoradas ───────────────────────────────────────────────
   Para trocar/adicionar campanha: edite este bloco. Com `id` preenchido o
   vínculo é pelo ID da campanha — o nome pode mudar à vontade no Google.
   `match` (nome) é só referência legível, usado apenas quando `id` é null
   (maiúsculas, acentos, travessões e espaços extras são ignorados).       */
const PLAN = [
  { match: "00-LEAD-CONTATO-WHATS-MADRID", id: "24220495323",
    key: "G1", tag: "G1",
    label: "Pesquisa · Lead WhatsApp Madrid",
    goal: "Gerar contatos no WhatsApp de quem pesquisa passagens para Madrid." },
];

/* ── API ─────────────────────────────────────────────────────────────── */
async function getAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", client_id: CLIENT,
      client_secret: SECRET, refresh_token: REFRESH,
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`OAuth: ${j.error_description || j.error}`);
  return j.access_token;
}

let TOKEN = null;
/* googleAds:search pagina de 10.000 em 10.000 via nextPageToken.
   (pageSize não é mais aceito nas versões atuais da API.)
   Devolve as linhas no formato aninhado da API: r.campaign.id, r.metrics.clicks… */
async function gaql(query) {
  const url = `https://googleads.googleapis.com/${API_VER}/customers/${CUSTOMER}/googleAds:search`;
  const headers = {
    "Authorization": `Bearer ${TOKEN}`,
    "developer-token": DEV_TOK,
    "Content-Type": "application/json",
  };
  if (MCC) headers["login-customer-id"] = MCC;
  let out = [], pageToken = null, guard = 0;
  do {
    const body = { query: query.replace(/\s+/g, " ").trim() };
    if (pageToken) body.pageToken = pageToken;
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch { throw new Error(`HTTP ${r.status}: ${txt.slice(0, 300)}`); }
    if (j.error) {
      const det = j.error.details?.[0]?.errors?.[0];
      throw new Error(`GAQL: ${det?.message || j.error.message}${det?.errorCode ? " " + JSON.stringify(det.errorCode) : ""}`);
    }
    out = out.concat(j.results || []);
    pageToken = j.nextPageToken || null;
  } while (pageToken && guard++ < 100);
  return out;
}

/* testa cada caminho de acesso (direto / MCC) com uma consulta mínima e fica com o primeiro que funciona */
async function descobrirAcesso() {
  const erros = [];
  for (const cand of MCC_CANDIDATAS) {
    MCC = cand;
    try { await gaql("SELECT customer.id FROM customer LIMIT 1");
      console.log(`    acesso à conta ${CUSTOMER}: ${cand ? "via MCC " + cand : "direto"}`); return; }
    catch (e) { erros.push(`${cand ? "via MCC " + cand : "direto"}: ${e.message}`); }
  }
  throw new Error("sem acesso à conta " + CUSTOMER + " — " + erros.join(" | "));
}

/* relatório secundário: se falhar, registra o aviso e segue sem ele */
const WARN = [];
async function optional(nome, fn, vazio = []) {
  try { return await fn(); }
  catch (e) { WARN.push(`${nome}: ${e.message}`); console.warn(`    aviso: ${nome} falhou — ${e.message}`); return vazio; }
}

/* ── helpers ─────────────────────────────────────────────────────────── */
// 4 casas: arredondar cada dia a centavos e depois somar desviava ~R$0,03 em
// 30 dias do total do gerenciador (que soma os micros antes de arredondar)
const money = micros => +(Number(micros || 0) / 1e6).toFixed(4);
const int   = v => Number(v || 0);
const dec   = v => +Number(v || 0).toFixed(2);   // conversões podem ser fracionadas (atribuição por dados)
const norm  = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // sem acento
  .replace(/[\u2010-\u2015\u2212]/g, "-")                                        // travessões viram hífen
  .replace(/\s+/g, " ").replace(/\s*([\[\]\-])\s*/g, "$1").toUpperCase().trim(); // espaço em volta de [ ] - não conta
const met   = m => ({ s: money(m?.costMicros), i: int(m?.impressions), ck: int(m?.clicks), cv: dec(m?.conversions), vl: dec(m?.conversionsValue) });
/* termo de pesquisa só entra se teve clique, custo ou conversão. Termos que só
   apareceram na tela eram ~90% das linhas (3,6 MB no PMax de um cliente) sem
   nenhum gasto — não servem para negativar e deixavam o painel lento. */
const TERMO_UTIL = r => r.ck || r.cv || r.s;
/* grava só o que não é zero — deixa o JSON enxuto */
const lean  = o => { for (const k of Object.keys(o)) if (o[k] === 0 || o[k] == null) delete o[k]; return o; };

/* ── main ────────────────────────────────────────────────────────────── */
async function main() {
  if (!REFRESH || !CLIENT || !SECRET || !DEV_TOK) {
    throw new Error("defina os secrets GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_DEVELOPER_TOKEN");
  }
  // confere o FORMATO de cada secret (sem imprimir o valor) — pega secret trocado de campo
  const forma = [
    ["GOOGLE_CLIENT_ID", CLIENT.endsWith(".apps.googleusercontent.com"), "deveria terminar em .apps.googleusercontent.com"],
    ["GOOGLE_CLIENT_SECRET", !SECRET.includes(".apps.googleusercontent.com"), "parece ser o Client ID, não a chave secreta"],
    ["GOOGLE_REFRESH_TOKEN", REFRESH.startsWith("1//"), "deveria começar com 1//"],
  ].filter(([, ok]) => !ok);
  if (forma.length) throw new Error("secret com formato estranho: " + forma.map(([k, , why]) => `${k} (${why})`).join("; "));
  TOKEN = await getAccessToken();
  await descobrirAcesso();
  const until = new Date().toISOString().slice(0, 10);
  const RANGE = `segments.date BETWEEN '${SINCE}' AND '${until}'`;

  // 1) todas as campanhas da conta — inclusive pausadas e removidas, porque o
  //    "Total: conta" do gerenciador também soma o que elas gastaram
  const allCamps = await gaql(`
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign_budget.amount_micros
    FROM campaign`);
  const campById = Object.fromEntries(allCamps.map(r => [String(r.campaign.id), r]));

  // 2) diário por campanha, conta inteira — base de KPIs, tendência e filtro de data
  const dRows = await gaql(`
    SELECT segments.date, campaign.id, metrics.cost_micros, metrics.impressions,
           metrics.clicks, metrics.conversions, metrics.conversions_value
    FROM campaign WHERE ${RANGE}`);
  const daily = dRows
    .map(r => lean({ d: r.segments.date, c: String(r.campaign.id), ...met(r.metrics) }))
    .filter(r => r.i || r.s)
    .sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
  if (!daily.length) throw new Error("nenhuma linha com dados — confira GOOGLE_CUSTOMER_ID, a MCC e o período");
  const comDados = new Set(daily.map(r => r.c));

  // campanhas fixadas no PLAN (G1, G2…) + todas as outras que veicularam no período,
  // numeradas G3, G4… por ordem de ID (estável entre execuções: campanha nova tem ID maior)
  const fixadas = PLAN.map(p => {
    const r = p.id ? campById[String(p.id)] : allCamps.find(x => norm(x.campaign.name) === norm(p.match));
    if (!r) console.warn(`    aviso: campanha do PLAN não encontrada: ${p.tag} ${p.id || p.match}`);
    return r ? { p, r } : null;
  }).filter(Boolean);
  const idsFixados = new Set(fixadas.map(x => String(x.r.campaign.id)));
  const extras = [...comDados].filter(id => !idsFixados.has(id) && campById[id])
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  let n = PLAN.length;
  const TIPO = { SEARCH: "Pesquisa", PERFORMANCE_MAX: "Performance Max", DISPLAY: "Display", VIDEO: "Vídeo",
    DEMAND_GEN: "Geração de demanda", SHOPPING: "Shopping", MULTI_CHANNEL: "App", LOCAL: "Local", SMART: "Inteligente" };
  const todas = fixadas.concat(extras.map(id => {
    const r = campById[id], tag = `G${++n}`;
    const st = r.campaign.status === "ENABLED" ? "ativa" : r.campaign.status === "PAUSED" ? "pausada" : "removida";
    return { r, p: { key: tag, tag,
      label: `${TIPO[r.campaign.advertisingChannelType] || r.campaign.advertisingChannelType} · ${r.campaign.name}`,
      goal: `Campanha ${st} — entra no painel para o total bater com o gerenciador.` } };
  }));

  const campaigns = todas.map(({ p, r }) => ({
    id: String(r.campaign.id), key: p.key, tag: p.tag,
    name: r.campaign.name, label: p.label, goal: p.goal,
    type: r.campaign.advertisingChannelType,          // SEARCH | PERFORMANCE_MAX | DISPLAY | …
    status: r.campaign.status,                          // ENABLED | PAUSED | REMOVED
    daily_budget: r.campaignBudget?.amountMicros ? money(r.campaignBudget.amountMicros) : null,
  }));
  const IDS = campaigns.map(c => c.id);
  const IN  = `campaign.id IN (${IDS.join(",")})`;
  // linha diária de campanha que não entrou na lista (não deveria existir) sai do total
  for (let i = daily.length - 1; i >= 0; i--) if (!IDS.includes(daily[i].c)) daily.splice(i, 1);
  const isType = t => campaigns.filter(c => c.type === t).map(c => c.id);
  const SEARCH = isType("SEARCH"), PMAX = isType("PERFORMANCE_MAX");
  // anúncios (ad_group_ad) existem em todo tipo menos PMax
  const COM_ANUNCIO = campaigns.filter(c => c.type !== "PERFORMANCE_MAX").map(c => c.id);

  // 3) o que é uma "conversão" — quebra por ação de conversão
  const conv_actions = await optional("conversões por ação", async () => (await gaql(`
      SELECT segments.date, campaign.id, segments.conversion_action_name, metrics.conversions
      FROM campaign WHERE ${IN} AND ${RANGE} AND metrics.conversions > 0`))
    .map(r => ({ d: r.segments.date, c: String(r.campaign.id), n: r.segments.conversionActionName, cv: dec(r.metrics.conversions) })));

  // 4) anúncios (todo tipo menos PMax) · palavras-chave e termos (só Pesquisa)
  let ads = [], ad_daily = [], keywords = [], kw_daily = [], search_terms = [];
  if (COM_ANUNCIO.length) {
    const adRows = await optional("anúncios", () => gaql(`
      SELECT segments.date, campaign.id, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name,
             ad_group_ad.status, ad_group_ad.ad.type, ad_group_ad.ad.responsive_search_ad.headlines,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM ad_group_ad WHERE campaign.id IN (${COM_ANUNCIO.join(",")}) AND ${RANGE}`));
    const adMeta = {};
    for (const r of adRows) {
      const id = String(r.adGroupAd.ad.id);
      const hl = r.adGroupAd.ad.responsiveSearchAd?.headlines || [];
      adMeta[id] ||= { id, c: String(r.campaign.id), ag: String(r.adGroup.id), agn: r.adGroup.name,
        title: hl.slice(0, 3).map(h => h.text).join(" | ") || r.adGroupAd.ad.name || `Anúncio ${id.slice(-5)}`,
        status: r.adGroupAd.status };
      const row = lean({ d: r.segments.date, a: id, c: String(r.campaign.id), ...met(r.metrics) });
      if (row.i || row.s) ad_daily.push(row);
    }
    ads = Object.values(adMeta).filter(a => ad_daily.some(r => r.a === a.id));
  }
  if (SEARCH.length) {
    const INS = `campaign.id IN (${SEARCH.join(",")})`;
    const kwRows = await optional("palavras-chave", () => gaql(`
      SELECT segments.date, campaign.id, ad_group.id, ad_group.name, ad_group_criterion.criterion_id,
             ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM keyword_view WHERE ${INS} AND ${RANGE}`));
    const kwMeta = {};
    for (const r of kwRows) {
      const k = `${r.adGroup.id}~${r.adGroupCriterion.criterionId}`;
      kwMeta[k] ||= { id: k, c: String(r.campaign.id), agn: r.adGroup.name,
        kw: r.adGroupCriterion.keyword.text, mt: r.adGroupCriterion.keyword.matchType, status: r.adGroupCriterion.status };
      const row = lean({ d: r.segments.date, k, c: String(r.campaign.id), ...met(r.metrics) });
      if (row.i || row.s) kw_daily.push(row);
    }
    keywords = Object.values(kwMeta).filter(k => kw_daily.some(r => r.k === k.id));

    search_terms = await optional("termos de pesquisa (Search)", async () => (await gaql(`
        SELECT segments.date, campaign.id, search_term_view.search_term, search_term_view.status,
               segments.keyword.info.text,
               metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
        FROM search_term_view WHERE ${INS} AND ${RANGE}`))
      .map(r => lean({ d: r.segments.date, c: String(r.campaign.id), t: r.searchTermView.searchTerm,
        kw: r.segments.keyword?.info?.text, st: r.searchTermView.status === "NONE" ? null : r.searchTermView.status,
        ...met(r.metrics) }))
      .filter(TERMO_UTIL));
  }

  // 5) PMax — grupos de recursos e termos de pesquisa
  //    PMax não tem ad_group / ad_group_ad: a unidade é o asset_group.
  let asset_groups = [], ag_daily = [], pmax_terms_daily = true;
  if (PMAX.length) {
    const INP = `campaign.id IN (${PMAX.join(",")})`;
    const agRows = await optional("grupos de recursos (PMax)", () => gaql(`
      SELECT segments.date, campaign.id, asset_group.id, asset_group.name, asset_group.status,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM asset_group WHERE ${INP} AND ${RANGE}`));
    const agMeta = {};
    for (const r of agRows) {
      const id = String(r.assetGroup.id);
      agMeta[id] ||= { id, c: String(r.campaign.id), name: r.assetGroup.name, status: r.assetGroup.status };
      const row = lean({ d: r.segments.date, g: id, c: String(r.campaign.id), ...met(r.metrics) });
      if (row.i || row.s) ag_daily.push(row);
    }
    asset_groups = Object.values(agMeta).filter(g => ag_daily.some(r => r.g === g.id));

    // Termos do PMax: tenta por dia (permite filtro de data). Se a API recusar
    // a segmentação diária, cai para o total do período e o painel avisa.
    const Q = (withDate) => `
      SELECT ${withDate ? "segments.date, " : ""}campaign.id, campaign_search_term_view.search_term,
             metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
      FROM campaign_search_term_view WHERE ${INP} AND ${RANGE}`;
    const mapT = r => lean({ d: r.segments?.date || null, c: String(r.campaign.id),
      t: r.campaignSearchTermView.searchTerm, ...met(r.metrics) });
    let pt = null;
    try { pt = (await gaql(Q(true))).map(mapT); }
    catch (e) {
      console.warn(`    aviso: termos PMax sem segmentação diária (${e.message}) — tentando total do período`);
      pmax_terms_daily = false;
      pt = await optional("termos de pesquisa (PMax)", async () => (await gaql(Q(false))).map(mapT));
    }
    search_terms = search_terms.concat(pt.filter(TERMO_UTIL));
  }

  const dates = daily.map(r => r.d);
  const data = {
    meta: {
      source: "google",
      account_id: CUSTOMER,
      account_label: CUSTOMER.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3"),
      client: CLIENTE,
      login_customer_id: MCC || null,
      currency: "BRL",
      tz: "America/Sao_Paulo",
      api_version: API_VER,
      updated_at: new Date().toISOString(),
      since: SINCE,
      first_date: dates[0],
      last_date: dates[dates.length - 1],
      pmax_terms_daily,
      warnings: WARN,
    },
    campaigns, daily, conv_actions,
    ads, ad_daily, keywords, kw_daily,
    asset_groups, ag_daily, search_terms,
  };
  writeFileSync(OUT, JSON.stringify(data) + "\n");

  console.log(`OK  Google Ads ${data.meta.account_label}  ${data.meta.first_date} → ${data.meta.last_date}  (API ${API_VER})`);
  for (const c of campaigns) {
    const rs = daily.filter(r => r.c === c.id);
    const s = rs.reduce((a, r) => a + (r.s || 0), 0), cv = rs.reduce((a, r) => a + (r.cv || 0), 0);
    console.log(`    ${c.tag} ${c.id} ${c.type.padEnd(16)} R$${s.toFixed(2).padStart(9)}  conversões: ${cv.toFixed(1)}  ${c.name}`);
  }
  console.log(`    anúncios=${ads.length}  palavras-chave=${keywords.length}  grupos PMax=${asset_groups.length}  linhas de termos=${search_terms.length}`);
  if (WARN.length) console.warn(`AVISO: ${WARN.length} relatório(s) secundário(s) falharam — o painel mostra o resto normalmente.`);
}

main().catch(e => { console.error("FALHA:", e.message); process.exit(1); });
