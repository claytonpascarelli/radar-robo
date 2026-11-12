// Radar Político — robô de coleta. Roda no GitHub Actions em horário agendado.
const admin = require('firebase-admin');
const ia = require('./lib/ia');
const { ciclo } = require('./lib/ciclo');
const { relatorioSeForHora } = require('./lib/relatorio');

const chave = (nome) => {
  const v = (process.env[nome] || '').trim();
  return v && v.toLowerCase() !== 'vazio' ? v : '';
};

(async () => {
  const conta = chave('FIREBASE_SERVICE_ACCOUNT');
  if (!conta) { console.log('Robô ainda não ligado ao banco (falta FIREBASE_SERVICE_ACCOUNT).'); return; }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(conta)) });
  const r = await ciclo({
    db: admin.firestore(),
    fetch,
    segredos: { apify: chave('APIFY_TOKEN'), anthropic: chave('ANTHROPIC_API_KEY'), xBearer: chave('X_BEARER_TOKEN'), transcricao: chave('TRANSCRICAO_API_KEY') },
    criarResumidor: ia.criarResumidor,
    baixarImagem: ia.baixarImagem,
    transcrever: ia.transcrever,
  }, relatorioSeForHora);
  console.log('ciclo', JSON.stringify(r));
})().catch((e) => {
  // Mensagem curta e sem dados: o registro é público.
  console.error('O ciclo falhou:', String(e && e.code ? e.code : (e && e.name) || 'erro'));
  process.exit(1);
});
