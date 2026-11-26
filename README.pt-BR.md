# Synapse

> English version: [README.md](README.md) · Arquitetura: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Aplicativo local para Windows que reúne você, GPT (OpenAI, pelo Codex), Claude (Anthropic, pelo Claude Code) e Gemini (Google) numa sala de projeto. O instalador fica em `dist/Synapse-Setup-<versão>.exe`.

## @menções e réplicas

Digite **@** no compositor para chamar alguém, como num grupo de mensagens:

- **@Gemini** numa mensagem nova: só o Gemini responde. Com várias menções (**@GPT e @Gemini**), só elas respondem, nessa ordem.
- **@Claude** durante uma rodada: o Claude fala em seguida, fora da fila.
- **Numa resposta individual ("Só X")**, uma @menção na resposta chama o colega: no Chat ele responde em seguida; no Code ele revisa o que X fez.
- **Os participantes também chamam uns aos outros:** quem é chamado responde logo depois. Quem já falou responde com uma **Réplica** curta. O limite é de 3 chamadas por rodada, e cada chamada aparece em **Ações**.

## Integração total

Em **Configurações → Acesso**, a opção **Integração total** faz cada participante trabalhar com os recursos da interface oficial:

- **GPT (Codex):** navegador, uso do computador, apps e conectores, plugins, hooks, multiagente, memórias, geração de imagem e AGENTS.md. Um conector que peça dados ou autorização abre um cartão para você responder.
- **Claude (Claude Code):** todas as ferramentas, subagentes, skills, plugins, hooks, comandos, servidores MCP e CLAUDE.md das suas configurações.
- **Gemini (Antigravity):** agente completo, com subagentes, research, geração de imagem, fluxos e /browser. Exige internet ligada.

As ações continuam passando pela sua aprovação ou pela **Autonomia**. As permissões que você já definiu nas configurações de cada cliente oficial passam a valer. A opção vem desligada e só vale nos acessos Projeto e Computador.

### Servidores MCP por sala e teto de ferramentas

Com a integração total, o Claude Code e o Codex carregam os servidores MCP das suas próprias configurações em toda fala. Em **Configurações → Acesso** aparece a lista desses servidores (só os nomes): desmarque os que a sala não usa. Um servidor que é a mesma ferramenta de uma opção desligada na sala (por exemplo, o REA) também fica fora. Nada muda nas configurações dos clientes.

Em **Configurações → Execução**, **Ferramentas por fala** é o teto de chamadas de ferramenta do Claude e do GPT no modo Code (padrão 80; 0 desliga). Ao atingir, a fala não se perde: o participante para de usar ferramentas e responde com o que já fez e verificou.

## Autonomia

Em **Configurações → Acesso**, a opção **Autonomia** faz a Synapse aprovar sozinha as ações dos agentes na sala (comandos, arquivos e ferramentas). Cada aprovação fica registrada em **Ações**. Continuam pedindo sua confirmação: apagar pastas de forma recursiva, `git push`, publicar pacotes, formatar disco, desligar o computador e alterar o registro. A opção vem desligada e só vale nos acessos Projeto e Computador.

## Reiniciar para atualizar

A Synapse confere a cada minuto a pasta de atualizações (bandeja → **Pasta de atualizações…**, por exemplo o `dist` deste projeto). Quando aparece um instalador de versão maior, o cabeçalho mostra **Reiniciar para atualizar**. Ao confirmar, a Synapse fecha, o instalador oficial atualiza sem telas e a abre de novo. Conversas, tarefas e arquivos ficam salvos. Se uma rodada estiver em andamento, a atualização espera ela terminar. Para publicar uma mudança, suba a `version` no `package.json` e rode `npm run dist`.

## Uma sala, dois modos

Cada sala tem um **modo**, escolhido no menu **Modo** do cabeçalho e salvo na própria sala:

- **Chat**: ideias, planejamento e decisões, sem alterar arquivos. O GPT abre a rodada.
- **Code**: código, arquivos e testes na pasta da sala. O Claude lidera a implementação.

A ordem vem de **Configurações → Coordenação** ("o primeiro lidera"); os padrões são GPT → Claude → Gemini no Chat e Claude → GPT → Gemini no Code. Mudar uma sala de Chat para Code pede confirmação quando a pasta ainda não está liberada.

## Rodada em grupo

Com **Para: Grupo · todos**, a equipe conversa como num grupo: **um participante fala por vez** e cada um lê tudo o que já foi dito.

- **Chat**: o líder abre com uma proposta, cada colega analisa em sequência (concorda com evidência, aponta falhas e casos de borda, propõe melhorias) e o líder fecha com a síntese: versão final, críticas aceitas e recusadas, pendências e próximo passo.
- **Code**: o líder implementa e testa; os colegas revisam e testam em sequência e podem aplicar correções pontuais (a Synapse compara as versões dos arquivos para saber quem alterou o quê); o líder incorpora as críticas no refino; o ciclo se repete até uma passada de revisão aprovar a versão atual. Se o último revisor alterou arquivos, o líder confere essas mudanças antes de fechar. O limite de falas por rodada vem das configurações; ao atingi-lo, a tarefa pausa e **Continuar** autoriza mais uma rodada.

Uma mensagem sua no meio da rodada entra na conversa e é lida por quem fala a seguir. Cada fala mostra o papel (Abertura, Análise, Síntese, Implementação, Revisão, Refino, Verificação) e a mensagem a que responde. Para falar com um só participante, escolha **Só GPT**, **Só Claude** ou **Só Gemini**.

Quem chega ao limite preventivo de uso (**Passar a vez a partir de X%**) passa a vez: enquanto houver um colega abaixo do limite, ele assume as falas seguintes, inclusive abertura, síntese ou correções do líder. Isso aparece em **Ações** como "GPT passou a vez", com o percentual. Uma chamada sua com @ ainda alcança quem passou a vez. Se todos passarem do limite, a rodada segue com eles. Quem esgota o limite sai da rodada e a vez passa ao próximo. Cada fala registra o uso informado no início. Uma fala que começa abaixo do limite ainda pode esgotá-lo no meio: nesse caso a resposta parcial fica salva e o próximo continua. Quem não informa uso (hoje, o Gemini) não passa a vez por esse critério; para retomar alguém depois de um limite atingido, uso desconhecido nunca é tratado como zero. Cada rodada registra em **Ações** a ordem efetiva e o motivo de quem ficou de fora. Um limite vale só para o modelo que o atingiu: trocar o modelo (por exemplo, do AI Studio para o Antigravity) devolve o participante à rodada, e uma mensagem nova depois do horário de renovação dá a ele uma nova tentativa.

## Modelos e raciocínio

Os modelos aparecem com o nome oficial, agrupados por **OpenAI · GPT**, **Anthropic · Claude** e **Google · Gemini**, mesmo quando o cliente local informa apelidos ou identificadores (por exemplo, o item padrão do Claude Code ou as variantes `-low`/`-xhigh` do Antigravity).

Cada participante tem o próprio seletor de raciocínio (GPT e Gemini) ou esforço (Claude), com os níveis que o modelo escolhido oferece. "Padrão do modelo" deixa a escolha com o cliente. Se um nível salvo não existir no modelo, a participação usa o mais próximo e registra isso em **Ações**. No Gemini via AI Studio o nível vira o `thinkingLevel` da API; se o modelo recusar, a participação segue sem ele.

## Arquivar e excluir salas

O botão **⋯** de cada sala (ou o clique com o botão direito) abre: renomear e editar contexto, **Arquivar** e **Excluir**. Salas arquivadas ficam em **Arquivadas**, no fim da lista, e não aceitam mensagens até serem restauradas. Excluir remove conversa, memória, tarefas, sessões e versões da sala; os arquivos da pasta própria da sala e as versões vão para `dados\lixeira`, e uma pasta escolhida por você nunca é tocada. Salas com rodada em andamento não podem ser arquivadas nem excluídas.

## Contas

Cada participante tem o botão **Conectar** no painel (aceso na cor dele quando falta login) ou **Reconectar** (discreto, quando a conta está ativa). O login sempre roda pelo cliente oficial, e a Synapse não vê senha nem token:

- **GPT:** o Codex abre a página do ChatGPT no navegador e a Synapse percebe sozinha quando termina. Se a porta de retorno estiver ocupada, aparece um **código de dispositivo** para digitar na página.
- **Claude:** o Claude Code abre o login no navegador. Se a página mostrar um código, cole no campo do diálogo. O login só vale com a assinatura Claude.
- **Gemini:** o Antigravity abre a página do Google. A chave do AI Studio é separada e não muda.

Você pode fechar o diálogo: o login continua e o botão mostra quando terminar. Se uma tarefa ficou pausada por falta de login, use **Continuar** depois de conectar.

No cartão do Gemini, **AI Studio** mostra as requisições feitas pela Synapse desde a meia-noite do Pacífico (quando a cota diária renova) e as pausas gravadas; **Antigravity** mostra se a conta Google está conectada ou em pausa.

Codex usa a conta ChatGPT do cliente local. Claude usa o Claude Code e precisa de um plano compatível. O Gemini aceita `SYNAPSE_GEMINI_API_KEY` no ambiente do servidor ou no arquivo privado `%LOCALAPPDATA%\Synapse\private\.env`; a chave vai só no cabeçalho de autenticação da API do Google e o instalador não contém configuração pessoal. **A cobrança efetiva depende do projeto Google associado à chave**: com faturamento ativo, o uso pode ser cobrado. No modo automático, o Gemini começa pelo AI Studio (Hydrogen) no Chat e pelo Antigravity no Projeto e no Computador. Se o Antigravity estiver fora no modo Code, o Flash do AI Studio vem antes do Hydrogen, para preservar a cota diária baixa do Hydrogen. Cada troca fica registrada em **Ações**.

## Desenvolvimento

Use Node.js 24 ou superior e os clientes locais que deseja conectar.

```powershell
npm ci --include=dev
npm test
npm run app
npm run dist
```

O servidor escuta apenas em loopback. O aplicativo reconhece o banco e as pastas de trabalho da instalação anterior no perfil do Windows. Uma instalação nova usa `%APPDATA%\Synapse\dados`; para testes isolados, defina `SYNAPSE_DATA_DIR`. Principais módulos: `lib/rounds.mjs` (rodada em grupo), `lib/models.mjs` (nomes oficiais e esforço), `lib/coordinator.mjs`, `lib/providers.mjs`, `lib/ai-studio.mjs`, `public/` e `desktop/`. Contexto para quem continuar o trabalho: [docs/DEVLOG.md](docs/DEVLOG.md).
