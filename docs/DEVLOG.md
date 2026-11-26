# Synapse — diário de desenvolvimento

> Registro mantido durante o desenvolvimento (antes chamado PROJECT_CONTEXT.md): decisões, medições, verificações e pendências de cada versão. Caminhos como `work/` e `../../work/` se referem à pasta de trabalho local e não fazem parte deste repositório.

## 1.7.0 pronta para atualizar a 1.6.1 (Claude, 26/11) — `dist/Synapse-Setup-1.7.0.exe`

- **Instalador:** 141.599.323 bytes, sem assinatura digital, SHA-256 `888A1EE3CFEDB978A7B7CCEE67328DB6D623C89DDD964CF9F9FC3AD857991387`, blockmap presente. `conferir-pacote . 1.6.1`: 40 arquivos iguais, 0 diferentes (2 ausentes = scripts de build), versão 1.7.0, encontrada a partir da 1.6.1. Código do commit `7331c27`.
- **Revisão do Gemini aplicada (`7331c27`):** (1) o botão do Gemini no rodapé só fica `esgotado` quando todas as rotas ativas estão em 100% (`dockEsgotado`; GPT e Claude seguem com qualquer janela em 100%); (2) o anel "Hoje" mostra o modelo com mais folga, e a rota só chega a 100% quando todos os modelos gratuitos do AI Studio estão esgotados (`geminiOrigins` agora devolve `models`, vindo do catálogo sem os `locked`); (3) cartão e rodapé usam os mesmos rótulos, Hoje e Conta. Testes: 5 subtestes novos em `tests/v17.test.mjs` (falham no código anterior); suíte 234, 228 passam, 0 falham, 6 pulados (`../../work/teste-1.7.0-refino.log`); vitrine isolada na porta 4431: Gemini `28%·100%` sem `esgotado`, cartão "Hoje · Conta", console sem erros nem avisos.
- **Pendente em uso real:** F11 no aplicativo instalado; um 429 diário real com `quotaValue`; medir o consumo por fala na 1.6.1/1.7 (`../../work/consumo-comparado.mjs`). A revisão independente da 1.7.0 foi só do Gemini (estática, sem terminal); o GPT ficou fora desta rodada.

### Entrega original da 1.7.0 (cefa979)

Pedido do usuário: validar o consumo, menos neon, nome sem cor, gráficos mais interativos com mais parâmetros, rodapé de uso com um padrão só (antes: a maior janela de cada um, 5 h no GPT e semanal no Claude), o Gemini com algum indicador de uso e F11 para tela cheia.

- **Tema sóbrio** (`public/tema.css`, camada "1.7 · sóbrio" no fim): nome em branco, sem halos/brilhos, destaques brancos e cinzas, preto como principal. Cores dos participantes recalibradas e validadas pelo validador do dataviz no modo escuro sobre `#050506`: GPT `#00AE80`, Claude `#D95F19`, Gemini `#437DDE` (todas as verificações passam; CVD ΔE ≥ 8,2).
- **Rodapé de uso** (`public/app.js`, `dockSlots`/`geminiSlots`): anel externo = janela curta e interno = longa, com os dois valores na mesma ordem. GPT e Claude: 5 horas e semana (a maior das semanais, inclusive as de modelo). Gemini: requisições de hoje no AI Studio (em % quando o Google já informou o tamanho da cota) e a conta Google no Antigravity (100% quando em pausa). O painel do Gemini mostra os mesmos dois anéis.
- **Cota diária do AI Studio**: `studioError` lê `quotaValue` da violação diária (`error.dailyLimit`), e `runStudioRoute` guarda em `providerState('studio').limits[modelo]`; `geminiOrigins` devolve `limit` por modelo. Não confirmado com uma resposta 429 real: depende de o Google mandar `quotaValue`.
- **F11**: `desktop/main.mjs` alterna `setFullScreen` e avisa a interface pelo canal só de ida `synapse:tela-cheia` (preload); `html.tela-cheia` esconde a barra de título própria. O teste de segurança da ponte (`tests/desktop.test.mjs`) passou a permitir esse canal. Não testado no Electron real nesta fala.
- **Análises**: 8 indicadores (+ raciocínio e % da entrada via cache), medida "Raciocínio", legenda clicável que esconde participantes em toda a aba, e três gráficos novos: custo de cada fala (pontos e linhas com mira, dica com todos os parâmetros, clique fixa), composição dos tokens (novos, cache, saída, raciocínio) e tamanho da conversa com a linha de renovação (`sessionMaxTokens` da sala).
- **Consumo medido** (`../../work/consumo-comparado.mjs`, normalização da aba Análises, só Code): Claude, mediana de cache por fala 8,00 mi em 23/11 → 2,52 mi em 25–26/11 (1.6.0); GPT 3,39 mi (1 fala, estimada pelos totais) → 1,92 mi. Tarefas diferentes, então é indício e não medida controlada. O "13,7 mi" do GPT citado em 24/11 era o total acumulado da conversa, não o de uma fala. A 1.6.1 ainda não tem falas medidas. Nos 30 dias, 96,9% da entrada veio do cache.
- Verificação visual numa instância isolada com cópia do banco (`node ../../work/synapse-vitrine.mjs . 4427 <banco>`): capturas `../../work/ui-1.7-*.png`, console sem erros. Suíte: 228 testes, 222 passam, 0 falham, 6 pulados (`../../work/teste-1.7.0.log`).

## 1.6.1 pronta para atualizar a 1.6.0

O GPT aprovou o código de `0ab0ca0` e gerou `dist/Synapse-Setup-1.6.1.exe` para Windows x64. O instalador tem 141.593.287 bytes, sem assinatura digital, e SHA-256 `c666f94914c2a03daae5e4c38693fd76a27c19401cac7fc45957ef93048fc4bd`. A extração do próprio EXE confirmou a versão 1.6.1 e 40 arquivos de código idênticos ao repositório. A busca local a partir da 1.6.0 encontrou o pacote.

Os 19 testes de economia passaram. Na suíte Windows completa, 218 passaram, zero falharam e seis foram pulados. Registro em `../../work/teste-1.6.1-instalador-gpt.log`. A troca Flash → Hydrogen foi testada com respostas simuladas. Após a atualização, falta observar essa troca em produção e medir o consumo por fala. A instalação fica a cargo do usuário.

## 1.6.1 — refino: falha do Flash antes da troca não tira rodada do Hydrogen

Revisão `fb7c5da` do GPT aceita integralmente (rodadas e reserva compartilhadas, contagem por modelo, uso parcial sem tokens). Um ajuste de desempenho com o mesmo teto de custo: quando uma rodada termina sem resposta do Google (ex.: 429 diário do Flash na primeira requisição), a requisição perdida passa a contar como recuperação, se a reserva comporta, em vez de consumir uma rodada de trabalho. Antes, com 3 rodadas, um 429 do Flash deixava o Hydrogen com só uma rodada de ferramentas; agora ele tem as duas. O invariante continua: requisições − rodadas ≤ `STUDIO_RECOVERY` (2), então o total por fala nunca passa de rodadas + 2. Com a reserva esgotada no Flash (três 503), o Hydrogen fica com duas rodadas, como na regra do GPT.

Testes: o da troca passou a esperar Flash 1 + Hydrogen 3 (com o fechamento sem funções) e um novo cobre Flash 503+429 diário (Hydrogen com 3 rodadas, total 5) e Flash 3×503 (Hydrogen com 2, total 5). Os dois falham no `fb7c5da` e passam com o ajuste. Registro da suíte em `../../work/teste-1.6.1-refino2.log`.

## 1.6.1 — reserva do AI Studio e consumo por modelo

A revisão de `c6cdfea` reproduziu duas regressões. Dois 503 seguidos ainda deixavam o Gemini repetir um 429 na rodada seguinte. Uma troca de Flash para Hydrogen também reiniciava o número de rodadas. A implementação agora compartilha as rodadas e as duas retentativas por toda a fala. O último pedido de uma fala em Code fecha com funções desligadas. A sala mantém o valor configurado pelo usuário.

O painel de requisições diárias contabiliza as tentativas por modelo, inclusive quando o serviço encerra sem informar tokens. Os registros antigos conservam a informação disponível. No teste com três rodadas e troca de modelo, Flash usou uma requisição e Hydrogen usou duas. No teste com 503 e silêncio na rodada final, a resposta saiu em cinco requisições. Suíte final no Windows com respostas do Google simuladas: 217 aprovados, zero falhas e seis pulados de 223. Registro em `../../work/teste-1.6.1-reserva-gpt.log`.

## 1.6.1 — revisão independente do teto no Windows

- Duas execuções com o app-server real, GPT-6.2 Sol e teto 10, via `node ../../work/sonda-teto-codex.mjs .`. Na primeira, a 11ª leitura chegou a iniciar e o fechamento devolveu controle sem JSON. Depois do ajuste, foram dez comandos iniciados, fechamento na mesma sessão e JSON válido com resumo, decisões, próximos passos e testes. O limite é reativo a eventos do cliente. Chamadas paralelas já iniciadas podem ultrapassá-lo.
- A última leitura pode encerrar no cliente antes que o modelo veja seu resultado. O pedido de fechamento agora inclui os totais observados e pede para conferir os efeitos antes de repetir uma ação incerta. O teste de protocolo cobre essa contagem e roda no Windows.
- Claude: o teste com falha de transporte depois de `error_max_turns` falhou no commit b61e0e4. A correção absorve a exceção específica do teto emitida pelo SDK 0.3.325 e propaga a falha original nos demais casos.
- Suíte Windows: 213 aprovados, zero falhas, seis pulados. Próxima etapa da rodada: conferir a rota real do Gemini e validar o instalador com o código revisado.

## 1.6.1 — teto de ferramentas do Claude validado no cliente real (Claude, 25/11)

- **Defeito encontrado com o cliente real:** `node ../../work/sonda-teto-claude.mjs . ` (Haiku 5.5, pasta temporária, `maxTurns: 2`). O Agent SDK 0.3.325 entrega o `result` `error_max_turns` e, em seguida, **lança** `Claude Code returned an error result: Reached maximum number of turns (2)`. Na 1.6.0, essa exceção saía do `consume` e derrubava a fala antes do turno de fechamento. Isso aconteceria em toda fala do Claude que chegasse ao teto de 80.
- **Correção (`runClaude` em `lib/providers.mjs`):** depois do `error_max_turns` da própria consulta, a exceção é absorvida e a fala segue para o fechamento. Qualquer outro erro continua subindo.
- **Testes:** o simulador do SDK em `tests/v16.test.mjs` agora lança como o real. Os 2 testes do teto falharam no código da 1.6.0 e passam com a correção. Teste novo: outro erro do SDK continua derrubando a fala.
- **Turno de fechamento confirmado no cliente real:** `tools: []` com `mcp__*` bloqueado inicia com 0 ferramentas (sem rea, Notion nem Docs) e responde no formato do `toolCapPrompt`. A primeira consulta tinha 32 ferramentas e 3 servidores MCP. O fechamento não aproveita o cache (`cache_read` 0), porque a lista de ferramentas muda. É um custo único por fala que chega ao teto.
- **Login do Claude no Windows:** `resolveExecutable` encontra `claude.exe` e `codex.exe`, então o `spawn` sem shell funciona. O `claude auth status --json` real traz `loggedIn`, `authMethod: claude.ai` e `apiProvider: firstParty`, o formato que a checagem espera.
- **Cobertura no Windows:** a suíte tem 218 testes, 211 passam e 7 ficam de fora no Windows: os 5 de login (`skip: !unix`, porque os clientes simulados são scripts `#!/usr/bin/env node`), o teto do GPT e o MCP do Claude na integração total. A contagem "216 de 217" da 1.6.0 foi feita no Linux.
- **Verificação:** `npm test` 211 passam e 0 falham (`../../work/teste-1.6.1.log`). Versão 1.6.1 sem instalador: gerar depois da revisão com `npm run dist` e `node ../../work/conferir-pacote.mjs . 1.6.0`.
- **Revisão do GPT (`4d28e93`), aceita:** teto do Codex validado no app-server real (interrompe quando a chamada que atinge o teto termina; o fechamento usa as regras de JSON da sala e informa as chamadas observadas). O Claude absorve só a exceção de teto do SDK. No refino, a regex ficou sem âncoras no prefixo, para que uma mudança de redação do SDK não volte a derrubar a fala.
- **Fala perdida do Gemini nesta rodada (25/11, 21:00–21:05):**
  - **A rota da 1.6 funcionou:** Antigravity em pausa, então Flash do AI Studio.
  - **Como a fala se perdeu:**
    - a sala tem **3 rodadas** por fala;
    - um 503 na 1ª requisição gastou uma delas;
    - a 3ª, a final, ficou 180 s em silêncio;
    - a nova tentativa única foi barrada pelo teto, e a fala terminou vazia.
  - **Correção em `lib/ai-studio.mjs`:**
    - `studioToolRounds` passa a contar **rodadas** do modelo;
    - as novas tentativas por falha do Google (503, silêncio, 429 por minuto) usam uma reserva própria (`STUDIO_RECOVERY = 2` por fala);
    - o teto absoluto fica em rodadas + 2 requisições, e todas continuam em `usage.requests`;
    - a última rodada continua sem funções.
  - **Interface:** o rótulo virou "Rodadas do AI Studio por fala".
  - **Testes:** o teste do GPT foi atualizado (503 + 3 rodadas = 4 requisições). Dois testes novos: o caso real (503 + silêncio na final termina com a resposta) e o limite da reserva. Os 2 primeiros falham no código anterior.
- **Verificação do refino:** 221 testes, 215 passam, 0 falham e 6 ficam de fora no Windows (`../../work/teste-1.6.1-refino.log`).

## 1.6.0 — contas oficiais e pendências da 1.5 (Claude, 24/11)

Pedido do usuário (24/11): o Claude estava desconectado da Synapse e não havia como entrar de novo por ela. Pediu um botão para conectar as contas oficiais e que tudo o que foi levantado e proposto até a 1.5 entrasse na 1.6, para testar com todos.

- **Botão Conectar/Reconectar (`lib/accounts.mjs`, rotas `/api/accounts/:agente/login|code|cancel`, diálogo `#account-dialog`):**
  - **GPT:** `codex app-server` → `account/login/start {type:'chatgpt'}` devolve a página do ChatGPT, que a interface abre. A conclusão chega por `account/login/completed`. Se a porta de retorno estiver ocupada, cai para `chatgptDeviceCode` e mostra o código. Cancelar chama `account/login/cancel`.
  - **Claude:** `claude auth login --claudeai`. O próprio Claude Code abre o navegador. A página manual vira um link, e o código colado no diálogo vai ao stdin do cliente (testado com o binário 2.1.325: o código é lido pelo cliente). Ao sair com 0, `claude auth status --json` precisa confirmar `claude.ai` + `firstParty` (assinatura).
  - **Gemini:** o `connectGemini` do Antigravity (ACP `authenticate oauth-personal`) agora avisa a conclusão (`onDone`) e pode ser cancelado (`cancelGeminiLogin`).
  - **Segurança:** só páginas `https` de openai.com, chatgpt.com, claude.com, claude.ai, anthropic.com e google.com chegam à interface. O código colado aceita só `[A-Za-z0-9._~#-]`, nunca é gravado e não aparece em avisos. A saída do cliente passa por `safeDiagnostic`. As rotas exigem o token CSRF. Teto de 15 min por login.
- **@menção numa resposta individual ("Só X") (pendente desde a 1.2):** `Coordinator.promoteToRound`. No Chat, o colega responde em seguida (rodada rápida, sem síntese). No Code, ele revisa o que X fez, e a rodada segue até a aprovação, só entre os envolvidos. Valem as regras das chamadas: até 3, ninguém chama a si mesmo, e quem passou do limite preventivo não é chamado por colega. O prompt individual explica o @.
- **Gemini Automático no Code com o Antigravity fora (candidato de economia da 1.5):** `studioCodeOrder()` usa primeiro o Flash do catálogo da chave (`api:gemini-3.8-flash`, mesma família da rota normal do Code, cota diária maior) e depois o Hydrogen. O Chat continua pelo Hydrogen. Um Flash escolhido no Antigravity mantém o Hydrogen como reserva. Chave recusada não troca de modelo.
- **Servidores MCP por sala (candidato de economia da 1.5):** com a integração total, `settings.mcpExclude` tira servidores das configurações do próprio usuário. No Claude, via `disallowedTools: ['mcp__nome']`, que o SDK remove do contexto do modelo. No Codex, via `mcp_servers.<id>.enabled=false`. Um servidor que é a mesma ferramenta de uma integração desligada na sala (o REA, pelo caminho do `rea.mjs`) sai automaticamente. A lista (`GET /api/integrations/user-mcp`) traz só nomes, clientes e a integração equivalente: sem comandos, argumentos nem variáveis.
- **Teto de ferramentas para Claude e GPT (pendente desde 22/11):** `settings.toolCallLimit`, padrão 80, 0 desliga, nunca no Chat.
  - **Claude:** `maxTurns`. No `error_max_turns`, a mesma sessão recebe `toolCapPrompt` com `tools: []`, `mcp__*` bloqueado e `maxTurns: 1`. O uso das duas consultas é somado.
  - **GPT:** conta os itens de ferramenta. Ao passar do teto, `turn/interrupt` e um turno de fechamento na mesma conversa, com aprovações recusadas. Se ele insistir em mais de 3 ferramentas, encerra com o texto que houver. Sem texto nenhum, a fala termina com um aviso da Synapse (`capFallback`), sem derrubar a rodada.
  - **Sem `sandboxPolicy` no turno de fechamento:** a política sobrescrita valeria para as falas seguintes da conversa.
- **Uso do Gemini pela origem (em aberto na 1.5):** `Providers.geminiOrigins()`. O AI Studio mostra as requisições contadas pela Synapse desde a meia-noite do Pacífico (`pacificMidnight`), por modelo, e as pausas gravadas. O Antigravity mostra se a conta Google está conectada e a pausa da cota.
- **Fora da 1.6, por decisão do usuário:** esforço menor nas revisões ("nada de reduzir o esforço").
- **Verificação:** 217 testes, 216 passam e 1 é exclusivo do Windows. Novos: `tests/contas.test.mjs` (8, com Codex e Claude simulados por scripts locais) e `tests/v16.test.mjs` (16). Prévia isolada com clientes simulados (`/api/accounts` com os mesmos scripts): Claude desconectado → código colado → conectado; GPT com código de dispositivo; cancelar; lista de MCP; teto; celular. Console sem erros.
- **Não verificado com as contas reais:** os três logins no Windows (abrir o navegador a partir do servidor oculto, retorno local do Codex na porta 1455, Antigravity), o turno de fechamento do Codex depois de `turn/interrupt` no app-server real e o `maxTurns` do Claude Code real.

### Roteiro de teste da 1.6 com o grupo

1. **Contas:** clicar em **Conectar** no Claude, concluir no navegador (ou colar o código) e ver "Conectado ao Claude". Repetir **Reconectar** no GPT e no Gemini.
2. **Só X com @:** enviar para "Só Claude" um pedido em que ele precise da opinião de outro ("pergunte ao @Gemini…"). O Gemini deve responder em seguida, e Ações deve mostrar "Claude chamou Gemini".
3. **Teto:** numa sala de teste em Code, colocar **Ferramentas por fala** = 10 e pedir uma tarefa longa. A fala deve fechar com resposta, e Ações deve mostrar "Teto de ferramentas · … fecha a fala". Depois, voltar para 80.
4. **MCP por sala:** com a integração total, desmarcar o `rea` (ou desligar o REA) e comparar em Análises os tokens de cache por fala com a 1.5 (`node ../../work/consumo-por-fala.mjs <data>`).
5. **Gemini:** conferir no cartão as linhas AI Studio/Antigravity. Com o Antigravity em pausa no Code, Ações deve mostrar "alternando para AI Studio (gemini-3.8-flash)".
6. **Pendências que só se verificam com uso real (continuam abertas):** consumo por fala na 1.6, nomes de esforço do Antigravity quando a cota voltar, navegador pessoal e uso do computador no Codex, `ask_question` do Gemini por ACP e elicitação real de conectores do Codex.


## 1.5.0 fechada pelo Claude (23/11, 21:50 de Brasília)

- **Pronta para o botão:** `dist/Synapse-Setup-1.5.0.exe` (SHA-256 `191a8aa7…8ee8d985`), gerada no commit `4629b1b`. `conferir-pacote.mjs`: 39 arquivos idênticos ao repositório (os 2 ausentes são scripts de build), versão 1.5.0 no pacote, e a busca a partir da 1.4.0 encontra a 1.5.0. Instalada: 1.4.0. O candidato antigo em `../../work/revisao-synapse-1.5.0` está obsoleto.
- **Por que a revisão do Gemini não saiu (00:36–00:42Z, `work/eventos-gemini.mjs`):** o Hydrogen leu 11 arquivos inteiros (a 1.4.0 instalada não tem limite de leitura), recebeu 429, recomeçou a fala do zero e recebeu outro 429, agora da cota diária, com pausa até 24/11, 04:59 de Brasília. Depois, a troca de configuração caiu no Flash do AI Studio, que respondeu 503. A 1.5 corrige as duas perdas: leitura em partes e espera no 429 por minuto sem recomeçar a fala. O usuário pediu que o Claude fechasse sozinho; o Claude revisou o `395ee45` no lugar do Gemini.
- **Economia sem perder qualidade (`TOOL_ECONOMY` em `lib/coordinator.mjs`):** o custo de uma fala de Code é (chamadas de ferramenta) × (tamanho do contexto). Medido em 23/11: Claude de 5,4 a 12,3 mi de tokens do cache por fala de Code, e o Codex com 13,7 mi. Agora o prompt de Code dos três participantes pede para agrupar chamadas independentes, ler trechos de arquivos grandes, limitar saídas e não reler o que não mudou, sem deixar de verificar. O Chat não recebe a linha. Medir na 1.5 com `node ../../work/consumo-por-fala.mjs <data>`.
- **Verificação:** 193/193 testes (`../../work/teste-1.5.0-final.log`); o teste de prompt cobre execução, revisão, somente leitura e Chat.
- **Próximos passos:**
  1. Usuário: **Reiniciar para atualizar · 1.5.0**.
  2. Medir o consumo por fala na 1.5 e comparar com os números acima.
  3. Candidatas a economia: servidores MCP por sala (o `rea` tem 229 ferramentas e não serve a esta sala) e a ordem do Automático do Gemini quando só o Hydrogen está livre no Code (em 23/11 a cota diária acabou depois de umas 25 requisições, uma estimativa feita pelos eventos).
  4. Teto de ferramentas para Claude e Codex continua pendente (`--max-turns` encerra sem texto final).

## Refino do Claude (23/11, 21:40 de Brasília)

- **O candidato do instalador em `work/revisao-synapse-1.5.0` ficou desatualizado:** o código mudou depois dele. Depois da revisão do Gemini, rodar `npm run dist` e `node ../../work/conferir-pacote.mjs . 1.4.0`.
- **Princípio de economia definido pelo usuário (23/11):** gastar menos cota sem perder a qualidade. Nada de reduzir o esforço. A pendência "esforço menor nas revisões" foi descartada. Medidas válidas: menos contexto relido, menos falas e requisições perdidas, menos falas redundantes.
- **Resposta direta a uma mensagem (pedido do usuário):**
  - Cada mensagem tem o botão **Responder**. Com um trecho selecionado dentro dela, a resposta cita exatamente esse trecho.
  - Um aviso acima da caixa de texto mostra a quem você responde. Clicar nele leva até a mensagem; × ou Esc cancela.
  - A mensagem enviada mostra a citação, que também leva ao original.
  - **Servidor:** coluna `messages.reply` (`{id, role, quote?}`), validada nas rotas de mensagem, de orientação durante a rodada e de Continuar. A mensagem citada precisa existir na mesma sala. O trecho tem no máximo 1.200 caracteres.
  - **Agentes:** o histórico recebe `respondendo_a` com o autor e o trecho selecionado, ou com o começo da mensagem (300 caracteres). Uma linha explicativa só entra quando há resposta, sem custo nas demais falas. A citação funciona também no prompt incremental, mesmo quando a mensagem citada é antiga.
- **HTTP 429 do Hydrogen no meio da fala:** a revisão do Gemini desta rodada (21:17–21:19) leu 17 arquivos em 5 rodadas e recebeu um 429 com volta em cerca de 1 s. Era o limite por minuto, e a fala inteira se perdeu.
  - Agora, depois de ferramentas ou texto, um 429 do limite por minuto espera o tempo indicado pelo Google (até 65 s) e repete, no máximo 2 vezes por fala. A tentativa conta no teto de requisições.
  - Um 429 da cota diária (`QuotaFailure` com "PerDay"), com volta distante, ou ocorrido antes de qualquer ferramenta segue direto para a troca de rota, como antes.
- **Revisão do GPT (`d98f327`):** aceita sem alterações.
- **Gemini pelo "próprio Gemini":** a página de preços do Antigravity lista Gemini 3.8, 3.7 e 3.6 Flash e 3.1 Pro, sem o Hydrogen. O `agy models` desta conta mostrou só o Flash. O Gemini CLI segue só com chave de API paga. Hoje o Hydrogen só está acessível pelo AI Studio. A Synapse relê o catálogo do Antigravity, então o Hydrogen aparece sozinho se o Google o incluir lá. Automatizar o app web do Gemini não é uma rota oficial.
- **Verificação:** 193/193 testes, 5 novos (3 em `tests/resposta-direta.test.mjs`, 2 de 429 em `tests/economia-1.5.test.mjs`). Vitrine isolada na porta 4437: selecionar um trecho, Responder, enviar, ver a citação e cancelar com Esc. Console sem erros nem avisos. Capturas em `../../work/ui-1.5-resposta-*.png`.

## 1.5.0 em revisão (23/11, 21:10 de Brasília)

- A versão instalada informada é 1.4.0. O candidato da 1.5.0 está em `../../work/revisao-synapse-1.5.0/Synapse-Setup-1.5.0.exe`. O atualizador da 1.4.0 reconheceu o candidato nessa pasta. Após a próxima revisão, se o código empacotado continuar igual, copiar o executável e seu blockmap para `dist`. Se houver alterações no produto, reconstruir e conferir o pacote atualizado.
- Revisão do GPT: 188 testes passaram. Conferidos 39 arquivos da aplicação extraídos do instalador, além da versão do manifesto. SHA-256 do candidato `9A1A7C19DD3EB39B6F9ED8324C63365874C5B8959C10B6B01516036F2ECD8777`. Playwright com o servidor empacotado verificou fundo preto, abas, filtros concorrentes, telemetria parcial e persistência do teto configurado.
- O teto do AI Studio conta tentativas HTTP, fica acessível nas configurações e reserva a última requisição para a resposta. A leitura de uma linha longa continua pela coluna indicada. A aba Análises inclui tokens já informados antes de uma interrupção do AI Studio, identifica estimativas antigas do GPT e apresenta esforço como a escolha da sala.
- O teste do lockfile distingue alterações de versão da raiz de alterações nas dependências. Ativos do produto e capturas de versão parciais exigem cautela na aprovação. A orientação enviada durante a última revisão do Code chega a uma nova fala antes de encerrar a rodada.
- **Caso real que motivou a parte do Gemini (23/11, 20:56):** a troca Antigravity (pausa até 28/11, 11:27) → Hydrogen funcionou. O Hydrogen raciocinou e leu 10 arquivos, mas a requisição seguinte ficou 120 s sem resposta e a fala inteira se perdeu, com as requisições já gastas. Diagnóstico com `work/eventos-gemini.mjs` (somente leitura).
- **AI Studio (`lib/ai-studio.mjs`):**
  - `read_file` devolve no máximo 40 mil caracteres por chamada, com `startLine`/`endLine` e `nextStartLine`. Cada rodada reenvia tudo o que já foi lido.
  - Teto de requisições por fala: opção `studioToolRounds` (padrão 6, de 2 a 20). A última vai com `toolConfig NONE`, e o Gemini responde com o que já verificou. Antes, a 8ª rodada dava erro e a fala se perdia.
  - Rodadas depois de ferramentas esperam 180 s pelo primeiro evento e, se nada chegar, repetem a mesma requisição uma vez. Nenhuma ferramenta é refeita. Silêncio na primeira requisição continua indo para a troca de rota.
- **Rodada em grupo (`lib/rounds.mjs`, `Versions.docsOnly`):**
  - Mudança só de documentação (.md, .txt, .log, capturas) ou só do campo `version` do npm não exige outra fala de verificação.
  - Um refino sem mudança de código, concluído por quem não escreveu a última alteração, vale como aprovação e encerra a rodada. Se o autor da última alteração recusar as críticas sem mudar nada, a revisão independente continua.
- **Preto como cor principal (`public/tema.css`, camada 1.5):** fundo `#000`; superfícies `#050506`, `#0B0B0E` e `#141418`. Enviar, Nova sala, botões primários, Continuar, aba e filtros ativos ficaram pretos com contorno neon, que acende ao passar o mouse. Janela do Electron, tela de abertura e `theme-color` em `#000`. Selo v1.5.
- **Verificação:** 183/183 testes, 8 novos em `tests/economia-1.5.test.mjs`. Vitrine isolada com cópia do banco: `work/ui-1.5-interface.png` e `work/ui-1.5-analises.png`, console sem erros nem avisos.
- **Em aberto:**
  - O Google migrou o uso individual de Gemini CLI, inclusive AI Pro e Ultra, para o Antigravity CLI em junho de 2026. O comando real `agy models` retornou Flash Low, Medium e High para a conta. Em uma sessão ACP sem inferência, initialize e session/new não retornaram percentuais de cota. O cliente disponibiliza o painel interativo `/usage`. O uso do app Gemini, a cota da conta no Antigravity e o consumo da API devem ser identificados pela origem. [Migração oficial](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) · [Cotas do Antigravity](https://antigravity.google/docs/cli/commands/usage)
  - Teto de ferramentas para Claude e Codex. O `--max-turns` do Claude Code encerra sem texto final, então não foi aplicado.
  - Esforço menor em revisões. Depende da decisão do usuário.

## 1.4.1 em revisão (23/11, 14:45 de Brasília)

- **Instalada:** 1.4.0 (confirmado no `server.log`). **No repositório:** 1.4.1, sem instalador. Gerar com `npm run dist` depois da revisão e conferir com `node ../../work/conferir-pacote.mjs . 1.4.0`.
- **Abas Interface | Análises** no cabeçalho (Alt+1 e Alt+2; a escolha fica salva em `localStorage` `synapse.vista`).
  - **Servidor:** `lib/analytics.mjs` normaliza o uso dos três clientes por fala (novos = entrada sem cache, cache, saída, pensamento, esforço da rodada e modo). Rota `GET /api/analytics?since=ISO&roomId=` somente leitura.
  - **Codex:** o `total` do `thread/tokenUsage/updated` é da conversa inteira. Agora `codexTurnUsage` grava `usage.turn` com o custo só da fala, com a base tirada da primeira requisição. Registros antigos são estimados pela diferença do total na mesma sala e modo, e a aba avisa.
  - **Interface (`public/analises.js`, SVG próprio, sem bibliotecas):** 6 indicadores com contagem animada, barras empilhadas por participante ao longo do tempo (1 h, 6 h, dia ou semana, conforme o período), mapa de calor por hora do dia, média por fala em cada nível de esforço (com o nome do cliente oficial), as 6 falas mais caras e a tabela por modelo e modo. Filtros: período, todas as salas ou esta sala, e medida (novos, cache, saída, total). A aba se atualiza sozinha com as falas novas.
- **Tema neon:** preto `#030304`, branco `#FAFAFA`, GPT `#00E5A0`, Claude `#FF6A1F`, Gemini `#3D8BFF`, destaque `#00F0FF`/`#FF2BD6`. Pelo validador de paletas, a separação para daltonismo dá ΔE ≥ 14 em todos os pares. A faixa de luminosidade é ultrapassada de propósito, por ser neon. Janela do Electron e tela de abertura também em `#030304`.
- **O que os dados reais mostram (56 falas, 21–23/11):**
  - O Claude em Code é o maior consumidor: 17 falas, 113,9 mi de tokens lidos do cache e 2,1 mi novos.
  - Em tokens novos, uma fala de Code custa em média de 1,6 a 3,3 vezes uma de Chat do mesmo participante: Claude 124 mil contra 75 mil, Gemini Flash 127 mil contra 48 mil e GPT 76 mil contra 23 mil.
  - O pico foi em 22/11, às 12h.
- **Verificação:** 175/175 testes, 4 novos em `tests/analises.test.mjs`. A instância isolada usou a cópia do banco real feita por `VACUUM INTO` em `work/synapse-vitrine.mjs <raiz> <porta> <banco>`. As capturas estão em `work/ui-1.4.1-*.png`. Na verificação visual, corrigi os gráficos encolhidos pela regra global `svg` dos ícones, os indicadores quebrando em 5+1 e o alinhamento da tabela.
- **Teste do Hydrogen sem o Flash:** depende da próxima fala do Gemini na 1.4.0. A pausa do Hydrogen venceu às 04:59. A do Antigravity ainda não foi gravada, porque o Gemini não falou desde a instalação. No Code, o modo Automático tenta o Antigravity, recebe o aviso de cota, grava a pausa e passa para o Hydrogen.

## Para retomar (23/11, 17:30)

- **Instalada:** 1.3.2. **Pronta para o botão de atualizar:** 1.4.0 (`dist/Synapse-Setup-1.4.0.exe`, commit `8aca133`).
- **Conferência final, feita pelo Claude sozinho a pedido do usuário** (GPT e Gemini estavam sem cota):
  - 171 de 171 testes passam.
  - Os 37 arquivos de código do instalador são idênticos aos do repositório.
  - A busca de atualização da 1.3.2 encontra a 1.4.0.
- **Detecção do aviso de cota (revisão do GPT):** testei 5 casos, e todos dão o resultado certo.
  - O aviso real vira o horário de volta, e o aviso sem horário também conta como cota esgotada.
  - Uma explicação curta que cita o aviso não conta como cota esgotada.
  - Uma resposta que começa com "Quota…" fica retida na escrita ao vivo e aparece inteira quando termina. Não é tratada como cota.
- **Cotas:**
  - **Antigravity:** sem cota até cerca de 28/11, 11:27. O Gemini segue pelo Hydrogen depois da instalação.
  - **Codex:** volta às 19:01 de 23/11.
- **Próximos passos:**
  1. Medir a economia por tarefa na 1.4 com `work/consumo-por-fala.mjs`.
  2. Pular a fala de verificação quando a mudança é só de documentação ou versão.
  3. Teto de chamadas de ferramenta por fala.
  4. Conferir os nomes de esforço do Antigravity quando a cota voltar.
  5. Testar navegador pessoal e uso do computador no Codex.
  6. Esforço menor em revisões. Precisa da decisão do usuário.

## 1.4.0 disponível para atualização (23/11)

- **Conversa renovada por tamanho (`coordinator.mjs`, `routing.mjs/contextTokens`, opção `sessionMaxTokens`, padrão 140 mil, 0 desliga):**
  - **Problema medido:** cada fala do Gemini pelo Antigravity pagava cerca de 170 mil tokens de entrada sem cache, e cada chamada de ferramenta do Claude relia de 190 a 240 mil.
  - **Solução:** quando o contexto da última fala de um participante passa do limite, a próxima fala começa uma conversa nova, com o prompt completo, e registra o aviso "conversa renovada" em Ações.
  - O Codex usa `last.totalTokens` da última requisição. Registros antigos usam entrada e, se disponível, saída. Claude usa a última iteração e Antigravity usa `inputTokens`. O AI Studio não retoma conversa.
  - **Testes:** `tests/conversa-renovada.test.mjs` (2).
- **Front-end:**
  - **Estrutura:** `public/tema.css` é uma camada nova, carregada depois de `styles.css` e servida em `/tema.css`. O `app.js` recebeu os comportamentos.
  - **Trilho de salas:** recolhível (botão ou Ctrl+B), com as iniciais das salas. A largura vai de 200 a 380 px pela alça, que aceita setas e volta ao padrão com clique duplo.
  - **Painel do projeto:** recolhível acima de 1180 px e redimensionável de 280 a 560 px. O layout fica salvo em `localStorage` (`synapse.layout`).
  - **Uso:** anéis por janela, que animam a partir do valor anterior e mudam de cor em 70%, 85% e 100%. O rodapé das salas tem um anel por participante, que abre o painel.
  - **Escrita ao vivo:** só a mensagem em andamento é redesenhada, a cerca de 30 quadros por segundo. Antes, a conversa inteira era refeita a cada 65 ms. O texto aparece em ritmo contínuo, com cursor, e o participante que escreve fica destacado no painel e no rodapé.
  - **Microinterações:** onda de clique nos botões, entrada de mensagens e diálogos e elevação ao passar o mouse.
  - **Movimento reduzido:** a regra global desliga as animações, e a escrita mostra o texto inteiro de uma vez.
- **Verificação visual:**
  - `work/synapse-vitrine.mjs` sobe uma instância isolada, com pasta de dados temporária, participantes simulados e uso fictício. Nenhuma chamada real vai aos clientes.
  - As telas, capturadas com Playwright, estão em `work/ui-1.4-*.png`: expandido com escrita ao vivo, trilho e painel recolhidos, e o trilho isolado.
- Na revisão do GPT, o catálogo do Codex anunciou seis níveis para GPT-6.2 Sol. O seletor do CLI para GPT-6.2-Astra mostrou Low, Medium, High, Extra high, Max e Ultra. A Synapse usa os níveis anunciados pelo modelo, inclusive o padrão da conta. O Hydrogen oferece Low, Medium, High e Extra High. As variantes do Antigravity são preservadas na releitura do catálogo.
- Na thread efêmera em modo Computador, o Codex carregou 69 skills e uma única instância de REA com 229 ferramentas. Em Chat, os MCP herdados de configuração ficaram sem ferramentas. A consulta de perfil do Gmail funcionou na participação real.
- **Refino do Claude (`6375027`):**
  - **Aviso de cota do Gemini gravado como fala (caso real de 23/11, 17:11).** O Antigravity respondeu com "⚠ Individual quota reached… Resets in 117h16m41s", e a Synapse gravou esse aviso como fala do Gemini, sem passar para o Hydrogen.
    - Agora `antigravityQuota()` reconhece esse tipo de resposta: curta, com o aviso de cota. Ela vira `RATE_LIMIT` com o horário de volta.
    - `runNativeRoute` grava a pausa em `provider_state.antigravity`. Enquanto ela durar, o Antigravity nem é aberto e o Hydrogen assume.
  - **Nomes de esforço como no cliente oficial.** Conferi no binário do Claude Code: Low, Medium, High, **Extra** (`xhigh`) e Max.
    - `effortLabel(provider, level)` aplica o nome de cada participante, no servidor e na interface.
    - Para o Codex, o nome exibido para `xhigh` é Extra high.
- A revisão do GPT reproduziu um falso positivo ao citar o aviso de cota. O adaptador passou a reconhecer a mensagem completa e a reter o prefixo durante o streaming. A consulta ao catálogo também respeita a pausa da conta.
- No teste com as contas reais, o Antigravity informou uma pausa de 117h09m17s. O coordenador tentou o Hydrogen e recebeu HTTP 503 do AI Studio. A resposta da rota alternativa foi verificada em teste simulado. O teste real usou armazenamento temporário.
- A suíte passou com 171 testes. O atualizador encontrou a 1.4.0 a partir da 1.3.2. Os 34 arquivos de implementação extraídos de `dist/Synapse-Setup-1.4.0.exe` tiveram os mesmos hashes do projeto. O manifesto extraído informa 1.4.0. O Playwright verificou os controles do trilho, persistência, anel de uso e rótulos com o servidor empacotado.
- Após a instalação, medir economia por tarefa e observar a primeira resposta completa após uma troca real. Permanecem a revisão da política de verificação só de documentação, o teto de ferramentas por fala e os testes de navegador pessoal e automação do computador.

## Para retomar (estado em 22/11, 23:40)

- **Instalada:** 1.3.1. **Empacotada:** 1.3.2 (`dist/Synapse-Setup-1.3.2.exe`). Git limpo; a linha de base da rodada é `e8b42f0`.
- **Cotas:**
  - **GPT:** esgotado.
  - **Hydrogen:** pausa até 04:59 de 23/11. É uma cota diária baixa e cada rodada de ferramentas conta como uma requisição.
  - **Antigravity:** 37% da semana restantes, renova em 5 dias (relato do usuário).
- **Medir antes e depois:** `node work/consumo-por-fala.mjs <desde-ISO>` lê o banco sem gravar nada e mostra, por fala, os tokens novos, os lidos do cache e os de saída. Base de 22/11:
  - Uma fala de Code custou de 1,4 a 7 milhões de tokens lidos do cache (Claude 2,4–7,1 M; Codex ~3,5 M; Flash 1,4–3,4 M).
  - Uma fala de Chat custou de 0,1 a 0,4 M.
  - O custo vem do número de chamadas de ferramenta (cada uma relê o contexto) e do número de falas por rodada (16 etapas nesta).
- **Próximas medidas de economia, em ordem:**
  1. **Pular a verificação quando a mudança é só de documentação ou versão.** Hoje, a troca de versão no `package.json` gera uma fala inteira de verificação.
  2. **Esforço menor em verificação e revisão**, com opção na sala. Precisa da decisão do usuário.
  3. **Teto de chamadas de ferramenta por fala**, com aviso.
  4. **Codex:** confirmar se o `mcp_servers` enviado pela Synapse substitui ou mescla a tabela do usuário. Se mesclar, aplicar ao Codex a remoção de duplicados feita no Claude.

## 1.3.2 — fala cortada, MCP duplicado, alternância Hydrogen ↔ Flash e economia provisória

- **Economia provisória (Claude, pedido do usuário em 23:26):**
  - **Gemini automático** começa pelo Hydrogen no Chat (uma requisição por fala) e pelo Antigravity no Projeto e no Computador. A alternância continua valendo nos dois sentidos. A dica da opção na interface foi atualizada. **O usuário precisa escolher "Automático"**: com o Flash escolhido explicitamente, o Hydrogen só entra quando o Flash esgota.
  - **Uso do AI Studio** soma todas as rodadas da fala e informa `requests`. Antes registrava só a última requisição: a fala das 22:18 aparecia com 21 mil tokens novos, mas fez cerca de 6 requisições.
  - **Ações:** cada ferramenta do Antigravity aparecia 4 vezes. Agora aparece uma vez por mudança de estado, em andamento e concluída (`geminiToolActivity`).

- **Alternância bidirecional Hydrogen ↔ Flash (`providers.mjs`):** atendendo ao pedido explícito do usuário ("utilizar tanto o 4 Hydrogen quanto o 3.8 Flash, esgotou o limite de um passa para o outro!"). Quando o Hydrogen esgota a cota (HTTP 429 RATE_LIMIT, 503 UNAVAILABLE ou pausa ativa), alterna automaticamente para o Antigravity (Flash) com aviso em Ações, sem interromper o turno. De forma simétrica, quando o Antigravity atinge limite ou fica indisponível, alterna para o AI Studio (Hydrogen). Falhas de credencial (`AUTH_REQUIRED`) continuam sendo exibidas para intervenção do usuário.
- **Refino da alternância (Claude):** 5 testes novos em `hydrogen.test.mjs`, e os 5 falham na versão `4d0ca7a`. Problemas corrigidos:
  1. **Pausa errada no Hydrogen:** com o Hydrogen em pausa, uma falha do Antigravity gravava a pausa de 5 h do Antigravity no lugar da pausa do Hydrogen, e a mesma chamada ao Antigravity ainda era repetida.
  2. **Pausa não gravada:** o 429 do Hydrogen, quando vinha na troca a partir do Flash, não ficava registrado. Agora `runStudioRoute` grava a pausa nos dois sentidos.
  3. **Trabalho refeito:** o Antigravity não avisava que já tinha executado ferramentas. Agora `toolExecuted` e `partialText` vêm marcados, e a outra rota não refaz a fala.
  4. **Regressão no automático:** uma chave recusada parou de cair para o Antigravity. Voltou a cair.
  - **As duas rotas falham:** vale o horário de volta mais próximo, e a mensagem cita as duas falhas.
- **Consumo real do Hydrogen (banco):** a fala das 22:18 fez cerca de 6 requisições (5 rodadas de ferramentas e a resposta). A seguinte recebeu 429, e a pausa gravada vai até `2026-11-23T07:59:59Z` (04:59 em Brasília), o que indica uma cota diária. Cada rodada de ferramentas conta como uma requisição. A fala do Flash das 22:32 leu 3,39 milhões de tokens do cache.
- **Fala cortada (`routing.mjs/parseHandoff`):** a primeira fala real do Hydrogen (22:18, `fac60fff…`) foi gravada como concluída, mas termina em "regras de \`". O AI Studio informou 1.073 tokens de saída, e o texto salvo tem cerca de metade disso. Causa: a regex ia da **primeira** `<mesa_status>` (uma citação no texto) até o fechamento do bloco real. O JSON falhava, o resto da fala sumia e a memória recebia o texto cortado. Agora um bloco não pode conter outra abertura, vale o último bloco com JSON válido e as citações ficam no texto. O texto bruto não é gravado, então a causa foi reproduzida em teste, sem a fala original.
- **MCP duplicado (`integrations.mjs`, `claudeOptions`):** com integração total, o Claude carregava o `rea` do usuário (`~/.claude.json`) e o `mesa_rea` da Synapse, o mesmo `rea.mjs`. Agora a cópia `mesa_*` sai quando o mesmo script já está nos escopos de usuário ou local. O Codex não mudou: não se sabe se `mcp_servers` nas configurações enviadas pela Synapse substitui ou mescla a tabela do usuário.
- **Testes:** 163/163 (`hydrogen.test.mjs` 15, `handoff-parse.test.mjs` 5).

## 1.3.1 — Git, Hydrogen e contexto incremental (revisado pelo GPT e pelo Claude; instalador gerado no refino)

- **Git:** `outputs/synapse` virou repositório (`main`), com identidade só local. O commit `e8b42f0` é a linha de base da 1.3.0. Use `git diff e8b42f0` para revisar a rodada.
- **Hydrogen, diagnóstico pelo banco (somente leitura):** até as 21:18 de 22/11, todas as tarefas da sala usaram `gemini-3.8-flash` (Antigravity). O Hydrogen só entrou na tarefa das 21:43. A única tentativa anterior (16:03) parou no limite de 45 s sem dados, e o cancelamento foi do cliente, por isso o painel do AI Studio não mostra erro. Às 21:44, três sondas receberam HTTP 503 "high demand".
- **Hydrogen, correção (`ai-studio.mjs`):** `thinkingConfig.includeThoughts: true` sempre, mais o `thinkingLevel` da sala. Se o modelo recusar (400), a fala segue sem configuração. Novas tentativas em 503 (4 s e 10 s). Limite de 120 s até o primeiro evento e de 60 s entre eventos. Evento "Gemini · raciocinando". As partes de pensamento voltam ao modelo (assinaturas), mas não entram no texto.
- **Hydrogen, rota:** a escolha explícita mantém o modelo fixo. Se a API continuar indisponível, o coordenador registra a falha e pode passar a vez em grupo. A seleção automática permite trocar de provedor. O selo usa `modelVersion` quando recebido da API.
- **Hydrogen, validação real:** sonda `work/hydrogen-probe.mjs` com `includeThoughts` e `low`: HTTP 200, primeiro pensamento em 3,7 s, texto em 7,1 s, maior silêncio de 1,7 s, `STOP` e `modelVersion` gemini-4-hydrogen. Com `high`, 503 por demanda no mesmo minuto.
- **Contexto incremental:**
  - **Causa:** os três clientes retomam a sessão (`resume`, `thread/resume`, `session/load`) e a Synapse reenviava cerca de 70 mil caracteres de histórico e memória por fala. Cada fala somava um prompt inteiro ao contexto do cliente, o que explica os 150 a 200 mil tokens de entrada medidos nas falas de Chat do Claude.
  - **O que mudou:** `sessions.watermark` e `replyId` (migração automática). `resumePrompt()` envia só as mensagens posteriores à marca (sem a própria resposta), a memória nova dos colegas, a coordenação e as regras do `<mesa_status>`. `promptFor()` usa o incremental só quando a sessão foi de fato retomada. AI Studio, sessão recriada e `loadSession=false` recebem o completo. A marca só avança em fala concluída. A opção `incrementalContext` (padrão true) permite desligar.
  - **Medição com as 14 falas reais de 22/11** (`work/medir-incremental.mjs`): de 990 mil para 295 mil caracteres (−70,2%).
- **Revisão do GPT:** chamada real de texto pelo adaptador `runStudio` em `high`, sem ferramentas nem histórico da sala. A API devolveu `modelVersion: gemini-4-hydrogen` e o texto esperado em 4,57 s. O temporizador do streaming agora cobre também a espera pelos cabeçalhos HTTP.
- **Retomada:** o coordenador prioriza as mensagens novas do usuário ao cortar o histórico e conserva a ordem cronológica no prompt. A alteração do briefing abre outra sessão. O teste de orientação concorrente usa a API da sala e uma resposta posterior de 57 mil caracteres. Essa orientação sumia antes da correção.
- **Ferramentas:** o servidor Playwright de projeto anunciou 25 ferramentas e recuperou um marcador aleatório em uma página local de teste via `browser_navigate` e `browser_snapshot`.
- **Retomada real do Codex:** duas falas pela Synapse em uma sala temporária. Na segunda, o Codex recuperou o UUID aleatório da primeira. O prompt incremental tinha 1.989 caracteres e não incluía o UUID. O cliente reportou 12.724 e 13.218 tokens de entrada, respectivamente, e zero tokens de leitura de cache nas duas falas. A variação de cota não foi medida.
- **Refino (Claude), retomada real nos outros dois clientes** (`work/retomada.mjs`, via `Providers.run` com `prompt` e `resumePrompt` diferentes):
  - **Claude:** mesma sessão, código recuperado. Fala 2 com 10.455 tokens lidos do cache e 394 gravados.
  - **Gemini/Antigravity (3.8 Flash, low):** mesma sessão, código recuperado. Fala 2 com 1.664 tokens lidos do cache.
  - Os três clientes estão validados.
- **Efeito da chave com briefing (GPT):** as sessões gravadas pela 1.3.0 não têm `|brief:` na chave. Na primeira fala da 1.3.1, cada participante abre uma sessão nova com o prompt completo, e a partir daí recebe incrementos. Na prática, isso descarta uma vez as sessões antigas, que já tinham 150 a 200 mil tokens.
- **Decisão aceita:** o Hydrogen escolhido explicitamente não cai para o Flash e passa a vez, como o usuário pediu: "se ele não responder, vamos seguir sem ele".
- **Pendente na instalação:** medir tokens e cota por tarefa, testar as skills e conectores restantes pelos clientes oficiais e remover a duplicidade `rea`/`mesa_rea` nas ferramentas do Claude com integração total.

## 1.3.0 — Integração total (recursos das interfaces oficiais)

Pedido do usuário: integrar à Synapse os recursos das interfaces oficiais. A 1.2.0 foi instalada pelo botão "Reiniciar para atualizar" (primeira validação real do atualizador), e a Autonomia está ligada nesta sala, com eventos "Aprovado pela Autonomia".

Inventário feito com os próprios clientes (sondas em `work/integracao`, sem gastar cota):
- **Codex 0.167** (`codex features list`): apps, plugins, hooks, multi_agent, browser_use(_external), computer_use, image_generation, memories e workspace_dependencies vêm ligados no cliente oficial, e a Synapse os desligava. Uma thread efêmera abre com as duas configurações (`gpt-6.2-astra`), e as skills da máquina incluem built-in-browser, chrome-browser, computer-use, deep-research, Google Drive, Notion e modelos de artefatos.
- **Claude Code 2.1.312** (`initializationResult`): no modo padrão (safe-mode), 0 comandos ou skills e nenhum MCP. Na integração total, 64 comandos/skills e o MCP `rea` da configuração do usuário.
- **Antigravity 1.5.9/ACP 1.5.14**: perfil restrito com 6 ferramentas e 3 comandos. Agente padrão com 17 ferramentas (subagentes, research, image-generator, run_workflow, swarm, schedule, ask_question…) e 11 comandos (/browser, /goal, /schedule…). Os nomes `read_file`, `run_command` etc. são válidos. Uma sonda do perfil restrito travou uma vez por 180 s e na repetição terminou em 10,9 s: intermitente, sem causa encontrada.

Implementação (`settings.fullIntegration`, desligada, só Projeto/Computador, em `GRANTS` e na chave da sessão `|total`):
- **Claude** (`claudeAccess`/`claudeLaunch`/`claudeToolPolicy`): `tools: {preset: 'claude_code'}`, `settingSources: user/project/local` e sem safe-mode, strict-mcp-config, no-chrome e disable-slash-commands. Internet desligada → `disallowedTools` WebSearch/WebFetch. Ferramentas sem efeito (Read, Grep, Glob, TodoWrite, Task/Agent, Skill…) não pedem aprovação. O resto continua `ask`. As regras de permissão das configurações do próprio usuário passam a valer, como na interface oficial.
- **Codex** (`codexFeatureConfig`): na integração total não sobrescreve os recursos (ficam os padrões do Codex). Sem internet, desliga browser_use, browser_use_external e apps. `mcpServer/elicitation/request` (conectores) agora é tratado: formulário vira perguntas e URL vira autorização, com `requiresUser`, nunca pela Autonomia (`elicitacaoParaPedido`/`respostaElicitacao`).
- **Gemini** (`googleLaunch`): agente padrão do Antigravity, sem `--agent` e com as personalizações do usuário, em perfil `…-total`. Exige internet ligada: sem ela fica no perfil restrito, porque o agente padrão pesquisa na web. A rota AI Studio não muda.
- **`rpc.mjs`**: uma mensagem acima de 16 MB fechava o canal inteiro e derrubava a fala. O `plugin/list` do Codex passa disso. Agora a mensagem é descartada: a resposta a um pedido nosso falha na hora, o pedido do cliente recebe erro e a notificação é contada.
- Interface: opção "Integração total" em Configurações → Acesso.
- Testes: `tests/integracao-total.test.mjs` (8). Suíte: 137/137. Gemini ponta a ponta pela Synapse com integração total: 17 ferramentas, `gemini-3.8-flash`, 10 s.
- **Não verificado:** uma fala real do Codex com integração total (sem cota até 16:53 de Brasília), incluindo browser e computer use pelo app-server. O canal de conectores (elicitação) foi testado só com dados simulados. Também falta confirmar se o `ask_question` do Gemini chega por ACP de um jeito que a Synapse trata.

## 1.2.0 — Limite preventivo de uso ("passar a vez") corrigido

O usuário relatou, no meio da rodada, que o GPT esgotou o limite com a opção em 90% e deixou uma resposta parcial. A API local mostrou o Codex com a janela de 5 horas em 100% (renova às 19:53 UTC) e o RATE_LIMIT registrado às 15:21 UTC. O uso no começo da fala não estava registrado em lugar nenhum.

Causa no código: `available()` só punha quem passou de `handoffPercent` no fim da lista, o que valia apenas para escolher o líder em `startRound`. `planNext` usava a lista só para saber quem *pode* falar e escolhia revisores e analistas pela ordem fixa da rodada. Na 1.1.3 instalada, o teste novo reproduz o defeito: `[claude, codex, gemini]` com o GPT a 96%.

Correção:
- `Coordinator.turnPool()` monta, a cada fala, `pool` (quem está abaixo do limite, ou todos se ninguém estiver) e `reserve` (quem passou do limite). `planNext(round, pool, {userCalls: reserve})`.
- Se o líder estiver na reserva, outro participante assume abertura, síntese ou refino.
- `noteReserve` registra uma vez por rodada o evento "GPT passou a vez" com o percentual e inclui o motivo em `round.absent`, que vai para o contexto dos colegas.
- Chamadas por @ de colegas para quem está na reserva são recusadas, com evento. As do usuário são atendidas.
- `usageNote` anota "Uso: N%; limite preventivo X%" (ou "não informado") no evento de início de cada fala.
- `roundDone` usa o mesmo `pool`.

Limite que continua: uma fala que começa abaixo do limite ainda pode esgotá-lo no meio. Ninguém prevê o consumo de uma fala. Quando isso acontece, a resposta parcial fica salva e a vez passa ao próximo, como já acontecia. Testes: `tests/passar-a-vez.test.mjs` (5).

Revisão do Gemini incorporada: `git reset --hard` e `git clean -f` entraram em `SEMPRE_PERGUNTAR`. Do GPT, antes do limite: `requiresUser` faz pedidos de permissão de sandbox do Codex sempre irem ao usuário, mesmo com a Autonomia ligada. Também do GPT: o cursor de mensagens do usuário via `store.userMessagesAfter`, e a promoção da chamada do usuário sem gastar outra vaga. O build da 1.2.0 que o Gemini disparou em segundo plano parou no meio, deixando só um `.7z` intermediário. O instalador foi gerado de novo em primeiro plano: `dist/Synapse-Setup-1.2.0.exe`. Suíte: 129/129.

## 1.2.0 — @menções, réplicas ao vivo e Autonomia

Pedido do usuário (22/11): marcar alguém com @ como no WhatsApp (usuário e agentes), respostas mais integradas e reativas, e mais liberdade para os agentes. A 1.1.3 está instalada (confirmado em `AppData/Local/Programs/orbita`).

- `lib/mentions.mjs`: `parseMentions` (@GPT/@Codex, @Claude, @Gemini; ignora código entre crases, e-mails, `@types/x` e caminhos; "@GPT." no fim de frase vale). A mesma regex está em `public/app.js` (`MENCAO`), e um teste garante que as duas são iguais.
- Envio com o destinatário em "Grupo": uma menção faz só ela responder (`target` vira o agente). Várias menções restringem a rodada a elas, na ordem citada (`progress.only`). No Chat, essa rodada é rápida (`round.quick`): cada um responde uma vez, sem síntese. O seletor explícito ("Só X") prevalece sobre a menção.
- Durante a rodada: `round.calls` é a fila de chamadas, com até `MAX_CHAMADAS` = 3 por rodada (usuário e agentes somados). As menções numa fala de agente viram chamadas (`registerCalls` após `recordTurn`). As menções em mensagens suas durante a rodada são lidas das mensagens gravadas por um cursor (`round.userCursor`, em `absorbUserCalls`), nunca pelo servidor escrevendo no estado, que vive em memória no laço. No Chat, quem é chamado fala antes da fila: é a análise de quem ainda não falou e a réplica (estágio novo `replica`) de quem já falou. No Code, quem é chamado vira o próximo revisor, mas o autor da versão não revisa a si mesmo. As chamadas aceitas e recusadas aparecem em Ações ("Claude chamou GPT", "Chamada para X não atendida"). O Chat passou a ter `totalSteps` 4 + 3.
- Prompts: a instrução da rodada explica o uso de @ e o limite. Quem é chamado recebe "Você foi chamado com @ por X / pelo usuário". A rodada rápida não menciona síntese.
- Autonomia (`settings.autoApprove`, desligada por padrão, entra em `GRANTS` e não se amplia ao Continuar): no Projeto e no Computador, `Approvals.request({auto})` aprova as permissões na hora, grava a aprovação e o evento "Aprovado pela Autonomia · …". Perguntas ao usuário e `SEMPRE_PERGUNTAR` continuam esperando: git push, publish, `gh` release/merge/repo, apagar de forma recursiva, formatar disco, desligar o computador e alterar o registro. No Chat não muda nada (as ferramentas já são negadas antes).
- `lib/approvals.mjs`: `SEMPRE_PERGUNTAR` expandido na revisão do Gemini para incluir `git reset --hard` e `git clean -f`, prevenindo descarte ou perda destrutiva de alterações e arquivos locais sob Autonomia.
- Interface: autocompletar de @ no compositor (↑/↓, Enter/Tab, Esc), menções destacadas com a cor de cada participante, aviso abaixo do compositor ("Só Gemini responde (menção)" e "Gemini responde em seguida, fora da fila"), opção Autonomia em Configurações → Acesso e rótulo "Réplica".
- Testes: `tests/mencoes-autonomia.test.mjs` (14). Suíte: 124/124 passam (incluindo testes de promoção de chamada do usuário sem gastar vaga extra e orientações pré-abertura adicionados na revisão do GPT/Codex, e novas proteções do Gemini).
- Não feito, próximos itens: menções dentro de uma resposta individual ("Só X") não chamam ninguém. A "integração total" de recursos hoje desligados nos clientes (Codex: `multi_agent`, `browser_use`, `computer_use`, `memories`…; Claude: `settingSources: []`, `safe-mode`, `strict-mcp-config`; Gemini: ferramentas por perfil) precisa de avaliação item a item. As políticas próprias de cada provedor não são controladas pela Synapse.

## 1.1.3 — Confirmação de fila vazia

O desktop aguarda o aceite explícito do servidor antes de iniciar a instalação. Uma falha ao localizar a instância mantém o pedido agendado. O encerramento usa os prazos das operações em `stopMesa`, evitando uma requisição de encerramento que continue em segundo plano depois de a interface voltar a esperar. O launcher exige que o servidor informe a lista de tarefas antes de pedir o encerramento condicional.

Conferência do Claude no refino: o caminho de sucesso não chama `servidor.kill()`, e isso está correto. Medido com `server.mjs` real numa pasta temporária: `stopMesa({somenteSemTarefas:true})` → aceito em 2,4 s, e o processo do servidor sai sozinho com código 0 cerca de 0,4 s depois. A detecção no `dist` real oferece a 1.1.3 para as instaladas 1.1.0 e 1.1.2 e nada para a 1.1.3.

Na revisão, duas requisições HTTP concorrentes a instâncias temporárias retornaram 202 para a mensagem e 409 para o encerramento em uma ordem, e 503 para a mensagem e 202 para o encerramento na outra. Para o aceite na instalação em uso, a 1.1.0 precisa receber a 1.1.3 ao fim da rodada. Falta confirmar a abertura do Gemini nessa instalação e acompanhar uma atualização real pelo botão.

## Histórico curto

- Mesa v0.1–v0.3 (GPT e Claude): sala local com Codex, Claude e Gemini, Chat/Code, aprovações, memória e versões.
- Órbita v0.4 (Claude, 16/11): nome Órbita e aplicativo Electron com Node embutido e instalador NSIS.
- Synapse 1.0 (GPT, 21/11): nome Synapse, Gemini via AI Studio (chave privada) com Antigravity como reserva, debate ao vivo em paralelo, orientação no meio da rodada.
- Synapse 1.1 (Claude, 21/11): pedido do usuário para auditar a 1.0 e implementar os itens abaixo. Originais da 1.0 em `../../work/synapse-backup-1.0`.
- Synapse 1.1.1 (Claude e GPT, 21/11, sala "Projetos de Engenharia…", modo Code): resgate do Gemini. Ver a seção abaixo.
- Synapse 1.1.2 (Claude, 21/11, mesma sala): "Reiniciar para atualizar", pedido do usuário no meio da rodada. Inclui a 1.1.1.

## 1.1.2 — Reiniciar para atualizar

- `desktop/atualizacao.mjs` (puro, sem Electron): a pasta vem de `SYNAPSE_UPDATE_DIR` ou de `<dados>/atualizacao.json` (`{"pasta": "..."}`). Sem pasta, não há atualização. Oferece só o **maior** `Synapse-Setup-X.Y.Z.exe` acima da versão atual, com mais de 1 MB, cabeçalho `MZ`, sem alteração há 15 s e com tamanho e data iguais em duas leituras. Se o maior ainda está sendo gravado, nada é oferecido, nem uma versão menor.
- `desktop/main.mjs`: verifica ao abrir e a cada 60 s. Ao confirmar, sem tarefas ativas: encerra o servidor como em `sair()` e inicia o instalador com `--updated /S --force-run` (NSIS do electron-builder 26.18: espera o app fechar, encerra o que restar da pasta de instalação e reabre). Com tarefa ativa ou servidor sem resposta, a atualização fica agendada e é aplicada quando a contagem volta a 0. Clicar de novo cancela. Se o instalador não iniciar, reabre o servidor e mostra o erro. Bandeja: "Reiniciar para atualizar (X)" e "Pasta de atualizações…".
- Interface: botão `#app-update` no cabeçalho, só no desktop e só com versão pronta, com confirmação. Ponte em `preload.cjs`: 3 `invoke` fixos e 1 aviso. `ipcRenderer` nunca é exposto, e cada `ipcMain.handle` confere `remetenteValido` (janela principal, frame principal, mesma origem do servidor). O teste de desktop foi reescrito para esse invariante (antes proibia `ipcRenderer` por completo). Uma mutação que expõe o `ipcRenderer` faz o teste falhar.
- Revisão do GPT incorporada (rebuild da mesma 1.1.2, que ninguém tinha instalado): `AgendaDeAtualizacao` (em `desktop/atualizacao.mjs`, testável sem Electron) vincula a confirmação ao `idDoPacote` (versão:tamanho:mtime) que a interface mostrou. Outro pacote, inclusive um rebuild da mesma versão, exige nova confirmação. Cancelar invalida o pedido até o servidor aceitar o encerramento, e se cancelar depois, a Synapse reabre sem instalar. O servidor decide a fila: `POST /api/admin/shutdown {onlyIfIdle:true}` → `Coordinator.drain()` responde 409 `busy` com tarefas e, ao aceitar, bloqueia de forma síncrona `enqueue`/`resume` (503). `stopMesa(dados,{somenteSemTarefas,aoAceitar})` lança `code:'BUSY'`. Endereço ausente, `activeJobs` ausente, tempo esgotado ou servidor vivo sem resposta = "ocupado" (esperar). Laço de 5 s com uma tentativa por vez. Testes: `tests/atualizacao-agenda.test.mjs` (11).
- Desta instalação: `%APPDATA%\Orbita\dados\atualizacao.json` aponta para `outputs/synapse/dist`.
- **Transição:** a 1.1.0 instalada não tem atualizador, então a 1.1.2 é instalada à mão uma única vez. Depois disso, cada build com **versão maior** em `dist` aparece como botão. Mudança sem subir a versão não é oferecida.
- Não executado: o processo principal do Electron com o código novo (a trava de instância única impede uma segunda cópia com a Synapse em uso) e a troca real pelo instalador (interromperia a rodada). Verificado: sintaxe, 99 testes, pacote 1.1.2 com hashes iguais aos do código-fonte e detecção no `dist` real.

## 1.1.1 — Gemini preso fora das rodadas (incluído no instalador 1.1.2)

Diagnóstico com dados reais (API local, sala `1563f5fc…`): tarefa `6b433af1` (18:37 UTC) teve 429 do AI Studio com `api:gemini-4-hydrogen` e renovação às 18:39:49. As tarefas seguintes saíram sem o Gemini, inclusive a `3a86ec19`, cuja `chatPreference` era `gemini,codex,claude` (a escolha do usuário **chegou**), com o modelo já trocado para `gemini-3.8-flash` (Antigravity). Causa: `Coordinator.capacity` é um `Map` em memória do servidor, compartilhado entre tarefas. `capacityRestored` exige telemetria de uso, que o Gemini não fornece, e a regra "direta" só valia para modelo `api:*`. Resultado: exclusão até reiniciar o app, mesmo depois da renovação e da troca de modelo.

Correção (`lib/coordinator.mjs`, `lib/rounds.mjs`, 1 linha em `public/styles.css`):
- `enqueue`: mensagem nova limpa entradas de `capacity` sem renovação futura (mesma regra do Continuar manual).
- O coordenador guarda os limites por participante e modelo. Uma sala com Antigravity pode chamar o Gemini enquanto outra que usa o modelo limitado do AI Studio aguarda a renovação. Limites antigos `direct` só valem com rota AI Studio.
- `announceOrder`: evento "Ordem da rodada: A → B" no início de cada rodada, com o motivo de cada ausência (`absenceReason`), gravado em `round.absent` e repetido no contexto dos participantes (`stageDirections`).
- Testes: `tests/gemini-rescue.test.mjs` (5). Contra o código 1.1.0 os testes de comportamento falham com `[codex, claude, codex]`, exatamente o que aconteceu na sala.
- Chamada real (`work/gemini-smoke/smoke.mjs`, `Providers.run` com as configurações da sala): Code (`computer-web`) e Chat (`chat-web`) responderam `GEMINI_OK · gemini-3.8-flash` em 5 a 8 s. O login do Antigravity vale entre perfis `--app-data-dir`.
- Para aplicar: `npm run dist` → `dist/Synapse-Setup-1.1.1.exe`. Fechar a Synapse (inclusive a bandeja) e instalar. Até lá, reiniciar a 1.1.0 limpa a exclusão, mas ela volta no próximo 429.

## Pedidos do usuário atendidos na 1.1

1. Auditoria e polimento geral do backend e da interface.
2. Nomes oficiais de modelos agrupados em OpenAI (GPT), Anthropic (Claude) e Google (Gemini), sem identificadores locais (o item "Default" do Claude Code e as variantes `-low/-xhigh` do Antigravity viravam rótulos estranhos). Seletor de esforço/raciocínio individual por participante.
3. Debate como grupo de conversa, sem ninguém falar por cima: líder por modo (Claude no Code, GPT no Chat), colegas respondem em sequência analisando e construindo sobre o que já foi dito, execução colaborativa.
4. Abas Chat/Code substituídas por uma sala única com menu de modo no cabeçalho, salvo na sala (`settings.mode`).
5. Arquivar, restaurar e excluir salas.

## Decisões de implementação

- `lib/rounds.mjs`: planejador puro da rodada (`startRound`, `planNext`, `recordTurn`, `upcoming`, `stageDirections`). O coordenador executa; o planejador só decide quem fala e em que papel. Estado em `job.progress.round` (lead, order, turns; Chat: spoken/synthesized; Code: lastChange/pass). Etapas: abertura, analise, sintese (Chat); implementacao, revisao, refino, verificacao (Code). Uma fala bloqueada (`blocked`) não avança a rodada: é refeita após a resposta do usuário.
- Code: uma passada de revisão = todos os colegas disponíveis, em ordem. Conclui quando a passada aprova sem crítica pendente; crítica (`continue`) leva ao refino do líder; revisor que altera arquivos zera as aprovações (as dele não contam para a própria mudança); se o último revisor alterou, outro participante faz a verificação. Alteração detectada por `fingerprint` das capturas de `lib/versions.mjs` (antes/depois de cada fala). Orçamento: `maxSteps`; esgotado → `paused_budget`.
- Fila: `Coordinator.available()` respeita a preferência do modo; quem passou de `handoffPercent` vai para o fim; quem está em 100% ou falhou sai. `debate.mjs` (debate paralelo da 1.0) foi removido.
- Prompts: o GPT é apresentado como "GPT, da OpenAI (pelo cliente Codex)"; histórico com autores Usuário/GPT/Claude/Gemini; textos "Modo Chat/Modo Code" no lugar de "Aba".
- `lib/models.mjs`: normalização de catálogos (`normalizeCatalog`), nomes oficiais, variantes de esforço do Gemini agrupadas num modelo (`variants`), `resolveEffort` (nível mais próximo suportado) e `geminiVariant`. `Providers.withEffort` aplica o esforço por participante: Codex `turn/start.effort`, Claude `options.effort`, AI Studio `generationConfig.thinkingConfig.thinkingLevel` (repete sem ele se o modelo recusar com HTTP 400), Antigravity pela variante do modelo ou pela opção de sessão de raciocínio. Configurações novas: `codexEffort`, `claudeEffort`, `geminiEffort` ('' = padrão do modelo) e `mode`; `effort` antigo só existe para salas antigas.
- Salas: coluna `rooms.archivedAt`; `Store.setArchived` e `Store.deleteRoom`; rotas `POST /api/rooms/:id/archive {archived}` e `DELETE /api/rooms/:id` (409 com rodada ativa). Exclusão move `workspaces/<id>` (só a pasta própria da sala) e `versions/<id>` para `dados/lixeira/<id>-<data>/`; pastas escolhidas pelo usuário não são tocadas. Sala arquivada recusa mensagens.
- Versão única: `/api/health` lê a versão do `package.json`; o desktop encerra sozinho um servidor de versão anterior ainda aberto e inicia o atual.
- Interface: paleta grafite única (`--fundo #1C1F1E`), cores distintas por participante (GPT verde, Claude argila, Gemini azul), sem fonte serifada; mensagens do usuário à direita; citação "Respondendo a…" clicável; indicador de quem fala e de quem vem depois; menu de modo; menu da sala e seção Arquivadas; diálogo de confirmação.

## Verificação

- 87 testes (Node 24): 86 passam e 1 é exclusivo do Windows. Novos: rodada em grupo no Chat com orientação no meio e no máximo um participante ativo; Code com Claude liderando e revisão completa; nomes oficiais; esforço por participante; arquivar/restaurar/excluir; bloqueio com rodada ativa. Testes de coordenação antigos atualizados para a rodada sequencial.
- Prévia com participantes simulados (texto fixo): rodadas de Chat e Code completas, menus, configurações, celular.
- Não verificado ainda: clientes reais no Windows depois da 1.1 (catálogos reais de cada conta, níveis de esforço aceitos por cada modelo, AI Studio com `thinkingLevel`).

## Pendências e limites

- Validar no Windows com os três clientes reais.
- AI Studio: a cobrança depende do projeto Google da chave (o usuário foi avisado).
- Não leia `.data`/`dados` (mesa.sqlite), históricos pessoais, tokens, `oauth_creds`, `auth.json`, `.env` ou cofres. Não apague nem sobrescreva alterações de outros participantes sem registrar.
