// fetch-meta.mjs — puxa a Meta Marketing API e reescreve ../data.json
// Rodado pelo GitHub Actions. Node 20+ (fetch global).
// Env: META_TOKEN (obrigatória) · AD_ACCOUNT_ID, SINCE (opcionais)

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOKEN   = process.env.META_TOKEN;
const ACCOUNT = process.env.AD_ACCOUNT_ID || "1337690884685109";
const SINCE   = process.env.SINCE || "2026-08-24";
const API     = "https://graph.facebook.com/v21.0";

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT      = join(ROOT, "data.json");
const THUMBDIR = join(ROOT, "thumbs");

if (!TOKEN) { console.error("ERRO: defina o secret META_TOKEN."); process.exit(1); }

/* ── campanhas monitoradas: GRUPOS pelo nome ─────────────────────────────
   Na Vuou cada impulsionamento de post cria uma campanha nova, então uma lista
   fixa de IDs fica velha em dias. Em vez disso, toda campanha da conta cujo
   NOME traz C1, C2 ou C3 (ex.: CRV-C1-…, CRV-C-C3-…) entra sozinha no grupo.
   Os números do grupo são a soma das campanhas dele. `kpi` é a chave da
   métrica principal dentro de cada linha diária.                           */
const GROUPS = [
  { key: "C1", tag: "C1",
    label: "Tráfego · Visitas ao Perfil e Seguidores",
    goal: "Levar público novo ao perfil da Vuou e converter em seguidor.",
    kpi: "res", kpi_label: "Visitas ao perfil", kpi_unit: "visita",
    kpi2: "fol", kpi2_label: "Seguidores",      kpi2_unit: "seguidor" },
  { key: "C2", tag: "C2",
    label: "Engajamento · Visualização de Vídeo (milhas)",
    goal: "Fazer os vídeos educativos de milhas serem assistidos — meta principal: quem vê pelo menos 50%.",
    kpi: "p50", kpi_label: "Viram 50%+ do vídeo", kpi_unit: "visualização 50%",
    kpi2: "tp", kpi2_label: "ThruPlay", kpi2_unit: "ThruPlay" },
  { key: "C3", tag: "C3",
    label: "Mensagens · Conversas Iniciadas",
    goal: "Transformar interesse em conversa no direct/WhatsApp.",
    kpi: "conv", kpi_label: "Conversas iniciadas", kpi_unit: "conversa",
    kpi2: "conn", kpi2_label: "Contatos por mensagem", kpi2_unit: "contato" },
];
// "CRV-C1-…", "CRV-C-C3-…", "C2 - …": C + dígito isolado por - _ espaço ou borda
const grupoDoNome = nome => { const m = String(nome || "").match(/(?:^|[-_s])C([123])(?=[-_s]|$)/i); return m ? "C" + m[1] : null; };
let CAMP2GROUP = {};   // id da campanha → key do grupo (montado no main)
let WATCHED = [];      // ids de todas as campanhas agrupadas

/* ── helpers ─────────────────────────────────────────────────────────── */
async function getAll(path, params) {
  const url = new URL(`${API}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("access_token", TOKEN);
  if (!params.limit) url.searchParams.set("limit", "500");
  let out = [], next = url.toString(), guard = 0;
  while (next && guard++ < 200) {
    const r = await fetch(next);
    const j = await r.json();
    if (j.error) throw new Error(`${path}: ${j.error.message}`);
    out = out.concat(j.data || []);
    next = j.paging?.next || null;
  }
  return out;
}

const num = v => (v == null ? 0 : Math.round(parseFloat(v) || 0));
const sumArr = a => Array.isArray(a) ? a.reduce((s, x) => s + num(x.value), 0) : num(a);

/* soma TODOS os action_types que casam com a lista (evita perder variações
   de nome que a Meta troca de tempos em tempos) */
function pick(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const t of types) {
    const hit = actions.find(a => a.action_type === t);
    if (hit) return num(hit.value);
  }
  return 0;
}

// ATENÇÃO: seguidores e visitas ao perfil NÃO aparecem no array `actions`.
// São campos próprios. E cuidado: `instagram_profile_follow_v2` (nome usado pelo
// MCP) é aceito pela API crua e devolvido VAZIO, sem erro — foi o que zerou os
// seguidores na primeira execução. O nome correto aqui é sem o _v2.
const IF = [
  "ad_id", "ad_name", "campaign_id", "adset_id", "spend", "impressions", "reach", "clicks",
  "actions", "instagram_profile_follow", "instagram_profile_visits",
  "video_thruplay_watched_actions", "video_p25_watched_actions",
  "video_p50_watched_actions", "video_p75_watched_actions", "video_p100_watched_actions",
  "video_play_actions",
].join(",");

/* mapeia uma linha da API para o formato compacto do painel */
function toRow(r) {
  const a = r.actions || [];
  const o = {
    d: r.date_start,
    a: r.ad_id,
    c: CAMP2GROUP[r.campaign_id],   // o painel trabalha por grupo (C1/C2/C3)
    oc: r.campaign_id,               // campanha de origem, para conferência
    s: +(+r.spend).toFixed(2),
    i: num(r.impressions),
    rc: num(r.reach),
    ck: num(r.clicks),
  };

  // resultado nativo da campanha (o que a Meta chama de "resultado")
  const visits = num(r.instagram_profile_visits)
    || pick(a, ["onsite_conversion.ig_profile_visit", "profile_visit_view"]);
  const follows = num(r.instagram_profile_follow)
    || pick(a, ["onsite_conversion.follow", "onsite_conversion.ig_profile_follow", "follow"]);
  const lc = pick(a, ["link_click"]);

  const tp   = sumArr(r.video_thruplay_watched_actions);
  const p50  = sumArr(r.video_p50_watched_actions);
  const p75  = sumArr(r.video_p75_watched_actions);
  const p100 = sumArr(r.video_p100_watched_actions);
  const pl   = sumArr(r.video_play_actions);
  // visualizações de 3 segundos — base do hook rate (v3 ÷ impressões) e da
  // retenção 50% (p50 ÷ v3). Na API crua é o action_type "video_view".
  const v3   = pick(a, ["video_view"]);

  // resultado padrão por objetivo da campanha
  const plan = GROUPS.find(g => g.key === CAMP2GROUP[r.campaign_id]);
  o.res = plan?.key === "C2" ? tp : visits;

  if (follows) o.fol = follows;
  if (lc)   o.lc = lc;
  if (tp)   o.tp = tp;
  if (p50)  o.p50 = p50;
  if (p75)  o.p75 = p75;
  if (p100) o.p100 = p100;
  if (pl)   o.pl = pl;
  if (v3)   o.v3 = v3;

  // funil de mensagens
  const m = {};
  const MSG = {
    conv: ["onsite_conversion.messaging_conversation_started_7d"],
    conn: ["onsite_conversion.total_messaging_connection"],
    welc: ["onsite_conversion.messaging_welcome_message_view"],
    repl: ["onsite_conversion.messaging_first_reply"],
    rep7: ["onsite_conversion.messaging_conversation_replied_7d"],
    d2:   ["onsite_conversion.messaging_user_depth_2_message_send"],
    d3:   ["onsite_conversion.messaging_user_depth_3_message_send"],
    d5:   ["onsite_conversion.messaging_user_depth_5_message_send"],
  };
  for (const [k, types] of Object.entries(MSG)) {
    const v = pick(a, types);
    if (v) m[k] = v;
  }
  if (Object.keys(m).length) o.m = m;

  if (plan?.key === "C3") o.res = m.conv || 0;
  return o;
}


/* ── alcance real por janela ──────────────────────────────────────────────
   Alcance é gente ÚNICA: não pode ser somado entre dias nem entre campanhas.
   Então buscamos o número pronto na Meta para cada atalho de período que o
   painel oferece. Intervalo personalizado fica sem alcance (mostra "—").     */
/* Mesmas janelas dos atalhos do index.html (presetRange) — as duas precisam
   bater exatamente, senão o painel não encontra o alcance da janela.
   Igual aos gerenciadores Meta/Google: 7/30/90 dias terminam ONTEM; "Hoje",
   "Este mês" e "Tudo" vão até hoje. `hoje` = data em Brasília no momento da coleta. */
const addDias = (iso, n) => { const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const hojeSP = agora => agora.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
function janelas(first, hoje) {
  const ontem = addDias(hoje, -1), ate = n => ({ from: addDias(ontem, -(n - 1)), until: ontem });
  return {
    today:      { from: hoje,  until: hoje },
    yesterday:  { from: ontem, until: ontem },
    last_7d:    ate(7),
    last_30d:   ate(30),
    last_90d:   ate(90),
    this_month: { from: hoje.slice(0, 7) + "-01", until: hoje },
    all:        { from: first, until: hoje },
  };
}

async function alcancePorJanela(first, last) {
  const ws = janelas(first, last), out = {};
  for (const [nome, w] of Object.entries(ws)) {
    const time_range = JSON.stringify({ since: w.from, until: w.until });
    // nível conta NÃO aceita filtro por campanha (a API recusa). Então o alcance
    // da conta só vale como "alcance das monitoradas" se mais nada tiver gasto
    // na janela. Se houver gasto de fora, devolvemos null → o painel mostra "—"
    // em vez de misturar público de campanhas que o painel não acompanha.
    const [acct] = await getAll(`act_${ACCOUNT}/insights`, { level: "account", time_range, fields: "reach,spend" });
    const camps = await getAll(`act_${ACCOUNT}/insights`, {
      level: "campaign", time_range, fields: "campaign_id,reach,spend",
      filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: WATCHED }]),
    });
    // alcance é gente única: não dá para somar campanhas. O grupo só tem alcance
    // quando exatamente UMA campanha dele veiculou na janela; senão fica null ("—").
    const c = {}, porGrupo = {};
    let somaCamp = 0;
    for (const r of camps) {
      somaCamp += parseFloat(r.spend || 0);
      if (parseFloat(r.spend || 0) > 0) (porGrupo[CAMP2GROUP[r.campaign_id]] ||= []).push(num(r.reach));
    }
    for (const [g, arr] of Object.entries(porGrupo)) c[g] = arr.length === 1 ? arr[0] : null;
    const gastoConta = parseFloat(acct?.spend || 0);
    // só interessa gasto EXCEDENTE (conta > campanhas). Diferença negativa ou
    // de centavos é arredondamento da Meta, não campanha de fora.
    const excedente = gastoConta - somaCamp;
    const limite = Math.max(1, gastoConta * 0.005);
    const soMonitoradas = excedente <= limite;
    if (!soMonitoradas) {
      console.warn(`    aviso: janela ${nome} tem R$${excedente.toFixed(2)} gastos fora das campanhas monitoradas — alcance geral omitido`);
    }
    out[nome] = { from: w.from, until: w.until, acc: soMonitoradas ? num(acct?.reach) : null, c };
    if (!soMonitoradas) out[nome].acc_note = `a conta teve R$${excedente.toFixed(0)} fora das campanhas do painel`;
  }
  return { fetched_at: new Date().toISOString(), windows: out };
}

/* ── main ────────────────────────────────────────────────────────────── */
async function main() {
  const until = new Date().toISOString().slice(0, 10);
  const time_range = JSON.stringify({ since: SINCE, until });

  const campMeta = await getAll(`act_${ACCOUNT}/campaigns`, {
    fields: "id,name,objective,effective_status,daily_budget",
  });
  const adMeta = await getAll(`act_${ACCOUNT}/ads`, {
    fields: "id,name,campaign_id,effective_status,creative{id}",
  });

  const campById = Object.fromEntries(campMeta.map(c => [c.id, c]));
  for (const c of campMeta) { const g = grupoDoNome(c.name); if (g) CAMP2GROUP[c.id] = g; }
  WATCHED = Object.keys(CAMP2GROUP);
  const semGrupo = campMeta.filter(c => !CAMP2GROUP[c.id]);
  if (semGrupo.length) console.warn("    aviso: campanhas sem C1/C2/C3 no nome ficam fora do painel: " + semGrupo.map(c => c.name).join(" | "));
  if (!WATCHED.length) throw new Error("nenhuma campanha com C1/C2/C3 no nome");
  const adById   = Object.fromEntries(adMeta.map(a => [a.id, a]));

  // insights diários por anúncio, só das campanhas monitoradas
  const rows = await getAll(`act_${ACCOUNT}/insights`, {
    level: "ad",
    time_range,
    time_increment: "1",
    fields: IF,
    filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: WATCHED }]),
  });

  const daily = rows
    .filter(r => parseFloat(r.spend) > 0)
    .map(toRow)
    .sort((x, y) => x.d < y.d ? -1 : x.d > y.d ? 1 : 0);

  if (!daily.length) throw new Error("nenhuma linha com gasto — confira o token e o AD_ACCOUNT_ID");

  const usedAds = [...new Set(daily.map(r => r.a))];

  // capas dos criativos → thumbs/<ad_id>.jpg
  // O data.json semeado trouxe capas de 160px (limite do que dá para pegar sem token).
  // Na primeira rodada com token, `thumbs_lowres` força a troca por 400px.
  const prevSeed = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  const forceThumbs = prevSeed?.meta?.thumbs_lowres === true;
  mkdirSync(THUMBDIR, { recursive: true });
  const imgMap = {};
  let baixadas = 0;
  for (const adId of usedAds) {
    const file = join(THUMBDIR, adId + ".jpg"), rel = "thumbs/" + adId + ".jpg";
    if (existsSync(file) && !forceThumbs) { imgMap[adId] = rel; continue; }
    const cid = adById[adId]?.creative?.id;
    if (!cid) continue;
    try {
      const j = await (await fetch(`${API}/${cid}?fields=thumbnail_url&thumbnail_width=400&thumbnail_height=400&access_token=${TOKEN}`)).json();
      if (!j.thumbnail_url) continue;
      const ir = await fetch(j.thumbnail_url);
      if (!ir.ok) continue;
      writeFileSync(file, Buffer.from(await ir.arrayBuffer()));
      imgMap[adId] = rel; baixadas++;
    } catch { /* segue sem capa */ }
    // se a troca falhou mas já existe uma capa em disco, mantém a antiga
    if (!imgMap[adId] && existsSync(file)) imgMap[adId] = rel;
  }

  const ads = usedAds.map(id => {
    const a = adById[id] || {};
    const o = {
      id,
      name: a.name || id,
      campaign_id: daily.find(r => r.a === id).c,
      status: a.effective_status || "PAUSED",
    };
    if (imgMap[id]) o.img = imgMap[id];
    return o;
  }).sort((x, y) => x.name.localeCompare(y.name));

  // um "campaign" por grupo; members = campanhas reais que entraram nele
  const campaigns = GROUPS.map(p => {
    const members = campMeta.filter(c => CAMP2GROUP[c.id] === p.key && daily.some(r => r.oc === c.id))
      .map(c => ({ id: c.id, name: c.name, status: c.effective_status,
        spend: +daily.filter(r => r.oc === c.id).reduce((s, r) => s + r.s, 0).toFixed(2) }));
    const ativas = members.filter(m => m.status === "ACTIVE");
    const orc = ativas.map(m => campById[m.id]?.daily_budget).filter(Boolean);
    return {
      id: p.key, key: p.key, tag: p.tag,
      name: (ativas.length ? ativas : members).map(m => m.name).join(" + ") || p.label,
      label: p.label, goal: p.goal,
      status: ativas.length ? "ACTIVE" : "PAUSED",
      daily_budget: orc.length ? Math.round(orc.reduce((s, v) => s + +v, 0) / 100) : null,
      members,
      kpi: p.kpi, kpi_label: p.kpi_label, kpi_unit: p.kpi_unit,
      kpi2: p.kpi2, kpi2_label: p.kpi2_label, kpi2_unit: p.kpi2_unit,
    };
  }).filter(c => c.members.length);

  const dates = daily.map(r => r.d);
  const AGORA = new Date(), HOJE = hojeSP(AGORA);
  const reach = await alcancePorJanela(dates[0], HOJE);

  const data = {
    meta: {
      account_id: ACCOUNT,
      account_name: "Vuou - 01",
      client: "Vuou",
      client_sub: "Passagens aéreas com milhas",
      currency: "BRL",
      tz: "America/Sao_Paulo",
      updated_at: AGORA.toISOString(),
      today: HOJE,               // referência dos atalhos (Brasília) — o painel usa a mesma
      seed: false,
      first_date: dates[0],
      last_date: dates[dates.length - 1],
      default_period: prevSeed?.meta?.default_period || "all",
      // capas já vêm em 400px daqui em diante; a marca do seed sai
      ...(forceThumbs ? {} : (prevSeed?.meta?.thumbs_lowres ? { thumbs_lowres: true } : {})),
    },
    campaigns, ads, daily, reach,
  };

  writeFileSync(OUT, JSON.stringify(data) + "\n");

  const tot = daily.reduce((s, r) => s + r.s, 0);
  console.log(`OK  linhas=${daily.length}  anúncios=${ads.length}  capas novas=${baixadas}`);
  console.log(`    período ${data.meta.first_date} → ${data.meta.last_date}  investido R$${tot.toFixed(2)}`);
  console.log(`    alcance real: ` + Object.entries(reach.windows).map(([k, w]) => k + "=" + w.acc).join("  "));
  let alarme = false;
  for (const c of campaigns) {
    const rs = daily.filter(r => r.c === c.id);
    const sp = rs.reduce((s, r) => s + r.s, 0);
    const kv = rs.reduce((s, r) => s + (r.m?.[c.kpi] ?? r[c.kpi] ?? 0), 0);
    const zerado = sp > 0 && kv === 0;
    if (zerado) alarme = true;
    console.log(`    ${c.tag} R${sp.toFixed(2).padStart(9)}  ${c.kpi_label}: ${kv}${zerado ? "   <-- ZERO com verba gasta, confira o nome do campo" : ""}`);
    for (const m of c.members) console.log(`         · R${m.spend.toFixed(2).padStart(8)}  ${m.status.padEnd(7)} ${m.name}`);
  }
  if (alarme) console.warn("AVISO: alguma métrica principal veio zerada. A Meta ignora campo inválido em silêncio — confira o nome antes de confiar no dado.");
}

main().catch(e => { console.error("FALHA:", e.message); process.exit(1); });
