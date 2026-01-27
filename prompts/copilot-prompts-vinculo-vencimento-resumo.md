PROMPT 1 — Corrigir Vinculação/Tags (crash + persistência)
- Escaneie repo completo e localize rota de upload/sync de tags, parser de Excel, persistência no banco e carga inicial.
- Reproduza o crash ao enviar Tags. Identifique causa raiz (client ou server) com logs claros.
- Corrija para: não cair com arquivo grande, manter UI responsiva, mostrar progresso/erros.
- Persistência idempotente: dedupe por (orgId + clientCode + broker/assessor), atualiza sem duplicar.
- Ao abrir app: carregar do banco; filtros globais refletem dados reais; mostrar última sync (data/hora, arquivo, linhas, criados/atualizados, erros).
- Entregáveis: plano curto → implementação → roteiro de testes (manual + automatizável).

PROMPT 2 — Corrigir cálculos de Vencimento (barreiras/resultado/olhinho/PDF)
- Use como verdade: Relatório de Posição.xlsx, vencimentos_2026-01-22 (1).xlsx, calculo2.xlsx.
- Compare 20 operações reais e ajuste cálculos para bater (Pagou, Financeiro, Ganho, %, barreiras, rebates, dividendos).
- Batimento manual (alta/baixa) recalcula imediatamente e persiste após reiniciar.
- “Olhinho” mostra relatório detalhado (resumo + componentes + barreiras por perna + warnings).
- PDF cliente-ready com cabeçalho, resultado, barreiras, componentes; geração rápida sem travar.
- Performance: parsing eficiente (fora do main thread se necessário), cache/batch para quotes/dividendos, UI fluida.
- Entregáveis: raio‑x do módulo → divergências → correções → golden tests → PDF.
