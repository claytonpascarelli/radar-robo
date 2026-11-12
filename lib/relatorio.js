// Relatório da manhã: resume as publicações das últimas 24 horas.
const Anthropic = require('@anthropic-ai/sdk');
const { PADRAO, diaLocal } = require('./coletar');

// Gera o relatório do dia se já passou das 6h30 (no fuso configurado) e ele ainda não existe.
async function relatorioSeForHora(db, chaveIA, agora) {
  const cfgDoc = await db.collection('config').doc('geral').get();
  const cfg = Object.assign({}, PADRAO, cfgDoc.exists ? cfgDoc.data() : {});
  const hora = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.fuso, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(agora));
  if (hora < '06:30') return 'cedo';
  const dia = diaLocal(agora, cfg.fuso);
  const ref = db.collection('relatorios').doc(dia);
  if ((await ref.get()).exists) return 'ja-existe';
  if (!chaveIA) return 'sem-chave';

  const posts = (await db.collection('posts').where('detectadoEm', '>=', agora - 24 * 3600 * 1000).orderBy('detectadoEm').get()).docs.map((d) => d.data());
  if (!posts.length) {
    await ref.set({ dia, criadoEm: agora, total: 0, texto: 'Nenhuma publicação detectada nas últimas 24 horas.' });
    return 'vazio';
  }
  const linhas = posts.map((p) =>
    '- ' + p.nome + (p.cargo ? ' (' + p.cargo + ')' : '') + ' | ' + p.rede + '/' + p.tipo + ' | relevância ' + p.relevancia + ' | ' + (p.titulo || '') + ' — ' + (p.resumo || p.texto || '').slice(0, 600));
  const cliente = new Anthropic({ apiKey: chaveIA });
  const resposta = await cliente.beta.messages.create({
    model: cfg.modeloIA,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system: 'Você é editor de um canal de notícias brasileiro. Com base nos resumos de publicações de autoridades das últimas 24 horas, escreva o relatório da manhã para a redação: primeiro os 3 a 6 assuntos mais quentes (quem falou o quê), depois temas em que várias autoridades se manifestaram, e por fim sugestões de pauta. Use só o que está na lista. Texto corrido e direto, em português, sem enfeites.',
    messages: [{ role: 'user', content: 'Publicações detectadas:\n' + linhas.join('\n') }],
  });
  const bloco = resposta.content.find((b) => b.type === 'text');
  await ref.set({ dia, criadoEm: agora, total: posts.length, texto: bloco ? bloco.text : 'A IA não gerou o relatório (' + resposta.stop_reason + ').' });
  return 'gerado';
}

module.exports = { relatorioSeForHora };
