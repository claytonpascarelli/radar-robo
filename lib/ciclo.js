// Um ciclo do robô: atende os pedidos de "Checar agora", faz a rodada automática
// e, se for hora, gera o relatório da manhã. Não imprime nomes nem conteúdo:
// o registro de execução do GitHub é público.
const { rodada } = require('./coletar');

async function ciclo(deps, relatorioSeForHora) {
  const { db } = deps;
  const agora = deps.agora || Date.now();
  const resumo = { pedidos: 0, checados: 0, novos: 0, erros: [], relatorio: '' };

  // Pedidos feitos no painel nos últimos 30 minutos e ainda sem resposta.
  const pendentes = (await db.collection('pedidos').where('criadoEm', '>=', agora - 30 * 60000).get()).docs
    .filter((d) => !(d.data() || {}).estado).slice(0, 10);
  for (const doc of pendentes) {
    const p = doc.data() || {};
    const pedido = p.tipo === 'autoridade' ? { tipo: 'autoridade', autoridadeId: String(p.autoridadeId || '') } : { tipo: 'vip' };
    try {
      const r = await rodada(Object.assign({}, deps, { pedido }));
      await doc.ref.set({ estado: r.recusado ? 'recusado' : 'feito', motivo: r.recusado || '', checados: r.checados, novos: r.novos, erros: (r.erros || []).length, terminouEm: Date.now() }, { merge: true });
      resumo.checados += r.checados; resumo.novos += r.novos;
      (r.erros || []).forEach((e) => resumo.erros.push(e.onde));
    } catch (e) {
      await doc.ref.set({ estado: 'falhou', motivo: String(e.message || e).slice(0, 200), terminouEm: Date.now() }, { merge: true });
      resumo.erros.push('pedido');
    }
    resumo.pedidos += 1;
  }

  const r = await rodada(deps);
  resumo.checados += r.checados || 0; resumo.novos += r.novos || 0;
  (r.erros || []).forEach((e) => resumo.erros.push(e.onde));

  if (relatorioSeForHora) {
    try { resumo.relatorio = await relatorioSeForHora(db, deps.segredos.anthropic, agora); }
    catch (e) { resumo.relatorio = 'falhou'; }
  }
  resumo.erros = Array.from(new Set(resumo.erros));
  return resumo;
}

module.exports = { ciclo };
