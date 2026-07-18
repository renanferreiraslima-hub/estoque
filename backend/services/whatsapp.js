// services/whatsapp.js
// Integracao com a Evolution API para envio de mensagens de WhatsApp
// (usado pelas cobrancas automaticas e avisos de aniversario).

require('dotenv').config();
const axios = require('axios');

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'estoque';

// Remove caracteres nao numericos e garante o formato esperado pela Evolution API
function normalizarNumero(numero) {
  const apenasDigitos = String(numero || '').replace(/\D/g, '');
  // Se o numero nao tiver o codigo do pais (Brasil = 55), adiciona automaticamente
  if (apenasDigitos.length <= 11) {
    return `55${apenasDigitos}`;
  }
  return apenasDigitos;
}

// Envia uma mensagem de texto simples via Evolution API
// Retorna { sucesso: true } ou { sucesso: false, erro }
async function enviarMensagem(numero, mensagem) {
  const numeroFormatado = normalizarNumero(numero);

  if (!numeroFormatado) {
    return { sucesso: false, erro: 'Numero de telefone invalido.' };
  }

  try {
    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        number: numeroFormatado,
        text: mensagem,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          apikey: EVOLUTION_API_KEY,
        },
        timeout: 15000,
      }
    );
    return { sucesso: true };
  } catch (erro) {
    const detalhe = erro.response?.data || erro.message;
    console.error('Erro ao enviar mensagem via Evolution API:', detalhe);
    return { sucesso: false, erro: detalhe };
  }
}

module.exports = { enviarMensagem, normalizarNumero };
