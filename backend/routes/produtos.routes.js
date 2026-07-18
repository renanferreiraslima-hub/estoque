// routes/produtos.routes.js
// CRUD de produtos. Produtos podem ter preco fixo (definido no cadastro) ou
// preco aberto (informado manualmente no momento da venda, ex.: retalhos, promocoes).
// Cada produto pertence a uma categoria cadastrada (categoria_id) e pode ter
// o controle de estoque desligado (controla_estoque = 0), caso em que a
// quantidade nao e exibida nem descontada nas vendas.

const express = require('express');
const db = require('../db');
const { autenticar, somenteAdmin } = require('../auth');

const router = express.Router();

// Todas as rotas de produtos exigem usuario autenticado
router.use(autenticar);

const SELECT_COM_CATEGORIA = `
  SELECT p.*, c.nome AS categoria_nome
  FROM produtos p
  LEFT JOIN categorias c ON c.id = p.categoria_id
`;

// GET /api/produtos?busca=texto&categoria_id=x
// Lista produtos ativos, com filtro opcional por nome/codigo de barras e categoria
router.get('/', (req, res) => {
  const { busca, categoria_id, todos } = req.query;

  let sql = `${SELECT_COM_CATEGORIA} WHERE 1 = 1`;
  const params = [];

  if (!todos) {
    sql += ' AND p.ativo = 1';
  }
  if (busca) {
    sql += ' AND (p.nome LIKE ? OR p.codigo_barras LIKE ?)';
    params.push(`%${busca}%`, `%${busca}%`);
  }
  if (categoria_id) {
    sql += ' AND p.categoria_id = ?';
    params.push(categoria_id);
  }
  sql += ' ORDER BY p.nome';

  const produtos = db.prepare(sql).all(...params);
  res.json(produtos);
});

// GET /api/produtos/:id
router.get('/:id', (req, res) => {
  const produto = db.prepare(`${SELECT_COM_CATEGORIA} WHERE p.id = ?`).get(req.params.id);
  if (!produto) return res.status(404).json({ erro: 'Produto nao encontrado.' });
  res.json(produto);
});

// POST /api/produtos - cria um novo produto (somente admin)
router.post('/', somenteAdmin, (req, res) => {
  const { nome, categoria_id, codigo_barras, tipo_preco, preco, controla_estoque, estoque, estoque_minimo } = req.body;

  if (!nome) {
    return res.status(400).json({ erro: 'O nome do produto e obrigatorio.' });
  }
  const tipoPrecoValido = tipo_preco === 'aberto' ? 'aberto' : 'fixo';
  if (tipoPrecoValido === 'fixo' && (preco === undefined || preco === null || preco < 0)) {
    return res.status(400).json({ erro: 'Informe um preco valido para produtos de preco fixo.' });
  }

  const controlaEstoqueValido = controla_estoque === false || controla_estoque === 0 ? 0 : 1;

  try {
    const resultado = db
      .prepare(
        `INSERT INTO produtos (nome, categoria_id, codigo_barras, tipo_preco, preco, controla_estoque, estoque, estoque_minimo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nome,
        categoria_id || null,
        codigo_barras || null,
        tipoPrecoValido,
        tipoPrecoValido === 'fixo' ? Number(preco) : 0,
        controlaEstoqueValido,
        controlaEstoqueValido ? Number(estoque) || 0 : 0,
        controlaEstoqueValido ? Number(estoque_minimo) || 0 : 0
      );

    const produtoCriado = db
      .prepare(`${SELECT_COM_CATEGORIA} WHERE p.id = ?`)
      .get(resultado.lastInsertRowid);
    res.status(201).json(produtoCriado);
  } catch (erro) {
    if (String(erro.message).includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Ja existe um produto com este codigo de barras.' });
    }
    res.status(500).json({ erro: 'Erro ao criar produto.' });
  }
});

// PUT /api/produtos/:id - atualiza um produto (somente admin)
router.put('/:id', somenteAdmin, (req, res) => {
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
  if (!produto) return res.status(404).json({ erro: 'Produto nao encontrado.' });

  const {
    nome = produto.nome,
    categoria_id = produto.categoria_id,
    codigo_barras = produto.codigo_barras,
    tipo_preco = produto.tipo_preco,
    preco = produto.preco,
    controla_estoque,
    estoque = produto.estoque,
    estoque_minimo = produto.estoque_minimo,
    ativo = produto.ativo,
  } = req.body;

  const controlaEstoqueValido =
    controla_estoque === undefined ? produto.controla_estoque : controla_estoque ? 1 : 0;

  db.prepare(
    `UPDATE produtos
     SET nome = ?, categoria_id = ?, codigo_barras = ?, tipo_preco = ?, preco = ?,
         controla_estoque = ?, estoque = ?, estoque_minimo = ?, ativo = ?
     WHERE id = ?`
  ).run(
    nome,
    categoria_id || null,
    codigo_barras,
    tipo_preco === 'aberto' ? 'aberto' : 'fixo',
    Number(preco) || 0,
    controlaEstoqueValido,
    controlaEstoqueValido ? Number(estoque) || 0 : 0,
    controlaEstoqueValido ? Number(estoque_minimo) || 0 : 0,
    ativo ? 1 : 0,
    req.params.id
  );

  const atualizado = db.prepare(`${SELECT_COM_CATEGORIA} WHERE p.id = ?`).get(req.params.id);
  res.json(atualizado);
});

// DELETE /api/produtos/:id - exclusao logica (marca como inativo), somente admin
router.delete('/:id', somenteAdmin, (req, res) => {
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
  if (!produto) return res.status(404).json({ erro: 'Produto nao encontrado.' });

  db.prepare('UPDATE produtos SET ativo = 0 WHERE id = ?').run(req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
