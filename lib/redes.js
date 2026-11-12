// Coletores: cada um recebe uma lista de perfis e devolve as publicações recentes.
// Formato de saída de cada item:
//   { chave, id, tipo, url, texto, imagemUrl, videoUrl, publicadoEm, transcricao }
// `chave` identifica o perfil (rede_usuario) a que o item pertence.

const APIFY = 'https://api.apify.com/v2/actors/';

function pegar(obj, caminhos) {
  for (const caminho of caminhos) {
    let v = obj;
    for (const parte of caminho.split('.')) {
      if (v == null) break;
      v = v[parte];
    }
    if (v != null && v !== '') return v;
  }
  return null;
}

function paraMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  if (/^\d+$/.test(String(v))) return paraMillis(Number(v));
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function emLotes(lista, tamanho) {
  const lotes = [];
  for (let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}

async function rodarApify(ctx, ator, entrada, tetoUsd) {
  const url = APIFY + encodeURIComponent(ator.replace('/', '~')) +
    '/run-sync-get-dataset-items?timeout=240&maxTotalChargeUsd=' + tetoUsd;
  const resp = await ctx.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ctx.segredos.apify },
    body: JSON.stringify(entrada),
  });
  if (!resp.ok) {
    const corpo = (await resp.text()).slice(0, 300);
    throw new Error('Apify ' + ator + ' respondeu ' + resp.status + ': ' + corpo);
  }
  const itens = await resp.json();
  return Array.isArray(itens) ? itens : [];
}

// ---------- Instagram: feed e reels (ator oficial apify/instagram-scraper) ----------
async function instagramFeed(ctx, perfis) {
  const itens = [];
  let resultados = 0;
  for (const lote of emLotes(perfis, 25)) {
    const brutos = await rodarApify(ctx, ctx.cfg.atorInstagram, {
      directUrls: lote.map((p) => p.url),
      resultsType: 'posts',
      resultsLimit: 3,
      onlyPostsNewerThan: '2 days',
      addParentData: false,
    }, ctx.cfg.tetoPorRodadaUsd);
    resultados += brutos.length;
    for (const b of brutos) {
      const usuario = String(pegar(b, ['ownerUsername', 'owner.username']) || '').toLowerCase();
      const id = pegar(b, ['shortCode', 'id']);
      if (!usuario || !id) continue;
      const ehVideo = b.type === 'Video' || !!b.videoUrl;
      itens.push({
        chave: 'instagram_' + usuario,
        id: String(id),
        tipo: b.productType === 'clips' ? 'reels' : 'feed',
        url: b.url || 'https://www.instagram.com/p/' + id + '/',
        texto: b.caption || '',
        imagemUrl: b.displayUrl || null,
        videoUrl: ehVideo ? b.videoUrl || null : null,
        publicadoEm: paraMillis(b.timestamp),
      });
    }
  }
  return { itens, resultados, precoPorMil: ctx.cfg.precoInstagramPorMil };
}

// ---------- Instagram: stories (ator configurável, escolhido no painel) ----------
// O ator oficial não traz stories. Em Sistema > Coletores informa-se o ator e o
// modelo de entrada, com {{usuarios}} ou {{links}} no lugar da lista de perfis.
async function instagramStories(ctx, perfis) {
  if (!ctx.cfg.atorStories) return { itens: [], resultados: 0, precoPorMil: 0, desligado: true };
  const itens = [];
  let resultados = 0;
  for (const lote of emLotes(perfis, 25)) {
    const modelo = ctx.cfg.entradaStories || '{"usernames": {{usuarios}}}';
    const entrada = JSON.parse(modelo
      .replace('{{usuarios}}', JSON.stringify(lote.map((p) => p.usuario)))
      .replace('{{links}}', JSON.stringify(lote.map((p) => p.url))));
    const brutos = await rodarApify(ctx, ctx.cfg.atorStories, entrada, ctx.cfg.tetoPorRodadaUsd);
    resultados += brutos.length;
    for (const b of brutos) {
      const usuario = String(pegar(b, ['ownerUsername', 'username', 'user.username', 'owner.username']) || '').toLowerCase();
      const id = pegar(b, ['id', 'pk', 'storyId', 'story_id']);
      if (!usuario || !id) continue;
      const videoUrl = pegar(b, ['videoUrl', 'video_url', 'video_versions.0.url', 'video']);
      itens.push({
        chave: 'instagram_' + usuario,
        id: 'st' + String(id),
        tipo: 'stories',
        url: 'https://www.instagram.com/stories/' + usuario + '/',
        texto: pegar(b, ['caption', 'text', 'accessibility_caption']) || '',
        imagemUrl: pegar(b, ['displayUrl', 'imageUrl', 'image_url', 'thumbnailUrl', 'image_versions2.candidates.0.url']),
        videoUrl: typeof videoUrl === 'string' ? videoUrl : null,
        publicadoEm: paraMillis(pegar(b, ['timestamp', 'takenAt', 'taken_at'])),
      });
    }
  }
  return { itens, resultados, precoPorMil: ctx.cfg.precoStoriesPorMil };
}

// ---------- Facebook (ator oficial apify/facebook-posts-scraper) ----------
async function facebook(ctx, perfis) {
  const itens = [];
  let resultados = 0;
  const normal = (u) => String(u || '').toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/\/+$/, '');
  for (const lote of emLotes(perfis, 25)) {
    const porUrl = new Map(lote.map((p) => [normal(p.url), p]));
    const brutos = await rodarApify(ctx, ctx.cfg.atorFacebook, {
      startUrls: lote.map((p) => ({ url: p.url })),
      resultsLimit: 3,
      onlyPostsNewerThan: '2 days',
      captionText: true,
    }, ctx.cfg.tetoPorRodadaUsd);
    resultados += brutos.length;
    for (const b of brutos) {
      const perfil = porUrl.get(normal(b.inputUrl)) || porUrl.get(normal(b.facebookUrl));
      const id = pegar(b, ['postId', 'facebookId']);
      if (!perfil || !id) continue;
      const midia = Array.isArray(b.media) ? b.media[0] || {} : {};
      itens.push({
        chave: 'facebook_' + perfil.usuario,
        id: String(id),
        tipo: 'post',
        url: b.url || b.topLevelUrl || perfil.url,
        texto: b.text || '',
        imagemUrl: pegar(midia, ['thumbnail', 'photo_image.uri', 'image.uri']),
        videoUrl: null,
        publicadoEm: paraMillis(b.timestamp || b.time),
        transcricao: typeof b.captionText === 'string' ? b.captionText : '',
      });
    }
  }
  return { itens, resultados, precoPorMil: ctx.cfg.precoFacebookPorMil };
}

// ---------- TikTok (ator clockworks/tiktok-scraper, mantido pela Apify) ----------
// Cobra por resultado. Não usamos o filtro de data (é cobrado à parte): pedimos só
// os 3 vídeos mais recentes de cada perfil, sem os fixados.
function limparLegenda(vtt) {
  return String(vtt || '').split(/\r?\n/)
    .filter((l) => l.trim() && !/^WEBVTT/.test(l) && !/-->/.test(l) && !/^\d+$/.test(l.trim()))
    .join(' ').replace(/\s+/g, ' ').trim();
}

async function tiktok(ctx, perfis) {
  const itens = [];
  let resultados = 0;
  for (const lote of emLotes(perfis, 25)) {
    const brutos = await rodarApify(ctx, ctx.cfg.atorTiktok, {
      profiles: lote.map((p) => p.usuario),
      profileScrapeSections: ['videos'],
      profileSorting: 'latest',
      resultsPerPage: 3,
      excludePinnedPosts: true,
    }, ctx.cfg.tetoPorRodadaUsd);
    resultados += brutos.length;
    for (const b of brutos) {
      const link = pegar(b, ['webVideoUrl']) || '';
      const doLink = (/tiktok\.com\/@([^/?#]+)/i.exec(link) || [])[1];
      const usuario = String(doLink || pegar(b, ['authorMeta.name', 'authorMeta.uniqueId']) || '').toLowerCase();
      const id = pegar(b, ['id']);
      if (!usuario || !id) continue;
      const item = {
        chave: 'tiktok_' + usuario,
        id: String(id),
        tipo: 'tiktok',
        url: link || 'https://www.tiktok.com/@' + usuario + '/video/' + id,
        texto: b.text || '',
        imagemUrl: pegar(b, ['videoMeta.coverUrl', 'videoMeta.originalCoverUrl']),
        videoUrl: Array.isArray(b.mediaUrls) && typeof b.mediaUrls[0] === 'string' ? b.mediaUrls[0] : null,
        publicadoEm: paraMillis(pegar(b, ['createTimeISO', 'createTime'])),
      };
      // Quando o próprio TikTok traz legenda automática em português, ela vira a transcrição.
      const legendas = pegar(b, ['videoMeta.subtitleLinks']);
      const pt = Array.isArray(legendas) ? legendas.find((l) => /^(por|pt)/i.test(l.language || '') && l.downloadLink) : null;
      if (pt) {
        try {
          const r = await ctx.fetch(pt.downloadLink);
          if (r.ok) item.transcricao = limparLegenda(await r.text()).slice(0, 20000);
        } catch (e) { /* sem legenda: segue só com o texto e a imagem */ }
      }
      itens.push(item);
    }
  }
  return { itens, resultados, precoPorMil: ctx.cfg.precoTiktokPorMil };
}

// ---------- X / Twitter (API oficial v2) ----------
// O coletor do Apify para X proíbe monitoramento, por isso aqui vai a API oficial.
async function x(ctx, perfis) {
  const itens = [];
  let resultados = 0;
  const cabecalho = { Authorization: 'Bearer ' + ctx.segredos.xBearer };
  for (const p of perfis) {
    const estado = ctx.estado.get(p.chave) || {};
    let idX = estado.idX;
    if (!idX) {
      const r = await ctx.fetch('https://api.x.com/2/users/by/username/' + encodeURIComponent(p.usuario), { headers: cabecalho });
      if (!r.ok) throw new Error('X respondeu ' + r.status + ' ao procurar @' + p.usuario);
      idX = ((await r.json()).data || {}).id;
      if (!idX) continue;
      ctx.novoEstado(p.chave, { idX });
    }
    const q = new URLSearchParams({
      max_results: '5',
      'tweet.fields': 'created_at,attachments',
      expansions: 'attachments.media_keys',
      'media.fields': 'preview_image_url,url,type',
    });
    if (estado.ultimoIdX) q.set('since_id', estado.ultimoIdX);
    const r = await ctx.fetch('https://api.x.com/2/users/' + idX + '/tweets?' + q, { headers: cabecalho });
    if (!r.ok) throw new Error('X respondeu ' + r.status + ' ao ler @' + p.usuario);
    const corpo = await r.json();
    const midias = new Map(((corpo.includes || {}).media || []).map((m) => [m.media_key, m]));
    const tweets = corpo.data || [];
    resultados += tweets.length;
    if (tweets.length) ctx.novoEstado(p.chave, { ultimoIdX: tweets[0].id });
    for (const t of tweets) {
      const chaveMidia = ((t.attachments || {}).media_keys || [])[0];
      const m = midias.get(chaveMidia) || {};
      itens.push({
        chave: p.chave,
        id: String(t.id),
        tipo: 'tweet',
        url: 'https://x.com/' + p.usuario + '/status/' + t.id,
        texto: t.text || '',
        imagemUrl: m.url || m.preview_image_url || null,
        videoUrl: null,
        publicadoEm: paraMillis(t.created_at),
      });
    }
  }
  return { itens, resultados, precoPorMil: ctx.cfg.precoXPorMil };
}

module.exports = { instagramFeed, instagramStories, facebook, tiktok, x, paraMillis, pegar, limparLegenda };
