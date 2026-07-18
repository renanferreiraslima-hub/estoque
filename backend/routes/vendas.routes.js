// routes/vendas.routes.js
// Rotas do PDV: criacao de vendas (carrinho, desconto em R$/%, pagamento
// dividido em ate 2 formas, fiado parcelado com data por parcela e limite de
// credito) e exclusao de venda (somente admin, com restauracao automatica do
// estoque, do fiado e cancelamento das parcelas pendentes).

const express = require('express');
const db = require('../db');
const { autenticar, somenteAdmin } = require('../auth');

const router = express.Router();

router.use(autenticar);

const EPSILON = 0.01; // tolerancia para comparacao de valores em reais

// GET /api/vendas?cliente_id=&status=&de=&ate=
router.get('/', (req, res) => {
  const { cliente_id, status, de, ate } = req.query;

  let sql = `
    SELECT v.*, c.nome AS cliente_nome, u.nome AS usuario_nome
    FROM vendas v
    LEFT JOIN clientes c ON c.id = v.cliente_id
    LEFT JOIN usuarios u ON u.id = v.usuario_id
    WHERE 1 = 1
  `;
  const params = [];

  if (cliente_id) {
    sql += ' AND v.cliente_id = ?';
    params.push(cliente_id);
  }
  if (status) {
    sql += ' AND v.status = ?';
    params.push(status);
  }
  if (de) {
    sql += ' AND date(v.data) >= date(?)';
    params.push(de);
  }
  if (ate) {
    sql += ' AND date(v.data) <= date(?)';
    params.push(ate);
  }
  sql += ' ORDER BY v.data DESC';

  res.json(db.prepare(sql).all(...params));
});

// GET /api/vendas/:id - detalhe completo (itens e parcelas do fiado inclusos),
// usado tambem para reimprimir o cupom e no detalhe da timeline do cliente
router.get('/:id', (req, res) => {
  const venda = db
    .prepare(
      `SELECT v.*, c.nome AS cliente_nome, u.nome AS usuario_nome
       FROM vendas v
       LEFT JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.id = ?`
    )
    .get(req.params.id);

  if (!venda) return res.status(404).json({ erro: 'Venda nao encontrada.' });

  const itens = db.prepare('SELECT * FROM venda_itens WHERE venda_id = ?').all(req.params.id);
  const parcelas = db
    .prepare('SELECT * FROM parcelas_fiado WHERE venda_id = ? ORDER BY numero_parcela')
    .all(req.params.id);
  res.json({ ...venda, itens, parcelas });
});

// POST /api/vendas - registra uma nova venda
router.post('/', (req, res) => {
  const { cliente_id, itens, desconto_tipo = 'nenhum', desconto_valor = 0, pagamentos = [], parcelas = [] } = req.body;

  // --- validacoes basicas -----------------------------------------------
  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'A venda precisa ter ao menos um item.' });
  }
  if (!Array.isArray(pagamentos) || pagamentos.length === 0) {
    return res.status(400).json({ erro: 'Informe ao menos uma forma de pagamento.' });
  }
  if (pagamentos.length > 2) {
    return res.status(400).json({ erro: 'O pagamento pode ser dividido em no maximo 2 formas.' });
  }
  if (!['valor', 'percentual', 'nenhum'].includes(desconto_tipo)) {
    return res.status(400).json({ erro: 'Tipo de desconto invalido.' });
  }

  // --- monta os itens, valida estoque e calcula o subtotal ---------------
  const itensProcessados = [];
  let subtotal = 0;

  for (const item of itens) {
    const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(item.produto_id);
    if (!produto || !produto.ativo) {
      return res.status(400).json({ erro: `Produto ${item.produto_id} nao encontrado ou inativo.` });
    }

    const quantidade = Number(item.quantidade);
    if (!quantidade || quantidade <= 0) {
      return res.status(400).json({ erro: `Quantidade invalida para o produto ${produto.nome}.` });
    }

    let precoUnitario;
    if (produto.tipo_preco === 'aberto') {
      precoUnitario = Number(item.preco_unitario);
      if (!precoUnitario || precoUnitario <= 0) {
        return res.status(400).json({ erro: `Informe o preco para o produto de preco aberto "${produto.nome}".` });
      }
    } else {
      precoUnitario = produto.preco;
    }

    // Produtos com "controla_estoque" desligado podem ser vendidos em qualquer
    // quantidade, sem checar nem descontar o campo estoque.
    if (produto.controla_estoque && produto.estoque < quantidade) {
      return res.status(400).json({ erro: `Estoque insuficiente para "${produto.nome}" (disponivel: ${produto.estoque}).` });
    }

    const subtotalItem = Number((precoUnitario * quantidade).toFixed(2));
    subtotal += subtotalItem;

    itensProcessados.push({
      produto,
      quantidade,
      preco_unitario: precoUnitario,
      subtotal: subtotalItem,
    });
  }
  subtotal = Number(subtotal.toFixed(2));

  // --- calcula o desconto e o total ---------------------------------------
  let valorDesconto = 0;
  if (desconto_tipo === 'valor') {
    valorDesconto = Math.min(Number(desconto_valor) || 0, subtotal);
  } else if (desconto_tipo === 'percentual') {
    const percentual = Math.min(Number(desconto_valor) || 0, 100);
    valorDesconto = Number(((subtotal * percentual) / 100).toFixed(2));
  }
  const total = Number((subtotal - valorDesconto).toFixed(2));

  // --- valida os pagamentos e identifica se ha fiado ----------------------
  let cliente = null;
  if (cliente_id) {
    cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(cliente_id);
    if (!cliente) return res.status(400).json({ erro: 'Cliente nao encontrado.' });
  }

  let valorFiado = 0;
  let somaPagamentos = 0;
  for (const pagamento of pagamentos) {
    const valor = Number(pagamento.valor);
    if (!pagamento.forma || !valor || valor <= 0) {
      return res.status(400).json({ erro: 'Cada pagamento precisa de forma e valor validos.' });
    }
    somaPagamentos += valor;
    if (pagamento.forma === 'fiado') {
      valorFiado += valor;
    }
  }
  somaPagamentos = Number(somaPagamentos.toFixed(2));

  if (Math.abs(somaPagamentos - total) > EPSILON) {
    return res.status(400).json({
      erro: `A soma dos pagamentos (R$ ${somaPagamentos.toFixed(2)}) precisa ser igual ao total da venda (R$ ${total.toFixed(2)}).`,
    });
  }

  // --- valida as parcelas do fiado (numero de vezes + data de cada uma) ---
  let parcelasValidas = [];
  if (valorFiado > 0) {
    if (!cliente) {
      return res.status(400).json({ erro: 'Selecione um cliente para vender fiado.' });
    }
    const creditoDisponivel = cliente.limite_credito - cliente.saldo_devedor;
    if (valorFiado > creditoDisponivel + EPSILON) {
      return res.status(400).json({
        erro: `Limite de credito insuficiente. Disponivel: R$ ${creditoDisponivel.toFixed(2)}, solicitado: R$ ${valorFiado.toFixed(2)}.`,
      });
    }

    if (!Array.isArray(parcelas) || parcelas.length === 0) {
      return res.status(400).json({ erro: 'Informe em quantas vezes e quando o cliente vai pagar o fiado.' });
    }
    if (parcelas.length > 12) {
      return res.status(400).json({ erro: 'O fiado pode ser parcelado em no maximo 12 vezes.' });
    }

    let somaParcelas = 0;
    const numerosVistos = new Set();
    for (const parcela of parcelas) {
      const numero = Number(parcela.numero_parcela);
      const valor = Number(parcela.valor);
      if (!numero || numero < 1 || numerosVistos.has(numero)) {
        return res.status(400).json({ erro: 'Numero de parcela invalido ou repetido.' });
      }
      if (!valor || valor <= 0) {
        return res.status(400).json({ erro: `Informe um valor valido para a parcela ${numero}.` });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(parcela.data_vencimento || '')) {
        return res.status(400).json({ erro: `Informe uma data de vencimento valida para a parcela ${numero}.` });
      }
      numerosVistos.add(numero);
      somaParcelas += valor;
      parcelasValidas.push({ numero_parcela: numero, valor, data_vencimento: parcela.data_vencimento });
    }
    somaParcelas = Number(somaParcelas.toFixed(2));

    if (Math.abs(somaParcelas - valorFiado) > EPSILON) {
      return res.status(400).json({
        erro: `A soma das parcelas (R$ ${somaParcelas.toFixed(2)}) precisa ser igual ao valor no fiado (R$ ${valorFiado.toFixed(2)}).`,
      });
    }

    parcelasValidas.sort((a, b) => a.numero_parcela - b.numero_parcela);
  }

  const formaPagamento1 = pagamentos[0]?.forma || null;
  const valorPagamento1 = Number(pagamentos[0]?.valor) || 0;
  const formaPagamento2 = pagamentos[1]?.forma || null;
  const valorPagamento2 = Number(pagamentos[1]?.valor) || 0;

  // --- persiste a venda em uma unica transacao ----------------------------
  const criarVenda = db.transaction(() => {
    const resultadoVenda = db
      .prepare(
        `INSERT INTO vendas
          (cliente_id, usuario_id, subtotal, desconto_tipo, desconto_valor, total,
           forma_pagamento_1, valor_pagamento_1, forma_pagamento_2, valor_pagamento_2, valor_fiado, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'concluida')`
      )
      .run(
        cliente_id || null,
        req.usuario.id,
        subtotal,
        desconto_tipo,
        valorDesconto,
        total,
        formaPagamento1,
        valorPagamento1,
        formaPagamento2,
        valorPagamento2,
        valorFiado
      );

    const vendaId = resultadoVenda.lastInsertRowid;

    const inserirItem = db.prepare(
      `INSERT INTO venda_itens (venda_id, produto_id, nome_produto, quantidade, preco_unitario, subtotal)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const baixarEstoque = db.prepare('UPDATE produtos SET estoque = estoque - ? WHERE id = ?');

    for (const item of itensProcessados) {
      inserirItem.run(vendaId, item.produto.id, item.produto.nome, item.quantidade, item.preco_unitario, item.subtotal);
      if (item.produto.controla_estoque) {
        baixarEstoque.run(item.quantidade, item.produto.id);
      }
    }

    if (valorFiado > 0) {
      db.prepare('UPDATE clientes SET saldo_devedor = saldo_devedor + ? WHERE id = ?').run(valorFiado, cliente_id);

      const inserirParcela = db.prepare(
        `INSERT INTO parcelas_fiado (venda_id, cliente_id, numero_parcela, total_parcelas, valor, data_vencimento, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pendente')`
      );
      for (const parcela of parcelasValidas) {
        inserirParcela.run(vendaId, cliente_id, parcela.numero_parcela, parcelasValidas.length, parcela.valor, parcela.data_vencimento);
      }
    }

    return vendaId;
  });

  const vendaId = criarVenda();
  const vendaCriada = db.prepare('SELECT * FROM vendas WHERE id = ?').get(vendaId);
  const itensSalvos = db.prepare('SELECT * FROM venda_itens WHERE venda_id = ?').all(vendaId);
  const parcelasSalvas = db.prepare('SELECT * FROM parcelas_fiado WHERE venda_id = ? ORDER BY numero_parcela').all(vendaId);

  res.status(201).json({ ...vendaCriada, itens: itensSalvos, parcelas: parcelasSalvas });
});

// DELETE /api/vendas/:id - cancela a venda, restaura o estoque, estorna o
// fiado e cancela as parcelas pendentes dessa venda.
// Restrito a administradores para evitar que vendedores apaguem vendas indevidamente.
router.delete('/:id', somenteAdmin, (req, res) => {
  const venda = db.prepare('SELECT * FROM vendas WHERE id = ?').get(req.params.id);
  if (!venda) return res.status(404).json({ erro: 'Venda nao encontrada.' });
  if (venda.status === 'cancelada') {
    return res.status(400).json({ erro: 'Esta venda ja esta cancelada.' });
  }

  const itens = db
    .prepare(
      `SELECT vi.*, p.controla_estoque
       FROM venda_itens vi
       LEFT JOIN produtos p ON p.id = vi.produto_id
       WHERE vi.venda_id = ?`
    )
    .all(req.params.id);

  const cancelarVenda = db.transaction(() => {
    const restaurarEstoque = db.prepare('UPDATE produtos SET estoque = estoque + ? WHERE id = ?');
    for (const item of itens) {
      if (item.produto_id && item.controla_estoque) {
        restaurarEstoque.run(item.quantidade, item.produto_id);
      }
    }

    if (venda.valor_fiado > 0 && venda.cliente_id) {
      db.prepare('UPDATE clientes SET saldo_devedor = MAX(0, saldo_devedor - ?) WHERE id = ?').run(
        venda.valor_fiado,
        venda.cliente_id
      );
      db.prepare(
        `UPDATE parcelas_fiado SET status = 'cancelada' WHERE venda_id = ? AND status = 'pendente'`
      ).run(req.params.id);
    }

    db.prepare(
      `UPDATE vendas SET status = 'cancelada', cancelada_por = ?, cancelada_em = datetime('now') WHERE id = ?`
    ).run(req.usuario.id, req.params.id);
  });

  cancelarVenda();

  res.json({ sucesso: true, mensagem: 'Venda cancelada, estoque e fiado restaurados.' });
});

module.exports = router;
