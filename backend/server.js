// server.js
// Ponto de entrada do backend: configura o Express, registra as rotas da API,
// expõe o webhook do PIX, serve o frontend estatico e inicia o cron de cobrancas.

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const produtosRoutes = require('./routes/produtos.routes');
const categoriasRoutes = require('./routes/categorias.routes');
const clientesRoutes = require('./routes/clientes.routes');
const vendasRoutes = require('./routes/vendas.routes');
const { processarWebhookPix } = require('./services/pix');
const { iniciarCronJobs } = require('./services/cobranca');

const app = express();
console.log('PORT env:', process.env.PORT);

const PORTA = process.env.PORT || 3000;

app.use(cors({
  origin: function (origin, callback) {
    // Permite requisicoes sem origin (ex: Postman, curl)
    if (!origin) return callback(null, true);

    // Permite localhost em qualquer porta
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }

    // Permite qualquer subdominio do github.io
    if (origin.includes('github.io')) {
      return callback(null, true);
    }

    callback(new Error('Origem nao permitida pelo CORS'));
  },
  credentials: true
}));
app.use(express.json());

// --- rotas da API ----------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/produtos', produtosRoutes);
app.use('/api/categorias', categoriasRoutes);
app.use('/api/clientes', clientesRoutes);
app.use('/api/vendas', vendasRoutes);

// Webhook publico do provedor de PIX: da baixa automatica no fiado do cliente.
// Protegido por uma chave secreta simples enviada via header "x-webhook-secret".
app.post('/api/pix/webhook', (req, res) => {
  const segredoEsperado = process.env.PIX_WEBHOOK_SECRET;
  const segredoRecebido = req.headers['x-webhook-secret'];

  if (segredoEsperado && segredoRecebido !== segredoEsperado) {
    return res.status(401).json({ erro: 'Assinatura do webhook invalida.' });
  }

  const resultado = processarWebhookPix(req.body || {});
  if (!resultado.sucesso) {
    return res.status(400).json(resultado);
  }
  res.json(resultado);
});

// --- frontend estatico (PWA) ------------------------------------------------
const pastaFrontend = path.join(__dirname, '..', 'frontend');
app.use(express.static(pastaFrontend));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(pastaFrontend, 'index.html'));
});

// --- tratamento de erros genericos ------------------------------------------
app.use((erro, req, res, next) => {
  console.error('Erro nao tratado:', erro);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

app.listen(PORTA, '0.0.0.0', () => {
  console.log(`Servidor Estoque rodando na porta ${PORTA}`);
  iniciarCronJobs();
});
