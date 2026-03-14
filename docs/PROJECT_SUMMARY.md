# Ferramenta (PWR Endrio) - PROJECT SUMMARY

> Ultima atualizacao: 2026-03-03
> Objetivo: servir como resumo tecnico fiel ao codigo atual do repositorio.

---

## 1) Visao geral

"Ferramenta" e um app desktop (Electron + React) para operacao de mesa e acompanhamento comercial.
Hoje o produto nao e apenas importador de receita/vencimento: ele inclui automacao HubXP, automacao Outlook,
calendarios de resultados/proventos, gerador de cards com OCR, sincronizacao global de arquivos e painel analitico.

Principais blocos funcionais:

1. Receita:
- Bovespa
- BMF
- Estruturadas
- Comissao XP (com sobreposicao mensal global)
- Receita Manual
- Receita Consolidada (complemento por meses faltantes)

2. Operacao:
- Vencimento de estruturas
- Batimento de barreira (base + diario)
- Projecao de vencimento
- Historico de operacoes
- Clientes operando
- Gap comercial (meta vs producao)
- Antecipacao (analise vs CDI)

3. Automacao:
- HubXP Central de Ordens
- HubXP Apuracao Bovespa
- HubXP fluxo manual gravavel/replay
- Outlook (sessao, monitor de inbox por regras, envio por conta)

4. Ferramentas:
- Calendario de resultados (BR + EUA)
- Calendario de proventos
- Gerador de cards (payoff/destaque/consolidador) + OCR
- Right Tool Rail (resultados semanais, calculadora, HP12C, fee liquido)

5. Plataforma:
- Auth Firebase + AccessGate
- Billing Mercado Pago (Cloud Functions)
- Auto-update desktop via S3
- API embarcada no Electron (Express) + funcoes serverless em /api

---

## 2) Estrutura do repositorio

```text
Ferramenta/
|- electron/
|  |- main.js
|  |- preload.js
|
|- pwr/
|  |- src/
|  |  |- App.jsx
|  |  |- routeRegistry.js
|  |  |- components/
|  |  |- contexts/
|  |  |- pages/
|  |  |- services/
|  |  |- lib/
|  |  |- utils/
|  |  |- workers/
|  |- package.json
|
|- server/
|  |- index.js
|  |- runtimeApp.js
|  |- hubxpOrders.js
|  |- outlookMail.js
|
|- api/
|  |- health.js
|  |- quotes.js
|  |- dividends.js
|  |- cdi.js
|  |- earnings-calendar.js
|  |- spot.js
|  |- receitas/*/import.js
|  |- vencimentos/parse.js
|  |- lib/*
|
|- functions/
|  |- index.js
|
|- docs/
|  |- ARCHITECTURE.md
|  |- HUBXP_FLOW_DEV.md
|  |- PERFORMANCE.md
|  |- PROJECT_SUMMARY.md
|
|- scripts/
|  |- release-win.ps1
|  |- publish-updates-aws.mjs
|  |- release-summary.mjs
```

---

## 3) Stack principal

- Desktop shell: Electron 33
- Frontend: React 19 + Vite 7
- Backend local: Express (porta 4170)
- Automacao browser: Playwright / playwright-core
- Auth/DB: Firebase Auth + Firestore
- Billing: Firebase Functions + Mercado Pago
- Excel: xlsx + xlsx-js-style + parser em Web Worker
- OCR: Windows OCR nativo (via Electron IPC) com fallback Tesseract.js
- Deploy web API: Vercel serverless (/api)
- Auto-update desktop: electron-updater + bucket S3

---

## 4) Electron (main + preload)

### Main process (`electron/main.js`)

Responsabilidades atuais:

1. Janela principal + carregamento UI (dev/prod)
2. Inicializacao de API embarcada Express (`server/runtimeApp`)
3. Canal de runtime para UI descobrir estado/base URL da API local
4. IPC para:
- arquivos/pastas (`select-import-folder`, `scan-import-folder`, `list-folder-files`, etc.)
- leitura/grava de arquivos (`read-file`, `save-file`, `save-pdf`)
- clipboard imagem
- OCR por imagem
- storage nativo por chave
- config (`config:get`, `config:set`, `config:selectWorkDir`)
- updates (`updates:*`)

5. Auto-update
- base padrao: bucket S3 (`ferramenta-updates-937506434821`)
- scripts de release e publicacao AWS

### Preload (`electron/preload.js`)

Expõe `window.electronAPI` com:
- `app`, `openExternal`
- `selectFolder`/`selectImportFolder`/`scanImportFolder`
- `readFile`/`saveFile`/`savePdf`
- `clipboard.writeImageDataUrl`
- `ocr.readImageDataUrl`
- `storage.get/set/remove/getMultiple`
- `config.get/set/selectWorkDir`
- `runtime.getApiState/getApiBaseUrl/onApiReady`
- `updates.getStatus/check/download/install/...`

Tambem habilita zoom via `Ctrl + wheel`.

---

## 5) Frontend (React)

### 5.1 Shell e arquitetura de navegacao

- Roteamento hash custom (`useHashRoute`) sem react-router
- Registro central de rotas em `routeRegistry.js`
- Lazy loading por rota + prefetch em idle
- `KeepAlive` para cache de paginas (evita remount caro)
- `RightToolRail` persistente na lateral direita

### 5.2 Contextos globais

- `GlobalFilterContext`: broker/assessor/cliente/apuracao
- `HubxpContext`: sessao HubXP, credenciais e status compartilhado
- `OutlookContext`: sessao Outlook, monitoramento, regras, template, historico

### 5.3 Rotas funcionais atuais

- `/` Dashboard
- `/times` Times (aba Times dentro de Tags)
- `/cards` Gerador de cards
- `/importacao` Catalogo central de planilhas
- `/vinculos` Vinculos por modulo + Sync All
- `/receita/estruturadas`
- `/receita/bovespa`
- `/receita/bmf`
- `/receita/comissao-xp`
- `/receita/manual`
- `/receita/consolidado`
- `/vencimento`
- `/batimento-barreira`
- `/projecao-vencimento`
- `/historico-operacoes`
- `/clientes-operando`
- `/gap`
- `/antecipacao`
- `/central-ordens` (HubXP)
- `/apuracao-bovespa` (HubXP)
- `/calendario-resultados`
- `/calendario-proventos`
- `/outlook`
- `/tags`
- `/account/access`
- `/admin/access`
- `/billing/success|pending|failure`

---

## 6) Modulos de negocio (detalhe por dominio)

### 6.1 Receita

#### 6.1.1 Bovespa e BMF (`RevenueMarket`)

- Wrapper por mercado:
  - Bovespa fator: `0.9335 * 0.8285`
  - BMF fator: `0.9435 * 0.8285`
- Import via arquivo vinculado/catalogado
- Filtro por periodo, broker, assessor, conta e texto
- Reprocessamento de rejeitados
- Edicao de corretagem/receita na grade
- Integracao com override da Comissao XP

#### 6.1.2 Estruturadas (`RevenueStructured`)

- Import de relatorio estruturadas
- Consolida e exibe com filtros globais
- Integracao com override da Comissao XP

#### 6.1.3 Comissao XP (`RevenueXpCommission`)

- Import de relatorio XP
- Mapeia linhas para Bovespa/BMF/Estruturadas
- Persiste dataset dedicado (`pwr.receita.xp`)
- Controle global de sobreposicao mensal (`pwr.receita.xp.override`)

#### 6.1.4 Receita Consolidada (`RevenueConsolidated`)

- Import de planilha de consolidado bruto
- Complementa apenas meses ausentes (nao substitui base inteira)
- Gera resumo de meses importados/ignorados

#### 6.1.5 Receita Manual

- Lancamentos manuais com persistencia local
- Usada tambem como destino de alguns fluxos automaticos (HubXP)

---

### 6.2 Operacao

#### 6.2.1 Vencimento

- Parse de planilha de posicao consolidada (layout flexivel)
- Cotacao spot/high/low e series via `/api/quotes`
- Calculo financeiro em `services/settlement`
- Overrides manuais de barreira/cupom/bonus
- Export XLSX/PDF
- Cache de import por usuario

#### 6.2.2 Batimento de barreira

- Entrada de base + diario
- Busca mercado historico por ativo
- Detecta batimento de alta/baixa por intervalo
- Mantem estado versionado por operacao
- Gera notificacoes consumidas no Topbar

#### 6.2.3 Projecao de vencimento

- Reusa dados/base de vencimento
- Projeta entradas por mes, broker e estrutura
- Graficos com filtros e agregacoes

#### 6.2.4 Historico de operacoes

- Import de consolidacoes historicas por planilha
- Recalculo por spot de vencimento
- Uso de `computeResult` com ajuste de dividendos informados

#### 6.2.5 Clientes operando

- Mapa de atividade por janela (ultimos 6 meses)
- Score por recorrencia e status de atividade
- Persistencia de estado de filtros/sort

#### 6.2.6 Gap

- Gap comercial por assessor
- Simulacao por produto (tipo de operacao e fee)
- Integra metas/senioridade e blocos de objetivo

#### 6.2.7 Antecipacao

- Import parser dedicado (`antecipacaoParser`)
- Calcula status de saida e comparativo contra CDI
- Busca CDI via `/api/cdi`
- Export analitico

---

### 6.3 Tags, times e organizacao de dados

#### Tags e vinculos (`/tags` e `/times`)

- Import de Tags.xlsx
- Enriquecimento de linhas por codigo cliente
- Tabelas/visoes de times
- Goals por senioridade

#### Importacao (`/importacao`)

- Seleciona pasta raiz
- Varredura recursiva de planilhas
- Catalogo versionado por usuario

#### Vinculos e sincronizacao (`/vinculos`)

- Vincula arquivo por modulo/role
- "Sincronizar tudo" roda importadores em sequencia
- Mostra progresso e resultado por modulo

---

### 6.4 HubXP e Outlook

#### Central de Ordens (HubXP)

- Sessao Playwright compartilhada
- Login + OTP
- Coleta ordens com filtros e paginacao
- Resultado com analise/status e graficos
- Pode gerar lote de receita manual a partir da coleta

#### Apuracao Bovespa (HubXP)

- Processa contas (manual ou por arquivo)
- Extrai dados de Notas de Negociacao
- Parametros de concorrencia/tentativas
- Abort de processo em execucao
- Suporte a fluxo gravado (`useRecordedFlow`)

#### HubXP Flow DEV

- Gravar fluxo manual (`/flow/record/start|stop`)
- Consultar (`/flow/:jobId`), limpar, importar e replay
- Replay em modo `prepare_filters` com validacao ate clique em Filtrar
- Fallback automatico para fluxo padrao quando replay falha

#### Outlook

- Sessao Outlook web dedicada por usuario
- Monitoramento de inbox por regras (sender/subject)
- Poll de eventos incremental por `afterSeq`
- Envio por conta com template
- Resolucao de email cliente via HubXP (`/api/hubxp/clients/resolve`)
- Notificacao desktop + feed de notificacoes no Topbar

---

### 6.5 Ferramentas de mercado e cards

#### Calendario de resultados

- BR + EUA
- Fonte principal Yahoo quoteSummary
- Enriquecimento por scraping multi-fonte (Investidor10, StatusInvest, EarningsHub, Investing)
- Cache local e chunking por simbolos

#### Calendario de proventos

- Agenda por data-com
- JCP e dividendos
- Consumo de `/api/dividends` (GET/POST batch)

#### Gerador de cards

- Layouts: payoff, destaque, consolidador
- Templates de estrategia + tabela de payoff
- Import por OCR de imagem (Windows OCR/Tesseract)
- Busca dados de empresa (`companyProfile`)
- Export PNG/PDF e copiar para clipboard

#### Right Tool Rail

- Resultado da semana (atalho calendario)
- Calculadora padrao
- HP12C (registradores financeiros)
- Calculadora de fee liquido estruturadas

---

## 7) Backend Express local (`server/runtimeApp.js`)

### 7.1 Endpoints core

- `GET /api/health`
- `GET /api/cdi`
- `GET /api/dividends`
- `GET /api/earnings-calendar`
- `GET /api/spot`
- `GET /api/quotes`
- `POST /api/vencimentos/parse`
- `POST /api/receitas/estruturadas/import`
- `POST /api/receitas/bovespa/import`
- `POST /api/receitas/bmf/import`

### 7.2 Endpoints HubXP

- `POST /api/hubxp/orders/start`
- `POST /api/hubxp/orders/otp`
- `POST /api/hubxp/orders/fetch`
- `GET /api/hubxp/orders/results/:jobId`
- `GET /api/hubxp/orders/status/:jobId`
- `POST /api/hubxp/orders/cleanup`

Flow gravado:
- `POST /api/hubxp/flow/record/start`
- `POST /api/hubxp/flow/record/stop`
- `GET /api/hubxp/flow/:jobId`
- `POST /api/hubxp/flow/clear`
- `POST /api/hubxp/flow/import`
- `POST /api/hubxp/flow/replay`

Apuracao:
- `POST /api/hubxp/apuracao/bovespa/fetch`
- `POST /api/hubxp/apuracao/bovespa/abort`
- `GET /api/hubxp/apuracao/bovespa/results/:jobId`

Lookup cliente:
- `POST /api/hubxp/clients/resolve`

### 7.3 Endpoints Outlook

- `POST /api/outlook/session/start`
- `GET /api/outlook/session/status/:jobId`
- `POST /api/outlook/session/cleanup`
- `POST /api/outlook/monitor/start`
- `POST /api/outlook/monitor/stop`
- `GET /api/outlook/monitor/events/:jobId`
- `POST /api/outlook/send/accounts`

---

## 8) API serverless (`api/`)

Funcoes ativas:

- `api/health.js`
- `api/quotes.js`
- `api/dividends.js`
- `api/cdi.js`
- `api/earnings-calendar.js`
- `api/spot.js`
- `api/receitas/estruturadas/import.js`
- `api/receitas/bovespa/import.js`
- `api/receitas/bmf/import.js`
- `api/vencimentos/parse.js`

Bibliotecas em `api/lib`:
- parsers de receita
- providers de dividendos
- CDI
- earnings calendar + scraper

---

## 9) Firebase Functions (`functions/index.js`)

Exports atuais:

- `createAnnualCheckoutLink` (onCall)
- `adminFindUserByEmail` (onCall)
- `adminGetUserAccess` (onCall)
- `getMyAccessStatus` (onCall)
- `adminGrantAccess` (onCall)
- `adminRevokeAccess` (onCall)
- `adminReprocessPayment` (onCall)
- `mercadoPagoWebhook` (onRequest)

Secrets/params usados:
- `MP_ACCESS_TOKEN`
- `MP_WEBHOOK_SECRET_TEST`
- `MP_WEBHOOK_SECRET_PROD`
- `ANNUAL_PRICE_BRL`
- `APP_BASE_URL`

---

## 10) Persistencia de dados

### 10.1 Local (browser/electron)

- Receita:
  - `pwr.receita.bovespa`
  - `pwr.receita.bmf`
  - `pwr.receita.estruturadas`
  - `pwr.receita.manual`
  - `pwr.receita.xp`
  - `pwr.receita.xp.override`

- Operacao:
  - `pwr.vencimento.cache.{userKey}`
  - `pwr.vencimento.overrides.{userKey}`
  - `pwr.vencimento.link.{userKey}`
  - `pwr.barrier-hit.state.{userKey}`
  - `pwr.antecipacao.state.{userKey}`
  - `pwr.historico-operacoes.state.{userKey}`

- Importacao:
  - `pwr.import.catalog.{userKey}`
  - `pwr.import.bindings.{userKey}`
  - `pwr.global.folder.{userKey}`
  - `pwr.global.folder.mapping.{userKey}.*`

- Automacao:
  - `pwr.hubxp.job_id.{userKey}`
  - `pwr.hubxp.credentials.{userKey}`
  - `pwr.outlook.*.{userKey}` (job, credentials, rules, template, history, monitor, notified)

- UI:
  - filtros globais
  - tema (`pwr.theme.palette.{userKey}`)
  - estado de paginas
  - sidebar collapse

### 10.2 IndexedDB

- Tags (`pwr-tags`)
- Handle de pasta global (File System Access API) para ambiente browser

### 10.3 Firestore

- `users`
- `entitlements`
- `licenseKeys`
- `mpPayments`
- `accessAudits`

---

## 11) Integracoes externas

- Mercado:
  - Yahoo Finance
  - Brapi
  - StatusInvest
  - Banco Central (CDI)

- Scraping de agenda de resultados:
  - Investidor10
  - StatusInvest
  - EarningsHub
  - Investing.com

- Automacao browser:
  - HubXP
  - Outlook Web

- Billing:
  - Mercado Pago

---

## 12) Build, dev e release

Comandos raiz principais:

```bash
npm run dev:api
npm run dev:ui
npm run dev:electron
npm run build:ui
npm run build:electron
npm run release:summary
npm run release:win
```

Observacoes:

- Electron inclui UI build + server + libs de parser no pacote final.
- Publicacao de update usa provider `generic` apontando para bucket S3.
- Script de release valida prerequisitos de bucket/credenciais.

---

## 13) Estado tecnico atual (resumo rapido)

- Projeto com escopo amplo e bastante funcionalidade local-first.
- Forte dependencia de APIs/scraping externo (mercado e calendarios).
- Fluxos HubXP/Outlook dependem de estabilidade de UI externa e Playwright.
- Persistencia principal ainda concentrada em localStorage + arquivos locais.
- Existe instrumentacao/performance docs e parser em Web Worker para reduzir travamento de UI.

---

## 14) Diferencas relevantes em relacao a resumos antigos

Este resumo ja inclui funcionalidades que nao estavam no documento antigo:

- HubXP completo (Central Ordens + Apuracao + Flow gravado/replay + lookup clientes)
- Outlook (monitor e envio)
- Importacao central + Vinculos + Sync All
- Comissao XP e sobreposicao global
- Receita Consolidada
- Batimento de barreira
- Projecao de vencimento
- Historico de operacoes
- Clientes operando
- Gap
- Antecipacao com CDI
- Calendarios de resultados e proventos
- Right Tool Rail (calculadoras e agenda semanal)
- Auto-update em S3 (nao mais foco em Blob antigo)
