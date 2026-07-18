// routes/auth.routes.js
// Rotas de autenticacao: login e cadastro de novos usuarios (somente admin).

const express = require('express');
const db = require('../db');
const { compararSenha, hashSenha, gerarToken, autenticar, somenteAdmin } = require('../auth');

const router = express.Router();

// POST /api/auth/login
// Recebe email e senha, retorna o token JWT se as credenciais forem validas.
router.post('/login', (req, res) => {
  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ erro: 'Informe email e senha.' });
  }

  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1').get(email);

  if (!usuario || !compararSenha(senha, usuario.senha_hash)) {
    return res.status(401).json({ erro: 'Email ou senha invalidos.' });
  }

  const token = gerarToken(usuario);
  res.json({
    token,
    usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, role: usuario.role },
  });
});

// GET /api/auth/me
// Retorna os dados do usuario autenticado (usado pelo frontend para restaurar a sessao)
router.get('/me', autenticar, (req, res) => {
  res.json({ usuario: req.usuario });
});

// POST /api/auth/usuarios
// Cria um novo usuario (vendedor ou admin). Somente administradores podem criar.
router.post('/usuarios', autenticar, somenteAdmin, (req, res) => {
  const { nome, email, senha, role } = req.body;

  if (!nome || !email || !senha) {
    return res.status(400).json({ erro: 'Nome, email e senha sao obrigatorios.' });
  }

  const jaExiste = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (jaExiste) {
    return res.status(409).json({ erro: 'Ja existe um usuario com este email.' });
  }

  const senhaHash = hashSenha(senha);
  const papel = role === 'admin' ? 'admin' : 'vendedor';

  const resultado = db
    .prepare('INSERT INTO usuarios (nome, email, senha_hash, role) VALUES (?, ?, ?, ?)')
    .run(nome, email, senhaHash, papel);

  res.status(201).json({ id: resultado.lastInsertRowid, nome, email, role: papel });
});

// GET /api/auth/usuarios - lista usuarios (somente admin)
router.get('/usuarios', autenticar, somenteAdmin, (req, res) => {
  const usuarios = db
    .prepare('SELECT id, nome, email, role, ativo, criado_em FROM usuarios ORDER BY nome')
    .all();
  res.json(usuarios);
});

module.exports = router;
