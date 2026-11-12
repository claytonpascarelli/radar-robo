// Uma rodada do rastreador: decide quais perfis checar, coleta, resume e grava.
const redes = require('./redes');

const PADRAO = {
  pausado: false,
  intervaloVipMin: 5,
  intervaloNormalMin: 20,
  tetoDiarioUsd: 5,
  tetoPorRodadaUsd: 0.5,
  maxNovosPorPerfil: 5,
  modeloIA: 'claude-opus-5-5',
  atorInstagram: 'apify/instagram-scraper',
  atorFacebook: 'apify/facebook-posts-scraper',
  atorTiktok: 'clockworks/tiktok-scraper',
  atorStories: '',
  entradaStories: '{"usernames": {{usuarios}}}',
  precoInstagramPorMil: 2.3,
  precoStoriesPorMil: 2.3,
  precoFacebookPorMil: 5,
  precoTiktokPorMil: 1.7,
  precoXPorMil: 0,
  urlTranscricao: 'https://api.groq.com/openai/v1/audio/transcriptions',
  modeloTranscricao: 'whisper-large-v3',
  fuso: 'America/Manaus',
  esperaChecarVipMin: 3,
};

function diaLocal(agora, fuso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso }).format(new Date(agora));
}

async function emParalelo(lista, limite, fn) {
  let i = 0;
  const trabalhadores = Array.from({ length: Math.min(limite, lista.length) }, async () => {
    while (i < lista.length) await fn(lista[i++]);
  });
  await Promise.all(trabalhadores);
}

// deps.pedido (opcional): checagem pedida no painel, fora do horário automático.
//   { tipo: 'vip' } checa todos os VIP; { tipo: 'autoridade', autoridadeId } checa uma pessoa.
//   Funciona mesmo com as buscas automáticas desligadas, mas respeita o teto de gasto do dia.
// deps: { db, fetch, agora, segredos: { apify, xBearer, transcricao }, criarResumidor, baixarImagem, transcrever }
async function rodada(deps) {
  const { db } = deps;
  const agora = deps.agora || Date.now();
  const cfgDoc = await db.collection('config').doc('geral').get();
  const cfg = Object.assign({}, PADRAO, cfgDoc.exists ? cfgDoc.data() : {});

  const statusRef = db.collection('sistema').doc('status');
  const statusDoc = await statusRef.get();
  const hoje = diaLocal(agora, cfg.fuso);
  let status = statusDoc.exists ? statusDoc.data() : {};
  if (status.dia !== hoje) status = { dia: hoje, gastoDiaUsd: 0, resultadosDia: 0, postsDia: 0 };

  const fechar = (extra) => statusRef.set(Object.assign({}, status, { ultimaRodada: agora }, extra));

  const pedido = deps.pedido || null;
  if (cfg.pausado && !pedido) return fechar({ situacao: 'pausado', erros: [] });
  if (status.gastoDiaUsd >= cfg.tetoDiarioUsd) {
    await fechar({ situacao: 'teto', erros: [] });
    return { checados: 0, novos: 0, erros: [], recusado: 'teto' };
  }
  if (pedido && pedido.tipo === 'vip') {
    const espera = cfg.esperaChecarVipMin * 60000;
    if (status.ultimoPedidoVip && agora - status.ultimoPedidoVip < espera) return { checados: 0, novos: 0, erros: [], recusado: 'intervalo' };
    status.ultimoPedidoVip = agora;
  }

  // Perfis ativos e estado de cada um
  const autoridades = (await db.collection('autoridades').get()).docs
    .map((d) => Object.assign({ id: d.id }, d.data()))
    .filter((a) => a.ativo !== false);
  const estado = new Map((await db.collection('perfis_estado').get()).docs.map((d) => [d.id, d.data()]));

  const perfis = [];
  for (const a of autoridades) {
    for (const p of a.perfis || []) {
      perfis.push({ chave: p.rede + '_' + String(p.usuario).toLowerCase(), rede: p.rede, usuario: p.usuario, url: p.url, autoridade: a });
    }
  }

  const folga = 30 * 1000;
  const vencidos = perfis.filter((p) => {
    if (pedido) return pedido.tipo === 'vip' ? p.autoridade.prioridade === 'vip' : p.autoridade.id === pedido.autoridadeId;
    const e = estado.get(p.chave) || {};
    const min = p.autoridade.prioridade === 'vip' ? cfg.intervaloVipMin : cfg.intervaloNormalMin;
    return !e.ultimaChecagem || agora - e.ultimaChecagem >= min * 60000 - folga;
  });

  const mudancas = new Map();
  const novoEstado = (chave, dados) => mudancas.set(chave, Object.assign(mudancas.get(chave) || {}, dados));
  const ctx = { fetch: deps.fetch, segredos: deps.segredos, cfg, estado, novoEstado };

  // Coleta por rede. A falha de uma rede não derruba as outras.
  const erros = [];
  const itens = [];
  const checados = new Set();
  const tarefas = [
    { nome: 'Instagram', rede: 'instagram', fn: redes.instagramFeed, precisa: 'apify' },
    { nome: 'Stories', rede: 'instagram', fn: redes.instagramStories, precisa: 'apify', extra: true },
    { nome: 'Facebook', rede: 'facebook', fn: redes.facebook, precisa: 'apify' },
    { nome: 'TikTok', rede: 'tiktok', fn: redes.tiktok, precisa: 'apify' },
    { nome: 'X', rede: 'x', fn: redes.x, precisa: 'xBearer' },
  ];
  await Promise.all(tarefas.map(async (t) => {
    const lista = vencidos.filter((p) => p.rede === t.rede);
    if (!lista.length) return;
    if (!deps.segredos[t.precisa]) {
      erros.push({ onde: t.nome, msg: 'Chave de acesso não configurada' });
      return;
    }
    try {
      const r = await t.fn(ctx, lista);
      if (r.desligado) return;
      itens.push(...r.itens);
      status.resultadosDia += r.resultados;
      status.gastoDiaUsd += (r.resultados * (r.precoPorMil || 0)) / 1000;
      if (!t.extra) lista.forEach((p) => checados.add(p.chave));
    } catch (e) {
      erros.push({ onde: t.nome, msg: String(e.message || e).slice(0, 300) });
    }
  }));

  // Separa o que é novo
  const porPerfil = new Map();
  for (const it of itens) {
    if (!porPerfil.has(it.chave)) porPerfil.set(it.chave, []);
    porPerfil.get(it.chave).push(it);
  }
  const perfilPorChave = new Map(perfis.map((p) => [p.chave, p]));
  const paraProcessar = [];
  for (const chave of checados) {
    const e = estado.get(chave) || {};
    const vistos = new Set(e.vistos || []);
    const recebidos = porPerfil.get(chave) || [];
    const novos = recebidos.filter((it) => !vistos.has(it.id));
    recebidos.forEach((it) => vistos.add(it.id));
    // Primeira checagem de um perfil: só memoriza o que já existia, sem avisar.
    if (e.semeado) {
      novos.sort((a, b) => (b.publicadoEm || 0) - (a.publicadoEm || 0));
      novos.slice(0, cfg.maxNovosPorPerfil).forEach((it) => paraProcessar.push({ it, perfil: perfilPorChave.get(chave) }));
    }
    novoEstado(chave, { ultimaChecagem: agora, semeado: true, vistos: Array.from(vistos).slice(-40) });
  }

  // Transcreve, resume e grava cada publicação nova
  const resumir = paraProcessar.length && deps.segredos.anthropic ? deps.criarResumidor(deps.segredos.anthropic, cfg.modeloIA) : null;
  if (paraProcessar.length && !resumir) erros.push({ onde: 'IA', msg: 'Chave da IA não configurada: publicações gravadas sem resumo' });

  await emParalelo(paraProcessar, 4, async ({ it, perfil }) => {
    const a = perfil.autoridade;
    const post = {
      autoridadeId: a.id, nome: a.nome, cargo: a.cargo || '', partido: a.partido || '', prioridade: a.prioridade || 'normal',
      rede: perfil.rede, usuario: perfil.usuario, tipo: it.tipo, url: it.url,
      texto: (it.texto || '').slice(0, 5000), imagemUrl: it.imagemUrl || null,
      publicadoEm: it.publicadoEm || agora, detectadoEm: Date.now(),
      transcricao: it.transcricao || '', titulo: '', resumo: '', temas: [], relevancia: 'media', citacao: '',
      semConteudo: false, lido: false, pauta: false,
    };
    try {
      if (!post.transcricao && it.videoUrl) {
        post.transcricao = (await deps.transcrever(deps.fetch, cfg, deps.segredos.transcricao, it.videoUrl)).slice(0, 20000);
      }
    } catch (e) {
      post.erroIA = 'Transcrição falhou: ' + String(e.message || e).slice(0, 200);
    }
    if (resumir) {
      try {
        const imagem = await deps.baixarImagem(deps.fetch, it.imagemUrl);
        Object.assign(post, await resumir({ nome: a.nome, cargo: a.cargo, rede: perfil.rede, tipo: it.tipo, texto: post.texto, transcricao: post.transcricao, imagem }));
      } catch (e) {
        post.erroIA = 'Resumo falhou: ' + String(e.message || e).slice(0, 200);
      }
    }
    if (!post.titulo) post.titulo = (post.texto || 'Publicação sem texto').slice(0, 90);
    const idDoc = (it.chave + '_' + it.id).replace(/[^A-Za-z0-9_.-]/g, '-');
    await db.collection('posts').doc(idDoc).set(post);
    status.postsDia += 1;
  });

  await emParalelo(Array.from(mudancas), 10, ([chave, dados]) =>
    db.collection('perfis_estado').doc(chave).set(dados, { merge: true }));

  await fechar({
    situacao: cfg.pausado ? 'pausado' : erros.length ? 'com-erros' : 'ok',
    erros,
    perfisAtivos: perfis.length,
    checadosNaRodada: checados.size,
    novosNaRodada: paraProcessar.length,
    storiesLigado: !!cfg.atorStories,
  });
  return { checados: checados.size, novos: paraProcessar.length, erros };
}

module.exports = { rodada, PADRAO, diaLocal };
