// routes/categorias.routes.js
// CRUD completo de categorias de produtos. Usado para popular o select de
// categoria no cadastro de produtos e o filtro por categoria no PDV.

const express = require('express');
const db = require('../db');
const { autenticar, somenteAdmin } = require('../auth');

const router = express.Router();

router.use(autenticar);

// GET /api/categorias?todos=1 - lista categorias (por padrao, so as ativas)
router.get('/', (req, res) => {
  const { todos } = req.query;
  const sql = todos
    ? 'SELECT * FROM categorias ORDER BY nome'
    : 'SELECT * FROM categorias WHERE ativo = 1 ORDER BY nome';
  res.json(db.prepare(sql).all());
});

// GET /api/categorias/:id
router.get('/:id', (req, res) => {
  const categoria = db.prepare('SELECT * FROM categorias WHERE id = ?').get(req.params.id);
  if (!categoria) return res.status(404).json({ erro: 'Categoria nao encontrada.' });
  res.json(categoria);
});

// POST /api/categorias - cria uma nova categoria (somente admin)
router.post('/', somenteAdmin, (req, res) => {
  const { nome } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'O nome da categoria e obrigatorio.' });
  }

  try {
    const resultado = db.prepare('INSERT INTO categorias (nome) VALUES (?)').run(nome.trim());
    const criada = db.prepare('SELECT * FROM categorias WHERE id = ?').get(resultado.lastInsertRowid);
    res.status(201).json(criada);
  } catch (erro) {
    if (String(erro.message).includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Ja existe uma categoria com este nome.' });
    }
    res.status(500).json({ erro: 'Erro ao criar categoria.' });
  }
});

// PUT /api/categorias/:id - renomeia/reativa uma categoria (somente admin)
router.put('/:id', somenteAdmin, (req, res) => {
  const categoria = db.prepare('SELECT * FROM categorias WHERE id = ?').get(req.params.id);
  if (!categoria) return res.status(404).json({ erro: 'Categoria nao encontrada.' });

  const { nome = categoria.nome, ativo = categoria.ativo } = req.body;
  if (!nome || !nome.trim()) {
    return res.status(400).json({ erro: 'O nome da categoria e obrigatorio.' });
  }

  try {
    db.prepare('UPDATE categorias SET nome = ?, ativo = ? WHERE id = ?').run(
      nome.trim(),
      ativo ? 1 : 0,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM categorias WHERE id = ?').get(req.params.id));
  } catch (erro) {
    if (String(erro.message).includes('UNIQUE')) {
      return res.status(409).json({ erro: 'Ja existe uma categoria com este nome.' });
    }
    res.status(500).json({ erro: 'Erro ao atualizar categoria.' });
  }
});

// DELETE /api/categorias/:id - exclusao logica (produtos ja cadastrados mantem a referencia)
router.delete('/:id', somenteAdmin, (req, res) => {
  const categoria = db.prepare('SELECT * FROM categorias WHERE id = ?').get(req.params.id);
  if (!categoria) return res.status(404).json({ erro: 'Categoria nao encontrada.' });

  db.prepare('UPDATE categorias SET ativo = 0 WHERE id = ?').run(req.params.id);
  res.json({ sucesso: true });
});

module.exports = router;
