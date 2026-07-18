// sw.js
// Service Worker responsável por permitir o uso do PDV mesmo com conexão
// instável: guarda em cache o "app shell" (HTML/CSS/JS/ícones) e aplica uma
// estratégia de rede-primeiro-com-fallback-para-cache nas chamadas de API GET.

const VERSAO_CACHE = 'estoque-cache-v2';
const ARQUIVOS_APP_SHELL = ['./manifest.json', './icon.svg'];

// --- instalação: baixa e guarda os arquivos essenciais do app ---------------
self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(VERSAO_CACHE).then((cache) => cache.addAll(ARQUIVOS_APP_SHELL))
  );
  self.skipWaiting();
});

// --- ativação: remove caches de versões antigas -----------------------------
self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys().then((chaves) =>
      Promise.all(chaves.filter((chave) => chave !== VERSAO_CACHE).map((chave) => caches.delete(chave)))
    )
  );
  self.clients.claim();
});

// --- interceptação das requisições -------------------------------------------
self.addEventListener('fetch', (evento) => {
  const requisicao = evento.request;
  const url = new URL(requisicao.url);

  // Chamadas de escrita (POST/PUT/DELETE) na API sempre vão direto pra rede:
  // não faz sentido cachear ou reproduzir uma venda/alteração enquanto offline.
  if (url.pathname.startsWith('/api/') && requisicao.method !== 'GET') {
    evento.respondWith(fetch(requisicao));
    return;
  }

  // Chamadas de leitura da API (GET /api/produtos, /api/clientes, etc.):
  // tenta a rede primeiro; se falhar (offline), usa a última resposta em cache.
  if (url.pathname.startsWith('/api/')) {
    evento.respondWith(
      fetch(requisicao)
        .then((resposta) => {
          const copia = resposta.clone();
          caches.open(VERSAO_CACHE).then((cache) => cache.put(requisicao, copia));
          return resposta;
        })
        .catch(() => caches.match(requisicao))
    );
    return;
  }

  // Documento HTML (a navegação principal do app, incluindo index.html):
  // rede-primeiro, para que uma nova versão publicada apareça já no PRÓXIMO
  // carregamento, sem depender de dois reloads. So usa o cache quando estiver
  // offline. Isso evita ficar "preso" numa versão antiga do app indefinidamente.
  const ehNavegacaoHtml = requisicao.mode === 'navigate' || requisicao.destination === 'document';
  if (ehNavegacaoHtml) {
    evento.respondWith(
      fetch(requisicao)
        .then((respostaRede) => {
          caches.open(VERSAO_CACHE).then((cache) => cache.put(requisicao, respostaRede.clone()));
          return respostaRede;
        })
        .catch(() => caches.match(requisicao).then((resp) => resp || caches.match('./index.html')))
    );
    return;
  }

  // Demais arquivos (CSS, JS, ícones, manifest): cache-primeiro com atualização em segundo plano.
  evento.respondWith(
    caches.match(requisicao).then((respostaCache) => {
      const buscaRede = fetch(requisicao)
        .then((respostaRede) => {
          caches.open(VERSAO_CACHE).then((cache) => cache.put(requisicao, respostaRede.clone()));
          return respostaRede;
        })
        .catch(() => respostaCache);
      return respostaCache || buscaRede;
    })
  );
});
