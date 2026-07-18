// db.js
// Responsavel por abrir o banco SQLite, criar as tabelas (se nao existirem),
// aplicar migracoes automaticas em bancos ja existentes (sem perder dados)
// e semear o usuario administrador padrao na primeira execucao.

require('dotenv').config();
const path = require('path');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');
const { calcularDataVencimentoFiado, formatarDataISO } = require('./services/vencimento');

const caminhoBanco = path.join(__dirname, 'estoque.db');
const db = new DatabaseSync(caminhoBanco);

// Melhora a performance e a integridade em gravacoes concorrentes
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// node:sqlite (modulo nativo do Node, sem necessidade de compilacao) nao
// possui o helper db.transaction() do better-sqlite3. Reimplementamos aqui
// com o mesmo formato de uso: const executar = db.transaction(fn); executar();
db.transaction = function transaction(fn) {
  return function executarTransacao(...args) {
    db.exec('BEGIN');
    try {
      const resultado = fn(...args);
      db.exec('COMMIT');
      return resultado;
    } catch (erro) {
      db.exec('ROLLBACK');
      throw erro;
    }
  };
};

// ---------------------------------------------------------------------------
// Criacao das tabelas (bancos novos ja nascem com o esquema completo)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'vendedor', -- 'admin' ou 'vendedor'
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    categoria TEXT,                 -- legado: categoria em texto livre (mantido so para compatibilidade)
    categoria_id INTEGER REFERENCES categorias(id),
    codigo_barras TEXT UNIQUE,
    tipo_preco TEXT NOT NULL DEFAULT 'fixo', -- 'fixo' ou 'aberto'
    preco REAL NOT NULL DEFAULT 0,           -- usado quando tipo_preco = 'fixo'
    controla_estoque INTEGER NOT NULL DEFAULT 1, -- 0 = nao controla estoque (quantidade nao e usada/descontada)
    estoque REAL NOT NULL DEFAULT 0,
    estoque_minimo REAL NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    telefone TEXT,
    email TEXT,
    data_nascimento TEXT,   -- formato YYYY-MM-DD
    dia_pagamento INTEGER,  -- dia do mes (1-31) preferido para pagamento do fiado (legado/geral)
    limite_credito REAL NOT NULL DEFAULT 0,
    saldo_devedor REAL NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER REFERENCES clientes(id),
    usuario_id INTEGER REFERENCES usuarios(id),
    data TEXT NOT NULL DEFAULT (datetime('now')),
    subtotal REAL NOT NULL,
    desconto_tipo TEXT DEFAULT 'nenhum',  -- 'valor', 'percentual' ou 'nenhum'
    desconto_valor REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    forma_pagamento_1 TEXT,
    valor_pagamento_1 REAL NOT NULL DEFAULT 0,
    forma_pagamento_2 TEXT,
    valor_pagamento_2 REAL NOT NULL DEFAULT 0,
    valor_fiado REAL NOT NULL DEFAULT 0,
    data_pagamento_tipo TEXT,   -- 'exata' ou 'recorrente' (somente quando ha valor_fiado > 0)
    data_pagamento_valor TEXT,  -- data 'YYYY-MM-DD' (exata) ou codigo do padrao recorrente
    status TEXT NOT NULL DEFAULT 'concluida', -- 'concluida' ou 'cancelada'
    cancelada_por INTEGER REFERENCES usuarios(id),
    cancelada_em TEXT
  );

  CREATE TABLE IF NOT EXISTS venda_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER NOT NULL REFERENCES vendas(id),
    produto_id INTEGER REFERENCES produtos(id),
    nome_produto TEXT NOT NULL,
    quantidade REAL NOT NULL,
    preco_unitario REAL NOT NULL,
    subtotal REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pagamentos_fiado (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    venda_id INTEGER REFERENCES vendas(id),
    parcela_id INTEGER REFERENCES parcelas_fiado(id),
    valor REAL NOT NULL,
    forma TEXT NOT NULL DEFAULT 'manual', -- 'manual', 'dinheiro', 'pix', 'cartao_debito', 'cartao_credito'
    referencia_pix TEXT,
    saldo_anterior REAL, -- saldo devedor do cliente antes deste pagamento (nulo em pagamentos antigos)
    saldo_apos REAL,     -- saldo devedor do cliente apos este pagamento (nulo em pagamentos antigos)
    data TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS parcelas_fiado (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER NOT NULL REFERENCES vendas(id),
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    numero_parcela INTEGER NOT NULL,
    total_parcelas INTEGER NOT NULL,
    valor REAL NOT NULL,
    data_vencimento TEXT NOT NULL, -- formato YYYY-MM-DD
    status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente', 'pago' ou 'cancelada'
    pago_em TEXT,
    forma_pagamento TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cobrancas_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id),
    venda_id INTEGER REFERENCES vendas(id),
    parcela_id INTEGER REFERENCES parcelas_fiado(id),
    tipo TEXT NOT NULL, -- 'aniversario', 'lembrete_pagamento', 'atraso', 'lembrete_parcela_3dias', 'lembrete_parcela_vencimento', 'recebimento_confirmado'
    mensagem TEXT,
    status TEXT NOT NULL DEFAULT 'enviado', -- 'enviado' ou 'erro'
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// Migracoes automaticas para bancos ja existentes (adiciona colunas novas
// sem apagar nenhum dado ja gravado)
// ---------------------------------------------------------------------------
function colunaExiste(tabela, coluna) {
  const colunas = db.prepare(`PRAGMA table_info(${tabela})`).all();
  return colunas.some((c) => c.name === coluna);
}

function migrarBanco() {
  // produtos.categoria_id (referencia para a nova tabela categorias)
  if (!colunaExiste('produtos', 'categoria_id')) {
    db.exec('ALTER TABLE produtos ADD COLUMN categoria_id INTEGER REFERENCES categorias(id)');
  }
  // produtos.controla_estoque (toggle de controle de estoque por produto)
  if (!colunaExiste('produtos', 'controla_estoque')) {
    db.exec('ALTER TABLE produtos ADD COLUMN controla_estoque INTEGER NOT NULL DEFAULT 1');
  }

  // vendas.data_pagamento_tipo / data_pagamento_valor (data combinada para o fiado)
  if (!colunaExiste('vendas', 'data_pagamento_tipo')) {
    db.exec('ALTER TABLE vendas ADD COLUMN data_pagamento_tipo TEXT');
  }
  if (!colunaExiste('vendas', 'data_pagamento_valor')) {
    db.exec('ALTER TABLE vendas ADD COLUMN data_pagamento_valor TEXT');
  }

  // cobrancas_log.venda_id (permite saber de qual venda especifica veio o lembrete)
  if (!colunaExiste('cobrancas_log', 'venda_id')) {
    db.exec('ALTER TABLE cobrancas_log ADD COLUMN venda_id INTEGER REFERENCES vendas(id)');
  }
  // cobrancas_log.parcela_id (lembretes agora sao disparados por parcela, nao por venda inteira)
  if (!colunaExiste('cobrancas_log', 'parcela_id')) {
    db.exec('ALTER TABLE cobrancas_log ADD COLUMN parcela_id INTEGER REFERENCES parcelas_fiado(id)');
  }

  // pagamentos_fiado.parcela_id / saldo_anterior / saldo_apos (rastreabilidade do pagamento)
  if (!colunaExiste('pagamentos_fiado', 'parcela_id')) {
    db.exec('ALTER TABLE pagamentos_fiado ADD COLUMN parcela_id INTEGER REFERENCES parcelas_fiado(id)');
  }
  if (!colunaExiste('pagamentos_fiado', 'saldo_anterior')) {
    db.exec('ALTER TABLE pagamentos_fiado ADD COLUMN saldo_anterior REAL');
  }
  if (!colunaExiste('pagamentos_fiado', 'saldo_apos')) {
    db.exec('ALTER TABLE pagamentos_fiado ADD COLUMN saldo_apos REAL');
  }

  // Migra os valores antigos de "produtos.categoria" (texto livre) para a
  // nova tabela "categorias" + "produtos.categoria_id", preservando o dado.
  const produtosSemCategoriaId = db
    .prepare(
      `SELECT DISTINCT categoria FROM produtos
       WHERE categoria IS NOT NULL AND TRIM(categoria) != '' AND categoria_id IS NULL`
    )
    .all();

  if (produtosSemCategoriaId.length > 0) {
    const inserirCategoria = db.prepare('INSERT OR IGNORE INTO categorias (nome) VALUES (?)');
    const buscarCategoriaId = db.prepare('SELECT id FROM categorias WHERE nome = ?');
    const atualizarProduto = db.prepare(
      'UPDATE produtos SET categoria_id = ? WHERE categoria = ? AND categoria_id IS NULL'
    );

    for (const linha of produtosSemCategoriaId) {
      const nomeCategoria = linha.categoria.trim();
      inserirCategoria.run(nomeCategoria);
      const categoria = buscarCategoriaId.get(nomeCategoria);
      if (categoria) {
        atualizarProduto.run(categoria.id, linha.categoria);
      }
    }
  }

  migrarVendasFiadoParaParcelas();
}

// Converte vendas fiado antigas (de antes do parcelamento existir) em uma
// parcela unica na tabela parcelas_fiado, preservando o historico e permitindo
// que o cron de cobranca e a tela de historico do cliente enxerguem tudo de
// forma unificada. So roda para vendas concluidas que ainda nao tem parcela.
function migrarVendasFiadoParaParcelas() {
  const vendasSemParcela = db
    .prepare(
      `SELECT v.* FROM vendas v
       WHERE v.status = 'concluida' AND v.valor_fiado > 0
       AND NOT EXISTS (SELECT 1 FROM parcelas_fiado p WHERE p.venda_id = v.id)`
    )
    .all();

  if (vendasSemParcela.length === 0) return;

  const inserirParcela = db.prepare(
    `INSERT INTO parcelas_fiado (venda_id, cliente_id, numero_parcela, total_parcelas, valor, data_vencimento, status)
     VALUES (?, ?, 1, 1, ?, ?, ?)`
  );
  const buscarCliente = db.prepare('SELECT saldo_devedor FROM clientes WHERE id = ?');

  for (const venda of vendasSemParcela) {
    if (!venda.cliente_id) continue; // nao deveria acontecer (fiado sempre tem cliente), mas protege a migracao

    // Tenta usar a data de pagamento combinada na propria venda (recurso antigo);
    // se a venda nao tiver essa informacao, assume 30 dias apos a venda como estimativa.
    let vencimento = calcularDataVencimentoFiado(venda);
    if (!vencimento) {
      vencimento = new Date(venda.data.replace(' ', 'T'));
      vencimento.setDate(vencimento.getDate() + 30);
    }

    const cliente = buscarCliente.get(venda.cliente_id);
    // Sem historico detalhado de pagamentos por venda, usamos o saldo devedor
    // atual do cliente como melhor estimativa: sem saldo -> considera quitado.
    const status = cliente && cliente.saldo_devedor <= 0 ? 'pago' : 'pendente';

    inserirParcela.run(venda.id, venda.cliente_id, venda.valor_fiado, formatarDataISO(vencimento), status);
  }
}

migrarBanco();

// ---------------------------------------------------------------------------
// Semeia o usuario administrador padrao (somente se ainda nao existir nenhum)
// ---------------------------------------------------------------------------
function semearAdmin() {
  const existeUsuario = db.prepare('SELECT COUNT(*) AS total FROM usuarios').get();
  if (existeUsuario.total > 0) return;

  const nome = process.env.ADMIN_NOME || 'Administrador';
  const email = process.env.ADMIN_EMAIL || 'admin@estoque.com';
  const senha = process.env.ADMIN_SENHA || 'admin123';
  const senhaHash = bcrypt.hashSync(senha, 10);

  db.prepare(
    'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES (?, ?, ?, ?)'
  ).run(nome, email, senhaHash, 'admin');

  console.log(`Usuario administrador criado -> email: ${email} / senha: ${senha}`);
}

semearAdmin();

module.exports = db;
