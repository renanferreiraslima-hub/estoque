// services/vencimento.js
// Funcoes puras (sem dependencia do banco) para calcular datas de vencimento.
// Extraido para um modulo proprio para poder ser usado tanto por db.js
// (na migracao de vendas fiado antigas para a tabela parcelas_fiado) quanto
// por services/cobranca.js (nos lembretes automaticos), sem criar
// dependencia circular entre os dois.

// Codigos aceitos para a data de pagamento recorrente do fiado (usados nas
// vendas antigas, anteriores ao parcelamento com data por parcela).
const CODIGOS_RECORRENTES = [
  'dia_05',
  'dia_10',
  'dia_15',
  'dia_20',
  'dia_25',
  'dia_30',
  '5_util',
  '10_util',
  'ultimo_dia',
];

function ultimoDiaDoMes(ano, mesIndiceZero) {
  return new Date(ano, mesIndiceZero + 1, 0).getDate();
}

// Retorna o n-esimo dia util (segunda a sexta) do mes, contando a partir do dia 1
function nEsimoDiaUtil(ano, mesIndiceZero, n) {
  let contador = 0;
  let dia = 0;
  const totalDias = ultimoDiaDoMes(ano, mesIndiceZero);
  while (dia < totalDias) {
    dia += 1;
    const dataTeste = new Date(ano, mesIndiceZero, dia);
    const diaSemana = dataTeste.getDay(); // 0 = domingo, 6 = sabado
    if (diaSemana !== 0 && diaSemana !== 6) {
      contador += 1;
      if (contador === n) return dia;
    }
  }
  return totalDias; // fallback: se o mes nao tiver dias uteis suficientes, usa o ultimo dia
}

// Calcula o dia-do-mes correspondente ao codigo recorrente, para um dado ano/mes
function diaDoCodigoRecorrente(codigo, ano, mesIndiceZero) {
  if (codigo === 'ultimo_dia') return ultimoDiaDoMes(ano, mesIndiceZero);
  if (codigo === '5_util') return nEsimoDiaUtil(ano, mesIndiceZero, 5);
  if (codigo === '10_util') return nEsimoDiaUtil(ano, mesIndiceZero, 10);

  const match = codigo.match(/^dia_(\d{2})$/);
  if (match) {
    const diaDesejado = Number(match[1]);
    return Math.min(diaDesejado, ultimoDiaDoMes(ano, mesIndiceZero));
  }
  return null;
}

// Calcula a data de vencimento (00:00) de uma venda fiado ANTIGA (anterior ao
// parcelamento), a partir dos campos legados data_pagamento_tipo/data_pagamento_valor.
// Usado somente pela migracao, para converter essas vendas em parcelas_fiado.
function calcularDataVencimentoFiado(venda) {
  if (!venda.data_pagamento_tipo || !venda.data_pagamento_valor) return null;

  if (venda.data_pagamento_tipo === 'exata') {
    const partes = venda.data_pagamento_valor.split('-').map(Number);
    if (partes.length !== 3) return null;
    return new Date(partes[0], partes[1] - 1, partes[2]);
  }

  if (venda.data_pagamento_tipo === 'recorrente') {
    if (!CODIGOS_RECORRENTES.includes(venda.data_pagamento_valor)) return null;

    const dataVenda = new Date(venda.data.replace(' ', 'T'));
    let ano = dataVenda.getFullYear();
    let mes = dataVenda.getMonth();

    let dia = diaDoCodigoRecorrente(venda.data_pagamento_valor, ano, mes);
    let candidato = new Date(ano, mes, dia);

    const dataVendaSemHora = new Date(dataVenda.getFullYear(), dataVenda.getMonth(), dataVenda.getDate());
    if (candidato < dataVendaSemHora) {
      mes += 1;
      if (mes > 11) { mes = 0; ano += 1; }
      dia = diaDoCodigoRecorrente(venda.data_pagamento_valor, ano, mes);
      candidato = new Date(ano, mes, dia);
    }

    return candidato;
  }

  return null;
}

// Diferenca em dias inteiros entre duas datas, ignorando o horario (util para
// comparar "faltam quantos dias para vencer")
function diferencaEmDias(dataA, dataB) {
  const umDiaEmMs = 24 * 60 * 60 * 1000;
  const somenteDataA = new Date(dataA.getFullYear(), dataA.getMonth(), dataA.getDate());
  const somenteDataB = new Date(dataB.getFullYear(), dataB.getMonth(), dataB.getDate());
  return Math.round((somenteDataA - somenteDataB) / umDiaEmMs);
}

// Formata um objeto Date como 'YYYY-MM-DD', no fuso horario local
function formatarDataISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

module.exports = {
  CODIGOS_RECORRENTES,
  calcularDataVencimentoFiado,
  diferencaEmDias,
  formatarDataISO,
};
