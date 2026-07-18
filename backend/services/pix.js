// services/pix.js
// Processa notificacoes (webhook) recebidas do provedor de PIX e da baixa
// automatica no fiado do cliente correspondente.
//
// O provedor de PIX deve ser configurado para chamar POST /api/pix/webhook
// enviando, no minimo, o valor pago e uma referencia que identifique o cliente
// (ex.: txid contendo o id do cliente, ou o campo "infoAdicionais").
// Como cada provedor tem um formato proprio de payload, a funcao abaixo aceita
// alguns formatos comuns e pode ser adaptada facilmente.

const db = require('../db');

// Tenta descobrir o id do cliente a partir do payload recebido do webhook.
// Convencao adotada: o txid/identificador da cobranca deve seguir o padrao
// "cliente-<id>-..." (ex.: gerado no momento em que a cobranca PIX foi criada).
function extrairClienteId(payload) {
  const referencia =
    payload.txid || payload.referencia || payload.identificador || payload.infoAdicionais || '';

  const match = String(referencia).match(/cliente-(\d+)/i);
  if (match) return Number(match[1]);

  // Alguns provedores permitem enviar metadados customizados diretamente
  if (payload.clienteId) return Number(payload.clienteId);

  return null;
}

// Extrai o valor pago do payload (formatos comuns: "valor", "amount", "valorPago")
function extrairValor(payload) {
  const valor = payload.valor ?? payload.amount ?? payload.valorPago;
  return valor ? Number(valor) : null;
}

// Processa o webhook do PIX: identifica o cliente, abate o valor do saldo
// devedor (fiado) e registra o pagamento no historico.
function processarWebhookPix(payload) {
  const clienteId = extrairClienteId(payload);
  const valor = extrairValor(payload);
  const referencia = payload.txid || payload.referencia || null;

  if (!clienteId) {
    return { sucesso: false, erro: 'Nao foi possivel identificar o cliente na notificacao PIX.' };
  }
  if (!valor || valor <= 0) {
    return { sucesso: false, erro: 'Valor do pagamento invalido ou ausente.' };
  }

  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(clienteId);
  if (!cliente) {
    return { sucesso: false, erro: `Cliente ${clienteId} nao encontrado.` };
  }

  const transacao = db.transaction(() => {
    const novoSaldo = Math.max(0, cliente.saldo_devedor - valor);
    db.prepare('UPDATE clientes SET saldo_devedor = ? WHERE id = ?').run(novoSaldo, clienteId);

    db.prepare(
      `INSERT INTO pagamentos_fiado (cliente_id, valor, forma, referencia_pix)
       VALUES (?, ?, 'pix', ?)`
    ).run(clienteId, valor, referencia);

    return novoSaldo;
  });

  const novoSaldo = transacao();

  return {
    sucesso: true,
    clienteId,
    valorPago: valor,
    novoSaldoDevedor: novoSaldo,
  };
}

module.exports = { processarWebhookPix };
