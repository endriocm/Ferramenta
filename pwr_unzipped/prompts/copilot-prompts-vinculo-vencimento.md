Aí vão 2 prompts bem detalhados (sem código) pra tu colar no Copilot Chat. Eles já assumem que o Copilot tem acesso ao teu projeto do ZIP “atualização.zip” e às planilhas “Relatório de Posição.xlsx”, “vencimentos_2026-01-22 (1).xlsx” e “calculo2.xlsx”.

PROMPT 1 — Corrigir “Vinculação” (Tags/Mapeamento): não salva + cai ao enviar + persistência real

Tu é um(a) engenheiro(a) full-stack sênior (Next.js App Router + TS + Prisma/SQLite + Electron). Quero que tu escaneie o projeto inteiro e corrija definitivamente o módulo de Vinculação/Tags (cliente → assessor → broker).

Contexto do problema (real)

Quando eu envio o arquivo de vinculação (Tags) pelo site/app, o app cai (travamento, reload, erro 500, ou fica inutilizável).

Mesmo quando parece que “sincronizou”, não fica salvo de verdade: ao atualizar a página ou reabrir, a vinculação some, não reflete nos filtros, ou volta pro padrão.

Eu preciso que:

não caia ao enviar (robusto mesmo com arquivo grande),

salve e persista (server + UI refletindo),

carregue automaticamente ao abrir o app,

não deixe o app pesado.

Arquivos e fontes que tu deve usar como base (obrigatório)

O upload e sync de tags está no backend (rota de sync) e a tela de vinculação no frontend.

Procura e audita tudo relacionado a:

rota de upload/sync de tags,

leitura de Excel,

persistência no banco,

carregamento dos dados no startup,

filtros globais (broker/assessor),

“flag” de sincronização (ex.: localStorage).

O que eu quero como resultado (sem mudar funcionalidades já existentes)

Reprodução e diagnóstico

Reproduz o crash enviando Tags.

Me diz a causa raiz (ex.: limite de payload, parsing pesado no main thread, transação gigante no SQLite, unique constraint, loop N+1, deadlock/SQLITE_BUSY, erro de runtime, formData instável, etc.).

Identifica se o crash é no client (UI congelando) ou no server (rota derrubando/timeout).

Correções de robustez (sem alterar a proposta do sistema)

O upload tem que aguentar arquivo grande sem travar UI:

parsing fora do thread principal (se necessário),

progress/estado de carregamento,

tempo máximo e feedback claro (não só “deu erro”).

Persistência no banco com idempotência:

se eu mandar o mesmo arquivo 2x, não pode quebrar ou duplicar errado,

deduplicação por (orgId + clientCode + broker/assessor) e atualização correta.

Garantir que ao final:

clientes,

assessores,

brokers,

e vínculos,

fiquem consistentes (sem buraco e sem duplicidade).

Persistência real no “site/app”

Hoje o sistema parece depender de “marcadores” locais (tipo “última sync”), mas eu preciso que:

ao abrir o app, ele busque do banco o estado atual (mapeamento),

os filtros globais passem a refletir os brokers/assessores reais do banco (não lista fixa),

e o usuário veja claramente:

data/hora da última sincronização,

nome do arquivo que foi sincronizado,

quantidade de linhas processadas,

quantos vínculos criados/atualizados,

e erros (se existirem).

Aceitação (checklist obrigatório)

Enviar Tags não derruba o app.

Após sync, recarregar página: vinculação continua lá.

Após reiniciar o app: vinculação continua lá.

Filtros de broker/assessor carregam do banco e batem com a vinculação.

Processamento de arquivo grande não “congela” UI (sem travar).

Tratamento de erro elegante: se falhar, mostra motivo real e o app não morre.

Entregáveis que tu deve produzir

Primeiro: um plano curto (em bullets) com onde mexer (arquivos/rotas/contextos) e por quê.

Depois: implementar as mudanças.

Por fim: um roteiro de testes (manual + automatizável) usando um arquivo grande e casos com duplicidade.

PROMPT 2 — Corrigir cálculos de Vencimento de Estruturas (barreiras, resultado, “olhinho”, batimento manual, PDF) usando as planilhas como verdade

Tu é um(a) dev sênior responsável pelo módulo Vencimento de Estruturas. Quero que tu leia e entenda o projeto inteiro e ajuste os cálculos para ficarem 100% coerentes com as planilhas de referência — sem remover funcionalidades e sem deixar o sistema pesado.

O problema (objetivo)

Os cálculos de resultado não estão corretos.

Preciso que tu uses as planilhas anexas como fonte da verdade para:

como calcular “Pagou”, “Financeiro”, “Ganho”, “%”,

como tratar barreira de alta e barreira de baixa,

como tratar rebates,

como tratar dividendos no período,

e como exibir isso no “olhinho” (detalhamento) em formato de relatório.

Além disso, o usuário tem que conseguir:

forçar batimento manual de barreira de alta e/ou baixa,

e isso tem que alterar o resultado imediatamente (recalcular),

e ficar persistido (não sumir quando reiniciar).

Planilhas (obrigatório usar como referência)

Relatório de Posição.xlsx

Contém a base de operações e as “pernas”.

Campos importantes:

cliente/códigos, datas (registro e vencimento), ativo, estrutura,

valor do ativo de entrada,

custo unitário,

e até 4 pernas com:

Tipo (Stock / Call Option / Put Option),

Quantidade Ativa (pode ser negativa em venda),

Strike,

Barreira (valor),

Tipo da barreira (ex.: Up and In / Up and Out / Down and Out),

Rebate.

vencimentos_2026-01-22 (1).xlsx

É o “formato final” esperado do relatório consolidado.

Colunas esperadas:

Assessor, Broker, Código, Cliente, Ativo, Estrutura, Entrada, Vencimento,

Qtd, Valor Entrada, Spot, Custo Unit., Pagou, Financeiro, Ganho, %, Barreira, Dividendos, Rebates.

calculo2.xlsx

É o gabarito do cálculo detalhado:

VENDA DO ATIVO A MERCADO,

GANHO NA PUT / GANHO NA CALL,

GANHOS NAS OPÇÕES,

DIVIDENDOS,

CUPOM,

PAGOU,

FINANCEIRO FINAL,

GANHO/PREJUÍZO e LUCRO %.

Regras de cálculo (tu deve implementar/validar e bater com as planilhas)

Pagou

Deve refletir exatamente o que a planilha considera como desembolso:

quando há perna de ativo (Stock), pagou envolve “valor de compra * quantidade” (e custo unitário se aplicável).

quando for estrutura “opção pura”, pagou pode ser só o custo/premium (conforme referência).

Venda do ativo a mercado

Quando aplicável: “Spot * quantidade do ativo”.

Em estruturas tipo “Cupom Recorrente”, o “principal” pode não ser spot; segue exatamente o gabarito do calculo2.xlsx.

Payoff das opções (por perna)

Call: max(spot - strike, 0) * quantidade (respeitando sinal: vendido geralmente vem como quantidade negativa).

Put: max(strike - spot, 0) * quantidade (respeitando sinal).

Ganhos nas opções = soma dos payoffs (por perna) + rebates que forem devidos.

Barreiras

Identificar e separar:

Barreira de Alta (Up…),

Barreira de Baixa (Down…).

Status “Barreira” no relatório final deve sair como:

“Bateu barreira” / “Não bateu” / “N/A” exatamente como no vencimentos_2026…,

com coerência com as regras do tipo de barreira (In/Out) e rebate.

Rebate

Se a perna tem rebate e a condição acontecer (ex.: knock-out), somar corretamente em “Rebates”.

Dividendos

Buscar dividendos no site (via endpoint existente) e somar no período:

de Data de Registro até Data de Vencimento (ou regra da planilha, se diferente).

Spot / cotação

Buscar cotação no Yahoo Finance (endpoint existente).

Garantir fallback e cache sem travar.

Funcionalidades de UI que tu deve garantir (sem quebrar o fluxo atual)

“Olhinho” (modal detalhe) como relatório

Mostrar um resumo final claro:

Pagou, Financeiro Final, Ganho/Prejuízo, %, Spot, Dividendos, Rebates.

Mostrar um detalhamento por perna:

tipo, qty, strike, barreira, tipo de barreira, payoff, rebate aplicado.

Batimento manual (forçado)

Adicionar/garantir botões:

“Forçar bateu barreira de alta”

“Forçar bateu barreira de baixa”

“Resetar para automático”

Ao clicar:

recalcula na hora,

atualiza “Barreira”, “Rebates”, “Financeiro”, “Ganho” e “%”.

Persistência:

ao recarregar/reabrir, o override continua (server e/ou cache local consistente).

Exportar PDF para enviar ao cliente

Um botão no “olhinho”: “Exportar PDF”.

Conteúdo do PDF (padrão comercial):

Cabeçalho com Cliente, Ativo, Estrutura, Datas (Entrada/Vencimento),

Bloco “Resultado” (Pagou, Financeiro, Ganho, %, Spot),

Bloco “Barreiras” (alta/baixa, tipo, valor, status, manual/auto),

Bloco “Componentes do Resultado”:

venda do ativo,

ganhos nas opções (put/call),

dividendos,

rebates,

cupom (se houver),

Rodapé com observação/assinatura.

Deve ser leve (gerar rápido, sem travar).

Performance / estabilidade (obrigatório)

Nada de travar:

parsing de Excel grande não pode congelar,

tabela grande precisa manter scroll fluido (virtualização ok),

processamento deve ser eficiente (batch, memoization, cache).

Evitar regressões:

não remover features existentes (filtros, seleção de pasta, cache, etc.).

Como tu deve trabalhar (ordem)

Primeiro, faz um “raio-x” do módulo atual (onde calcula, onde lê as planilhas, onde monta o relatório).

Depois, compara 20 operações reais do Relatório de Posição.xlsx com o resultado esperado no calculo2.xlsx e no vencimentos_2026…:

identifica exatamente onde diverge (pagou? spot? barreira? rebate? dividendos?).

Implementa as correções para bater com as planilhas.

Cria validações automatizadas (golden test):

usar as planilhas como fixture,

testar pelo menos: collar, call spread, doc, rubi, cupom recorrente.

Por último, implementa o PDF e garante os botões de batimento manual.

Critérios de aceite (tem que bater)

Para um conjunto de operações (amostra), os números de:

Pagou, Financeiro, Ganho e %

batem com o calculo2.xlsx (mesma lógica/resultado).

“Barreira” sai coerente (Bateu/Não bateu/N/A) e altera com override.

Export PDF gera corretamente e rápido.

Nada trava ao carregar/processar.
