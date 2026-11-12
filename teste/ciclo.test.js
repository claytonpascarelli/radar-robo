// Teste do ciclo com banco e redes simulados (não gasta nada, não acessa a internet).
const assert = require('assert');
const { ciclo } = require('../lib/ciclo');

function bancoFalso(inicial) {
  const dados = JSON.parse(JSON.stringify(inicial));
  const colecao = (nome, filtro) => {
    dados[nome] = dados[nome] || {};
    const col = dados[nome];
    const ref = (id) => ({
      async get() { return { exists: id in col, data: () => col[id] }; },
      async set(v, op) { col[id] = op && op.merge ? Object.assign({}, col[id], v) : v; },
    });
    return {
      async get() { return { docs: Object.keys(col).filter((id) => !filtro || filtro(col[id])).map((id) => ({ id, data: () => col[id], ref: ref(id) })) }; },
      where(campo, op, valor) { assert.strictEqual(op, '>='); return colecao(nome, (d) => d[campo] >= valor); },
      orderBy() { return this; },
      doc: ref,
    };
  };
  return { dados, collection: (n) => colecao(n) };
}

(async () => {
  const T0 = Date.parse('2026-11-12T12:00:00Z'); // 08:00 em Manaus
  const posts = [{ ownerUsername: 'vip', shortCode: 'A1', caption: 'antigo', timestamp: '2026-11-12T11:00:00Z' }];
  const fetch = async (url, op) => {
    const pedido = JSON.parse(op.body);
    return { ok: true, json: async () => posts.filter((p) => pedido.directUrls.some((u) => u.includes('/' + p.ownerUsername + '/'))) };
  };
  const db = bancoFalso({
    autoridades: {
      a1: { nome: 'VIP', prioridade: 'vip', perfis: [{ rede: 'instagram', usuario: 'vip', url: 'https://www.instagram.com/vip/' }] },
      a2: { nome: 'Normal', perfis: [{ rede: 'instagram', usuario: 'normal', url: 'https://www.instagram.com/normal/' }] },
    },
  });
  const deps = (agora) => ({
    db, fetch, agora,
    segredos: { apify: 'tk', anthropic: 'ia', xBearer: '', transcricao: '' },
    criarResumidor: () => async (d) => ({ titulo: 'T ' + d.texto, resumo: 'R', temas: [], relevancia: 'media', citacao: '', semConteudo: false }),
    baixarImagem: async () => null,
    transcrever: async () => '',
  });
  const relatorio = async () => 'ja-existe';

  let r = await ciclo(deps(T0), relatorio);
  assert.deepStrictEqual([r.pedidos, r.checados, r.novos], [0, 2, 0], 'primeiro ciclo só memoriza');
  assert.strictEqual(r.relatorio, 'ja-existe');

  // Pedido feito no painel: é atendido no ciclo seguinte, mesmo fora do intervalo normal
  posts.push({ ownerUsername: 'normal', shortCode: 'B1', caption: 'novo', timestamp: '2026-11-12T12:01:00Z' });
  db.dados.pedidos = {
    p1: { tipo: 'autoridade', autoridadeId: 'a2', por: 'x@y', criadoEm: T0 + 60000 },
    velho: { tipo: 'vip', por: 'x@y', criadoEm: T0 - 3600000 },
    feito: { tipo: 'vip', por: 'x@y', criadoEm: T0 + 30000, estado: 'feito' },
  };
  r = await ciclo(deps(T0 + 2 * 60000), relatorio);
  assert.strictEqual(r.pedidos, 1, 'atende só o pedido recente e sem resposta');
  assert.strictEqual(db.dados.pedidos.p1.estado, 'feito');
  assert.strictEqual(db.dados.pedidos.p1.novos, 1);
  assert.ok(!db.dados.pedidos.velho.estado, 'pedido antigo é ignorado');
  assert.ok(db.dados.posts['instagram_normal_B1']);

  // O resumo que vai para o registro público não leva nomes nem textos
  const texto = JSON.stringify(r);
  assert.ok(!/Normal|T novo|instagram_normal/.test(texto), 'registro público sem dados: ' + texto);
  console.log('ciclo: ok');
})().catch((e) => { console.error(e); process.exit(1); });
