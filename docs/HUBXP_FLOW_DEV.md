# HubXP Manual Flow (Dev)

Este modo permite:
- gravar um fluxo manual (cliques/campos) uma vez
- reaproveitar o fluxo automaticamente na apuracao

## 1) Pre-requisitos
- Sessao HubXP criada (`/api/hubxp/orders/start`) e autenticada.
- Job ID disponivel.
- Pagina de Notas de Negociacao aberta no browser da sessao.

## 2) Iniciar gravacao manual
```http
POST /api/hubxp/flow/record/start
Content-Type: application/json

{ "jobId": "<JOB_ID>" }
```

## 3) Fazer 1 ciclo manual (no browser)
Fluxo recomendado:
1. Informar conta/codigo.
2. Selecionar cliente/conta na sugestao.
3. Selecionar data inicial e data final.
4. Clicar em `Filtrar`.
5. Abrir nota PDF.
6. Fechar nota.

## 4) Parar gravacao
```http
POST /api/hubxp/flow/record/stop
Content-Type: application/json

{ "jobId": "<JOB_ID>" }
```

## 5) Validar fluxo salvo
```http
GET /api/hubxp/flow/<JOB_ID>
```

## 6) Testar replay manual (dev)
```http
POST /api/hubxp/flow/replay
Content-Type: application/json

{
  "jobId": "<JOB_ID>",
  "mode": "prepare_filters",
  "variables": {
    "account": "1234567",
    "date_from": "2026-02-01",
    "date_to": "2026-02-19"
  }
}
```

Observacao:
- Em `mode=prepare_filters`, o replay so e considerado valido se chegar ate o clique de `Filtrar`.

## 7) Rodar apuracao usando fluxo gravado
```http
POST /api/hubxp/apuracao/bovespa/fetch
Content-Type: application/json

{
  "jobId": "<JOB_ID>",
  "accounts": ["1234567", "7654321"],
  "filters": {
    "dateFrom": "2026-02-01",
    "dateTo": "2026-02-19"
  },
  "accountMeta": {},
  "useRecordedFlow": true,
  "async": true
}
```

Fallback automatico:
- Se replay falhar ou nao chegar em `Filtrar`, o backend usa o fluxo padrao (seleciona conta, valida/aplica periodo, filtra).

## 8) Limpar fluxo gravado
```http
POST /api/hubxp/flow/clear
Content-Type: application/json

{ "jobId": "<JOB_ID>" }
```

