// auth.js
// Funcoes utilitarias de autenticacao (hash de senha, geracao/validacao de JWT)
// e middlewares de protecao de rotas usados pelas rotas da API.

require('dotenv').config();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'segredo_padrao_trocar';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

// Gera o hash de uma senha em texto puro
function hashSenha(senha) {
  return bcrypt.hashSync(senha, 10);
}

// Compara uma senha em texto puro com o hash salvo no banco
function compararSenha(senha, hash) {
  return bcrypt.compareSync(senha, hash);
}

// Gera um token JWT a partir dos dados basicos do usuario
function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, nome: usuario.nome, email: usuario.email, role: usuario.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// Middleware: exige um token valido no header Authorization: Bearer <token>
function autenticar(req, res, next) {
  const cabecalho = req.headers.authorization;
  if (!cabecalho || !cabecalho.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token nao informado.' });
  }

  const token = cabecalho.substring('Bearer '.length);

  try {
    const dados = jwt.verify(token, JWT_SECRET);
    req.usuario = dados;
    next();
  } catch (erro) {
    return res.status(401).json({ erro: 'Token invalido ou expirado.' });
  }
}

// Middleware: exige que o usuario autenticado seja administrador
function somenteAdmin(req, res, next) {
  if (!req.usuario || req.usuario.role !== 'admin') {
    return res.status(403).json({ erro: 'Acao restrita a administradores.' });
  }
  next();
}

module.exports = {
  hashSenha,
  compararSenha,
  gerarToken,
  autenticar,
  somenteAdmin,
};
