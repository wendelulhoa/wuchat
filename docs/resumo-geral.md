# Resumo geral do Wuchat

**Estado em 27/09/2026 · versão instalada: 0.2.14**

## Objetivo

O Wuchat é uma extensão de chat para VS Code com interface, sessões, agentes e ferramentas próprios. Usa modelos disponibilizados por extensões provedoras por meio da API `vscode.lm`. A experiência principal fica na área do Wuchat; há também uma ponte opcional `@wuchat` para o chat nativo do VS Code.

## O que foi implementado

### Provedores, login e modelos

- Fluxo de conexão e gerenciamento para Claude Plan, ChatGPT Codex e Z.AI GLM, delegando autenticação e armazenamento das credenciais à extensão provedora. Há um provedor Echo local.
- Seletor de modelo no compositor, com modelos agrupados por provedor, opção automática e seletor de esforço de raciocínio conforme o provedor ativo.
- Acesso a conexão, teste de conexão e preferências avançadas pelo menu de configurações.
- Mensagem mais clara para falhas de rede do Z.AI, como `fetch failed`, com acesso ao teste de conexão. Essa mensagem não corrige por si só problemas de DNS, proxy, VPN ou serviço remoto.

### Chat, sessões e interface

- Interface independente com histórico de sessões, busca, anexos de texto e imagem, resposta em fluxo, indicação de ferramentas e botão para interromper a geração.
- Remoção das antigas seções permanentes de Agents, Sessions, Tools e Settings na parte inferior; sessões e preferências ficam em fluxos próprios.
- Layout mais limpo, com conteúdo usando a largura disponível, estado inicial centralizado e controles de agente, modelo e esforço com proporções e aparência revisadas.
- Borda animada no compositor enquanto o Agent executa, respeitando a preferência do sistema por movimento reduzido.
- Ações **Retry** e **Test connection** em erros de solicitação.
- Aprovação individual de ferramentas por padrão. O seletor **Approve for me · session** libera as ferramentas que exigem confirmação somente na sessão atual; uma nova conversa volta a pedir aprovação.

### Agentes e ferramentas

- Agentes internos Ask, Explain e Agent. O Agent pode ler e editar arquivos, abrir arquivos, listar o workspace e executar comandos conforme as permissões da ferramenta.
- Descoberta de agentes personalizados em `.github/agents/**/*.md`, com atualização quando esses arquivos mudam.
- Ferramenta `wuchat.runPlaywright` para executar testes Playwright já instalados no projeto e devolver a saída ao Agent. Ela exige aprovação, salvo quando a sessão tiver aprovação automática.

### Navegador Wuchat

- Aba de navegador própria do Wuchat, controlada por Playwright Core com Chrome/Chromium instalado na máquina.
- Navegação, clique, digitação, rolagem, seleção de elemento e captura de screenshot pela interface do navegador. Elementos e capturas escolhidos são anexados ao contexto da próxima mensagem do chat lateral do Wuchat.
- Ferramenta `wuchat.browser` para o Agent navegar, clicar, preencher campos, pressionar teclas, inspecionar HTML, obter um retrato de acessibilidade e capturar a página, mediante a política de aprovação.
- A ponte `@wuchat` também aceita referências enviadas ao chat nativo do VS Code. O navegador próprio foi criado porque o comando **Add Element to Chat** do Browser integrado direciona a seleção ao fluxo de chat nativo, e não diretamente ao compositor lateral do Wuchat.

## Arquitetura resumida

| Componente | Arquivos principais | Função |
| --- | --- | --- |
| Inicialização e comandos | `src/extension.ts`, `src/extension/commands.ts` | Registra a extensão, os provedores, a view e os comandos. |
| Interface do chat | `src/chat/views/WuchatChatView.ts`, `media/wuchat.js`, `media/wuchat.css` | Mostra conversa, sessões, seletores, anexos e ações. |
| Conversa e histórico | `src/chat/controllers/ChatController.ts`, `src/chat/history/SessionStore.ts` | Encaminha pedidos e persiste sessões. |
| Agentes e ferramentas | `src/agents/`, `src/tools/` | Define agentes, permissões, ferramentas e confirmações. |
| Navegador | `src/browser/WuchatBrowser.ts`, `src/browser/browserTool.ts` | Controla Chrome/Chromium com Playwright e fornece contexto ao chat. |
| Modelos e ponte VS Code | `src/llm/`, `src/vscode/chatParticipantBridge.ts` | Adapta modelos `vscode.lm` e registra `@wuchat`. |

## Build e verificação

- `npm run package` aumenta a versão *patch*, compila a extensão e gera um VSIX com nome único em `dist/`.
- A build mais recente é `dist/wuchat-0.2.14.vsix`, instalada no VS Code. É preciso recarregar a janela para ativá-la.
- A checagem TypeScript (`npm run typecheck`) e a checagem de sintaxe de `media/wuchat.js` passaram. O pacote VSIX foi gerado e instalado. Não houve validação de ponta a ponta da navegação real no Browser nem dos provedores de LLM nesta etapa.

## Limites e pontos de atenção

- O navegador próprio precisa de Chrome/Chromium instalado; `CHROME_PATH` pode indicar outro executável. Ele exibe capturas da página dentro do VS Code e encaminha as interações ao Playwright.
- `wuchat.runPlaywright` usa a instalação de Playwright do workspace; para executar testes do projeto, ele precisa ter `@playwright/test` instalado.
- Um screenshot feito pelo Agent durante uma resposta fica disponível como anexo para a próxima mensagem. O Agent pode inspecionar a página na execução atual pela ferramenta de retrato de acessibilidade ou pela inspeção de HTML.
- A opção permanente e global de aprovar todas as ferramentas não foi adicionada ao chat: a revisão automática bloqueou a alteração por desativar confirmações também em sessões futuras. A opção implementada no chat vale apenas para a sessão atual. A configuração avançada preexistente `wuchat.autoApproveTools` continua disponível nas configurações do VS Code.
- Erros de conexão com provedores externos ainda dependem da rede, das credenciais e do serviço remoto; o Wuchat oferece diagnóstico e teste de conexão, mas não garante a disponibilidade desses serviços.
