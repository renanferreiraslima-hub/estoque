// services/cobranca.js
// Rotina automatica (node-cron) que roda uma vez por dia e verifica:
//  1) Clientes que fazem aniversario hoje -> envia mensagem de felicitacao.
//  2) Parcelas do fiado pendentes cujo vencimento esta a 3 dias de distancia
//     ou e hoje -> envia lembrete individual por parcela.
//  3) (Legado) Clientes com "dia de pagamento" geral cadastrado -> lembrete e
//     cobranca de atraso, mantido para compatibilidade com cadastros antigos
//     que nao tem parcelas cadastradas.

require('dotenv').config();
const cron = require('node-cron');
const db = require('../db');
const { enviarMensagem } = require('./whatsapp');
const { diferencaEmDias } = require('./vencimento');

const DIAS_ANTES = Number(process.env.COBRANCA_DIAS_ANTES || 1);
const DIAS_ATRASO = Number(process.env.COBRANCA_DIAS_ATRASO || 3);
const EXPRESSAO_CRON = process.env.COBRANCA_CRON || '0 9 * * *';

// Registra o resultado do disparo no historico de cobrancas
function registrarLog(clienteId, tipo, mensagem, sucesso, { vendaId = null, parcelaId = null } = {}) {
  db.prepare(
    `INSERT INTO cobrancas_log (cliente_id, venda_id, parcela_id, tipo, mensagem, status) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(clienteId, vendaId, parcelaId, tipo, mensagem, sucesso ? 'enviado' : 'erro');
}

// Verifica se ja foi enviado um lembrete deste tipo, para esta parcela, hoje
// (evita disparar a mesma mensagem varias vezes no mesmo dia)
function jaEnviadoHojeParcela(parcelaId, tipo) {
  const linha = db
    .prepare(
      `SELECT COUNT(*) AS total FROM cobrancas_log
       WHERE parcela_id = ? AND tipo = ? AND date(criado_em) = date('now')`
    )
    .get(parcelaId, tipo);
  return linha.total > 0;
}

// Envia felicitacoes de aniversario para os clientes cujo dia/mes de nascimento e hoje
async function verificarAniversariantes() {
  const hoje = new Date();
  const diaMesHoje = `${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

  const clientes = db
    .prepare(
      `SELECT * FROM clientes
       WHERE ativo = 1 AND data_nascimento IS NOT NULL
       AND strftime('%m-%d', data_nascimento) = ?`
    )
    .all(diaMesHoje);

  for (const cliente of clientes) {
    if (!cliente.telefone) continue;
    const mensagem = `Ola, ${cliente.nome}! A equipe da loja deseja a voce um feliz aniversario! Como presente, aproveite condicoes especiais na sua proxima compra. 🎉`;
    const resultado = await enviarMensagem(cliente.telefone, mensagem);
    registrarLog(cliente.id, 'aniversario', mensagem, resultado.sucesso);
  }
}

// Percorre as parcelas do fiado ainda pendentes e dispara lembrete individual
// 3 dias antes do vencimento e novamente no proprio dia do vencimento.
async function verificarLembretesDeParcelas() {
  const hoje = new Date();

  const parcelas = db
    .prepare(
      `SELECT p.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone
       FROM parcelas_fiado p
       JOIN clientes c ON c.id = p.cliente_id
       WHERE p.status = 'pendente'`
    )
    .all();

  for (const parcela of parcelas) {
    if (!parcela.cliente_telefone) continue;

    const partes = parcela.data_vencimento.split('-').map(Number);
    const vencimento = new Date(partes[0], partes[1] - 1, partes[2]);
    const diasParaVencer = diferencaEmDias(vencimento, hoje);
    const valor = parcela.valor.toFixed(2);
    const dataFormatada = vencimento.toLocaleDateString('pt-BR');
    const identificacaoParcela = `parcela ${parcela.numero_parcela}/${parcela.total_parcelas} da venda #${parcela.venda_id}`;

    if (diasParaVencer === 3 && !jaEnviadoHojeParcela(parcela.id, 'lembrete_parcela_3dias')) {
      const mensagem = `Ola, ${parcela.cliente_nome}! Passando para lembrar que a ${identificacaoParcela}, no valor de R$ ${valor}, vence em 3 dias, no dia ${dataFormatada}.`;
      const resultado = await enviarMensagem(parcela.cliente_telefone, mensagem);
      registrarLog(parcela.cliente_id, 'lembrete_parcela_3dias', mensagem, resultado.sucesso, {
        vendaId: parcela.venda_id,
        parcelaId: parcela.id,
      });
    }

    if (diasParaVencer === 0 && !jaEnviadoHojeParcela(parcela.id, 'lembrete_parcela_vencimento')) {
      const mensagem = `Ola, ${parcela.cliente_nome}! A ${identificacaoParcela}, no valor de R$ ${valor}, vence hoje. Contamos com voce para regularizar.`;
      const resultado = await enviarMensagem(parcela.cliente_telefone, mensagem);
      registrarLog(parcela.cliente_id, 'lembrete_parcela_vencimento', mensagem, resultado.sucesso, {
        vendaId: parcela.venda_id,
        parcelaId: parcela.id,
      });
    }
  }
}

// LEGADO: envia lembrete de pagamento para clientes cujo "dia de pagamento"
// geral (cadastro do cliente) esta a X dias de distancia. Mantido para
// clientes antigos que nao possuem parcelas cadastradas.
async function verificarLembretesDePagamento() {
  const hoje = new Date();
  const dataAlvo = new Date(hoje);
  dataAlvo.setDate(hoje.getDate() + DIAS_ANTES);
  const diaAlvo = dataAlvo.getDate();

  const clientes = db
    .prepare(
      `SELECT * FROM clientes
       WHERE ativo = 1 AND saldo_devedor > 0 AND dia_pagamento = ?`
    )
    .all(diaAlvo);

  for (const cliente of clientes) {
    if (!cliente.telefone) continue;
    const valor = cliente.saldo_devedor.toFixed(2);
    const mensagem = `Ola, ${cliente.nome}! Passando para lembrar que o seu pagamento de fiado no valor de R$ ${valor} vence em breve. Qualquer duvida estamos a disposicao.`;
    const resultado = await enviarMensagem(cliente.telefone, mensagem);
    registrarLog(cliente.id, 'lembrete_pagamento', mensagem, resultado.sucesso);
  }
}

// LEGADO: envia cobranca para clientes cujo fiado esta em atraso (dia_pagamento ja passou ha X dias)
async function verificarAtrasos() {
  const hoje = new Date();
  const diaHoje = hoje.getDate();

  const clientes = db
    .prepare(`SELECT * FROM clientes WHERE ativo = 1 AND saldo_devedor > 0 AND dia_pagamento IS NOT NULL`)
    .all();

  for (const cliente of clientes) {
    // Calcula ha quantos dias o "dia de pagamento" do mes atual ja passou
    let diasDeAtraso = diaHoje - cliente.dia_pagamento;
    if (diasDeAtraso < 0) continue; // ainda nao venceu neste mes

    if (diasDeAtraso === DIAS_ATRASO) {
      if (!cliente.telefone) continue;
      const valor = cliente.saldo_devedor.toFixed(2);
      const mensagem = `Ola, ${cliente.nome}! Identificamos que o pagamento do seu fiado no valor de R$ ${valor} esta em atraso. Por favor, regularize o quanto antes.`;
      const resultado = await enviarMensagem(cliente.telefone, mensagem);
      registrarLog(cliente.id, 'atraso', mensagem, resultado.sucesso);
    }
  }
}

// Executa a rotina completa (usado tambem manualmente por uma rota de teste, se necessario)
async function executarRotinaDeCobranca() {
  console.log('[cobranca] Iniciando rotina diaria de aniversarios e cobrancas...');
  try {
    await verificarAniversariantes();
    await verificarLembretesDeParcelas();
    await verificarLembretesDePagamento();
    await verificarAtrasos();
    console.log('[cobranca] Rotina finalizada com sucesso.');
  } catch (erro) {
    console.error('[cobranca] Erro ao executar rotina:', erro);
  }
}

// Agenda a rotina para rodar todos os dias no horario definido em COBRANCA_CRON
function iniciarCronJobs() {
  cron.schedule(EXPRESSAO_CRON, executarRotinaDeCobranca);
  console.log(`[cobranca] Cron job agendado com expressao "${EXPRESSAO_CRON}"`);
}

module.exports = { iniciarCronJobs, executarRotinaDeCobranca };
