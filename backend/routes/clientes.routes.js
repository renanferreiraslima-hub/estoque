// routes/clientes.routes.js
// CRUD de clientes, controle de limite de credito (fiado) e registro de
// pagamentos manuais de fiado (baixa de saldo devedor feita na loja).

const express = require('express');
const db = require('../db');
const { autenticar, somenteAdmin } = require('../auth');
const { enviarMensagem } = require('../services/whatsapp');

const router = express.Router();

const FORMAS_RECEBIMENTO_VALIDAS = ['dinheiro', 'pix', 'cartao_debito', 'cartao_credito', 'manual'];

router.use(autenticar);

// GET /api/clientes?busca=texto
router.get('/', (req, res) => {
  const { busca, todos } = req.query;

  let sql = 'SELECT * FROM clientes WHERE 1 = 1';
  const params = [];

  if (!todos) {
    sql += ' AND ativo = 1';
  }
  if (busca) {
    sql += ' AND (nome LIKE ? OR telefone LIKE ? OR email LIKE ?)';
    params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
  }
  sql += ' ORDER BY nome';

  res.json(db.prepare(sql).all(...params));
});

// GET /api/clientes/:id
router.get('/:id', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente nao encontrado.' });
  res.json(cliente);
});

// GET /api/clientes/:id/fiado - saldo devedor, credito disponivel e historico de pagamentos
router.get('/:id/fiado', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente nao encontrado.' });

  const pagamentos = db
    .prepare('SELECT * FROM pagamentos_fiado WHERE cliente_id = ? ORDER BY data DESC')
    .all(req.params.id);

  const vendasFiado = db
    .prepare(
      `SELECT id, data, total, valor_fiado, status FROM vendas
       WHERE cliente_id = ? AND valor_fiado > 0 ORDER BY data DESC`
    )
    .all(req.params.id);

  res.json({
    saldo_devedor: cliente.saldo_devedor,
    limite_credito: cliente.limite_credito,
    credito_disponivel: Math.max(0, cliente.limite_credito - cliente.saldo_devedor),
    pagamentos,
    vendas: vendasFiado,
  });
});

// POST /api/clientes - cria um novo cliente
router.post('/', (req, res) => {
  const { nome, telefone, email, data_nascimento, dia_pagamento, limite_credito } = req.body;

  if (!nome) {
    return res.status(400).json({ erro: 'O nome do cliente e obrigatorio.' });
  }

  const resultado = db
    .prepare(
      `INSERT INTO clientes (nome, telefone, email, data_nascimento, dia_pagamento, limite_credito)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      nome,
      telefone || null,
      email || null,
      data_nascimento || null,
      dia_pagamento ? Number(dia_pagamento) : null,
      Number(limite_credito) || 0
    );

  const criado = db.prepare('SELECT * FROM clientes WHERE id = ?').get(resultado.lastInsertRowid);
  res.status(201).json(criado);
});

// PUT /api/clientes/:id - atualiza dados cadastrais do cliente
router.put('/:id', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente nao encontrado.' });

  const {
    nome = cliente.nome,
    telefone = cliente.telefone,
    email = cliente.email,
    data_nascimento = cliente.data_nascimento,
    dia_pagamento = cliente.dia_pagamento,
    limite_credito = cliente.limite_credito,
    ativo = cliente.ativo,
  } = req.body;

  db.prepare(
    `UPDATE clientes
     SET nome = ?, telefone = ?, email = ?, data_nascimento = ?, dia_pagamento = ?, limite_credito = ?, ativo = ?
     WHERE id = ?`
  ).run(
    nome,
    telefone,
    email,
    data_nascimento,
    dia_pagamento ? Number(dia_pagamento) : null,
    Number(limite_credito) || 0,
    ativo ? 1 : 0,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id));
});

// DELETE /api/clientes/:id - exclusao logica (somente admin, para preservar historico de vendas)
router.delete('/:id', somenteAdmin, (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente nao encontrado.' });

  db.prepare('UPDATE clientes SET ativo = 0 WHERE id = ?').run(req.params.id);
  res.json({ sucesso: true });
});

// Envia a confirmacao de recebimento por WhatsApp e registra no log de cobrancas.
// Compartilhado entre o pagamento generico e o pagamento de uma parcela especifica.
async function notificarRecebimento(cliente, valorNumerico, novoSaldo) {
  if (!cliente.telefone) return;
  const mensagem = `Ola, ${cliente.nome}! Confirmamos o recebimento de R$ ${valorNumerico.toFixed(2)} referente ao seu fiado. Saldo devedor atual: R$ ${novoSaldo.toFixed(2)}. Obrigado!`;
  const resultado = await enviarMensagem(cliente.telefone, mensagem);
  db.prepare(
    `INSERT INTO cobrancas_log (cliente_id, tipo, mensagem, status) VALUES (?, 'recebimento_confirmado', ?, ?)`
  ).run(cliente.id, mensagem, resultado.sucesso ? 'enviado' : 'erro');
}

// POST /api/clientes/:id/pagamento - registra a baixa de um pagamento do fiado
// (usado pela tela de Recebimentos e pelo atalho de pagamento na tela de Clientes).
// Alem de dar baixa no saldo devedor, envia uma confirmacao automatica por
// WhatsApp ao cliente informando o valor recebido e o saldo restante.
router.post('/:id/pagamento', async (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente nao encontrado.' });

  const { valor, forma = 'manual' } = req.body;
  const valorNumerico = Number(valor);

  if (!valorNumerico || valorNumerico <= 0) {
    return res.status(400).json({ erro: 'Informe um valor de pagamento valido.' });
  }
  if (!FORMAS_RECEBIMENTO_VALIDAS.includes(forma)) {
    return res.status(400).json({ erro: 'Forma de pagamento invalida.' });
  }

  const saldoAnterior = cliente.saldo_devedor;

  const transacao = db.transaction(() => {
    const novoSaldo = Math.max(0, saldoAnterior - valorNumerico);
    db.prepare('UPDATE clientes SET saldo_devedor = ? WHERE id = ?').run(novoSaldo, cliente.id);
    db.prepare(
      `INSERT INTO pagamentos_fiado (cliente_id, valor, forma, saldo_anterior, saldo_apos) VALUES (?, ?, ?, ?, ?)`
    ).run(cliente.id, valorNumerico, forma, saldoAnterior, novoSaldo);
    return novoSaldo;
  });

  const novoSaldo = transacao();
  const dataRecebimento = new Date().toISOString();

  // Notifica o cliente via WhatsApp (best-effort: nao falha a requisicao se o envio der erro)
  await notificarRecebimento(cliente, valorNumerico, novoSaldo);

  res.json({
    sucesso: true,
    cliente_nome: cliente.nome,
    valor_pago: valorNumerico,
    forma,
    data: dataRecebimento,
    saldo_anterior: saldoAnterior,
    novo_saldo_devedor: novoSaldo,
  });
});

// POST /api/clientes/:clienteId/parcelas/:parcelaId/pagamento - registra o
// pagamento de UMA parcela especifica do fiado (usado no detalhe do cliente,
// ao clicar numa parcela pendente na timeline).
router.post('/:clienteId/parcelas/:parcelaId/pagamento', async (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.clienteId);
  if (!cliente) return res.status(404).json({ erro: 'Cliente nao encontrado.' });

  const parcela = db
    .prepare('SELECT * FROM parcelas_fiado WHERE id = ? AND cliente_id = ?')
    .get(req.params.parcelaId, req.params.clienteId);
  if (!parcela) return res.status(404).json({ erro: 'Parcela nao encontrada.' });
  if (parcela.status !== 'pendente') {
    return res.status(400).json({ erro: 'Esta parcela ja foi paga ou cancelada.' });
  }

  const { forma = 'manual' } = req.body;
  const valorNumerico = req.body.valor !== undefined ? Number(req.body.valor) : parcela.valor;

  if (!valorNumerico || valorNumerico <= 0) {
    return res.status(400).json({ erro: 'Informe um valor de pagamento valido.' });
  }
  if (!FORMAS_RECEBIMENTO_VALIDAS.includes(forma)) {
    return res.status(400).json({ erro: 'Forma de pagamento invalida.' });
  }

  const saldoAnterior = cliente.saldo_devedor;

  const transacao = db.transaction(() => {
    const novoSaldo = Math.max(0, saldoAnterior - valorNumerico);
    db.prepare('UPDATE clientes SET saldo_devedor = ? WHERE id = ?').run(novoSaldo, cliente.id);
    db.prepare(
      `INSERT INTO pagamentos_fiado (cliente_id, venda_id, parcela_id, valor, forma, saldo_anterior, saldo_apos)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(cliente.id, parcela.venda_id, parcela.id, valorNumerico, forma, saldoAnterior, novoSaldo);
    db.prepare(
      `UPDATE parcelas_fiado SET status = 'pago', pago_em = datetime('now'), forma_pagamento = ? WHERE id = ?`
    ).run(forma, parcela.id);
    return novoSaldo;
  });

  const novoSaldo = transacao();
  const dataRecebimento = new Date().toISOString();

  await notificarRecebimento(cliente, valorNumerico, novoSaldo);

  res.json({
    sucesso: true,
    cliente_nome: cliente.nome,
    valor_pago: valorNumerico,
    forma,
    data: dataRecebimento,
    saldo_anterior: saldoAnterior,
    novo_saldo_devedor: novoSaldo,
    parcela_id: parcela.id,
  });
});

// GET /api/clientes/:id/historico - timeline unificada (compras, pagamentos e
// parcelas do fiado) + resumo (total comprado, total pago, saldo devedor,
// proxima parcela a vencer). Usado na tela de detalhes do cliente.
router.get('/:id/historico', (req, res) => {
  const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(req.params.id);
  if (!cliente) return res.status(404).json({ erro: 'Cliente nao encontrado.' });

  const vendas = db
    .prepare(
      `SELECT v.*, u.nome AS usuario_nome,
        (SELECT COUNT(*) FROM venda_itens vi WHERE vi.venda_id = v.id) AS total_itens,
        (SELECT GROUP_CONCAT(vi.nome_produto, ', ') FROM venda_itens vi WHERE vi.venda_id = v.id) AS itens_resumo
       FROM vendas v
       LEFT JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.cliente_id = ?
       ORDER BY v.data DESC`
    )
    .all(req.params.id);

  const pagamentos = db
    .prepare('SELECT * FROM pagamentos_fiado WHERE cliente_id = ? ORDER BY data DESC')
    .all(req.params.id);

  const parcelas = db
    .prepare('SELECT * FROM parcelas_fiado WHERE cliente_id = ? ORDER BY data_vencimento')
    .all(req.params.id);

  const hojeISO = new Date().toISOString().slice(0, 10);
  const parcelasComStatus = parcelas.map((p) => ({
    ...p,
    status_exibicao: p.status === 'pendente' && p.data_vencimento < hojeISO ? 'atrasado' : p.status,
  }));

  // --- monta a timeline unificada, ordenada da mais recente para a mais antiga ---
  const timeline = [
    ...vendas.map((v) => ({
      tipo: 'compra',
      data: v.data,
      venda_id: v.id,
      total: v.total,
      valor_fiado: v.valor_fiado,
      status: v.status,
      forma_pagamento_1: v.forma_pagamento_1,
      forma_pagamento_2: v.forma_pagamento_2,
      usuario_nome: v.usuario_nome,
      itens_resumo: v.itens_resumo,
      total_itens: v.total_itens,
    })),
    ...pagamentos.map((p) => ({
      tipo: 'pagamento',
      data: p.data,
      pagamento_id: p.id,
      valor: p.valor,
      forma: p.forma,
      saldo_anterior: p.saldo_anterior,
      saldo_apos: p.saldo_apos,
    })),
    ...parcelasComStatus.map((p) => ({
      tipo: 'parcela',
      data: p.data_vencimento,
      parcela_id: p.id,
      venda_id: p.venda_id,
      numero_parcela: p.numero_parcela,
      total_parcelas: p.total_parcelas,
      valor: p.valor,
      status: p.status_exibicao,
    })),
  ].sort((a, b) => (a.data < b.data ? 1 : a.data > b.data ? -1 : 0));

  const totalComprado = vendas
    .filter((v) => v.status === 'concluida')
    .reduce((soma, v) => soma + v.total, 0);
  const totalPago = pagamentos.reduce((soma, p) => soma + p.valor, 0);
  const proximaParcela = parcelasComStatus
    .filter((p) => p.status === 'pendente' || p.status === 'atrasado')
    .sort((a, b) => (a.data_vencimento > b.data_vencimento ? 1 : -1))[0] || null;

  res.json({
    resumo: {
      total_comprado: totalComprado,
      total_pago: totalPago,
      saldo_devedor: cliente.saldo_devedor,
      proxima_parcela: proximaParcela
        ? { data_vencimento: proximaParcela.data_vencimento, valor: proximaParcela.valor, status: proximaParcela.status }
        : null,
    },
    timeline,
  });
});

module.exports = router;
