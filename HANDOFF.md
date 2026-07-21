# Handoff — MALSync: Trakt sync + Prime Video/HBO Max + Local Import/Export

Contexto para retomar o trabalho em uma nova conversa. Repositório: `C:\Users\anand\OneDrive\Documentos\MALSync`, branch de trabalho `teste-local`, remotes `origin` (MALSync/MALSync oficial) e `fork` (anandami/MALSync).

## Quem é a usuária

PM brasileira, não-dev, testa a extensão manualmente no Chrome via `malsync.moe/pwa/#/settings/listSyncSection`. Conta Trakt de teste: `anandami` (perfil público durante os testes — API pública em `api.trakt.tv/users/anandami/...` foi usada o tempo todo para medir resultados sem depender do console, que fica dentro de um iframe de extensão inacessível ao Claude in Chrome/Claude in Chrome — ver seção "Limitações de acesso" abaixo). Usuário AniList: `anandamic`.

## O que foi construído

### 1. Integração Trakt (o grosso do trabalho)
Novo provider em `src/_provider/Trakt/` (`helper.ts`, `list.ts`, `single.ts`) seguindo o padrão dos providers existentes (Simkl, Shikimori etc.), registrado em `singleFactory.ts`, `listFactory.ts`, `helper.ts` (SyncTypes), `singleAbstract.ts` (ids.trakt), e UI em `settings-list-sync.vue`.

**Por que Trakt é diferente dos outros providers:** Trakt não conhece MAL ID. Modela anime como TV ocidental — uma franquia = uma série com temporadas numeradas (via TVDB/TMDB), enquanto o MAL dá um ID separado para cada temporada. A ponte é o **Simkl**, que expõe `GET /anime/{id}?extended=full` com `mapped_tvdb_seasons`. Filmes de anime vivem num **namespace totalmente separado** no Trakt (`/movies` vs `/shows`, IDs podem colidir entre os dois).

**Fluxo de autenticação:** device flow (código curto digitado em `auth.trakt.tv/activate`), não authorization-code — confirmado ao vivo que a variante "out-of-band" do Trakt redireciona para uma URL `urn:ietf:...` que nenhum navegador abre. Cronômetro local de 2 minutos (`TRAKT_CODE_WINDOW_SECONDS` em `settings-list-sync.vue`), mesmo o código do Trakt durando 10 min — corta pela metade para forçar o usuário a agir rápido.

### 2. Prime Video + HBO Max
ChibiScript implementations em `src/pages-chibi/implementations/{PrimeVideo,HBOMax}/`, registradas em `src/pages-chibi/pages.ts`. Prime Video trata URLs com prefixo de locale (`/pt-BR/`).

### 3. Import/Export local
`src/_provider/Local/import.ts` + `settings-local-sync-export.vue`: exportação agora cobre listas remotas ativas (não só locais), e import aceita JSON (formato próprio) ou CSV com coluna Title.

### 4. Ferramenta de auditoria (fora da extensão)
`scripts/trakt-validation/validate-anilist-trakt.js` — script Node standalone (não depende da extensão) que cruza a lista inteira do AniList contra o Trakt via APIs públicas (AniList GraphQL, Simkl, Trakt), reproduzindo a mesma cadeia de resolução MAL → Simkl → TMDB → Trakt que a extensão usa. Read-only, seguro de rodar quantas vezes quiser.

Uso: `node scripts/trakt-validation/validate-anilist-trakt.js <anilistUsername> <traktUsername> [--out report.json]`

Detalhes importantes:
- Trakt/Simkl bloqueiam (403) o User-Agent padrão do `fetch` do Node — o script já manda um UA de navegador em todo header.
- Uma avaliação (rating) pode existir no Trakt sem watch history nem watchlist — o agregador do script trata isso (senão perdia avaliações "soltas").
- `titlesLookRelated()` faz uma checagem de sanidade de título (o Trakt resolvido bate com o título do AniList?) pra pegar casos de resolução errada tipo o do Toradora (ver bug #6). Compara também as versões sem espaço, pra não dar falso positivo em títulos tipo "MARRIAGETOXIN" vs "Marriage Toxin".
- Classifica cada item em `OK` / `MISMATCH` / `WRONG_SHOW` / `UNRESOLVED` / `NOT_STARTED_EITHER`.

Também existe `scripts/trakt-validation/audit-report.html` — versão renderizada (artifact) do último `report.json`, com filtro por veredito e busca por título. Regenerar rodando o script de novo e reconstruindo o HTML (ver histórico da conversa se precisar do gerador).

## Bugs grandes descobertos e corrigidos (não óbvios pelo código)

1. **Bug no servidor do Trakt (jul/2026):** `api.trakt.tv` responde **500 vazio** a qualquer POST que carregue header `Origin` de outro site — regressão da migração de auth deles que rolou naquela semana (a URL de ativação mudou de `trakt.tv/activate` para `auth.trakt.tv/activate` no meio dos testes). Verificado com curl: sem Origin → 401/201 normal; com Origin qualquer → 500. **Workaround:** regra `declarativeNetRequest` (`src/declarative_net.json`, id 2) que remove o header antes da requisição sair. **Remover essa regra quando o Trakt corrigir o lado deles** (não há como saber quando).

2. **Cache negativo envenenado por rate limit:** a primeira tentativa de cache "isso não é anime" cacheava **qualquer resposta não-200**, inclusive um 429 momentâneo. Corrigido: só respostas definitivas (200 ou 404) são cacheadas. Cache `tmdbToMal` bumped para `v2`.

3. **Chamadas sem retentativa no último hop da cadeia:** 4 chamadas GET diretas ao `api.trakt.tv` não passavam pela função `call()` que já tinha retry-with-backoff. Corrigido: helper central `traktPublicGet()` com retry usado nos 4 pontos.

4. **`ServerOfflineError` silenciosa no bulk fetch:** falha ao buscar a lista completa do Trakt não pode substituir o cache existente por uma lista vazia. Corrigido: joga erro em vez de aceitar array vazio.

5. **Limite de escrita do Trakt:** ~1 escrita/segundo. Implementado `writeGate` (fila serializada com 1.1s de espaçamento) em `call()`. Consultas ao Simkl também espaçadas (`throttledSimkl`, 300ms) e com retry próprio (`simklFetch`, até 4 tentativas).

6. **Cache de mapeamento MAL↔Trakt envenenado (achado com dado real de produção):** o cache de `malToTrakt`/`tmdbToTrakt`/`traktSlugToMal` nunca tinha sido versionado (diferente do `tmdbToMal`, que já ganhou o bump `v2` no bug #2) — uma entrada ficou presa apontando **Toradora! (mal 4224) para o Trakt de "Fruits Basket (2019)"**, um anime completamente diferente. Confirmado ao vivo consultando Simkl/Trakt direto (a resolução fresca dá o resultado certo). Sorte: o Fruits Basket real dela nunca chegou a ser sobrescrito, mas o risco era real. **Corrigido:** os três caches bumped para `v2` (`src/_provider/Trakt/helper.ts`), forçando resolução limpa.

7. **Escritas conflitantes entre temporadas de uma mesma franquia (o bug mais sério, com corrupção de dado real confirmada):** o Trakt modela uma franquia inteira como um show só, dividido em temporadas; o MAL dá uma entrada separada pra cada temporada. Quando a usuária tinha 2+ entradas do MAL pra mesma franquia (ex: Fate/Zero temporada 1 e 2), cada uma tentava escrever *seu próprio* progresso na *mesma* temporada do Trakt — resultado: uma escrevia, a outra desfazia segundos depois. Confirmado num HAR real: Steins;Gate ganhou 24 episódios e nota 10, e ~9s depois teve os 24 episódios removidos e a nota trocada pra 9. Em outro caso, Fate/Zero teve a nota **apagada por completo**. Rodando análise no HAR inteiro: **12 de 32 shows tocados** tinham esse padrão de escrita conflitante.

   **Fix (`src/utils/syncHandler.ts` + `src/_provider/Trakt/single.ts`):** em vez de confiar no mapeamento de temporada do Simkl por entrada do MAL (provado não-confiável — ver bug #6), a extensão agora **agrupa** todas as entradas do MAL que resolvem pro mesmo show do Trakt (`consolidateTraktMultiSeasonFranchises`), soma o episódio assistido de cada uma, e escreve **um único total combinado**, distribuído entre as temporadas reais que o Trakt reporta (`Trakt/single.ts`, modo `consolidateSeasons` — usa `/progress/watched` pra pegar a estrutura real de temporadas, ignorando o mapeamento por entrada). Nota e status **não são tocados** nas entradas consolidadas — só episódio — pra nunca reintroduzir a mesma briga por esses dois campos.

   **Validado com dado real de produção:** todas as ~20 franquias multi-temporada da usuária (JUJUTSU KAISEN, Attack on Titan, Fate/Zero, Frieren, SPY x FAMILY, Kaguya-sama, Fruits Basket, Re:ZERO, Hell's Paradise, My Dress-Up Darling, DAN DA DAN, Clevatess, You and I Are Polar Opposites, Shangri-La Frontier, KONOSUBA, Showa Genroku Rakugo Shinju, Clannad, Nanoha, Fate/Grand Order) bateram exatamente com a soma esperada, zero conflito de escrita na rodada final (HAR: 2 escritas, ambas sucesso, zero remoções).

8. **Comparador "Faltando" comparava contra dado congelado (envenenado por deleção manual do usuário):** o cache local (`cacheList` em `Trakt/helper.ts`) só se invalida checando `last_activities.episodes.watched_at` — mas esse timestamp do Trakt **só muda em adições, nunca em remoções**. Depois que a usuária limpou o Trakt manualmente pelo site deles, a extensão continuou achando "Trakt list up to date" e reusando um snapshot de 120 itens de antes da limpeza — presa nesse estado até uma adição real acontecer. **Fix:** novo parâmetro `forceFresh` em `syncList()`; a tela de sincronização em lote (`Trakt/list.ts`, `getPart()`) sempre força um fetch completo do zero, ignorando o timestamp, já que é uma ação manual e pouco frequente — vale pagar o custo de sempre buscar fresco aqui.

9. **Checagem preguiçosa de "já está sincronizado" não sabia de consolidação:** depois do fix #7, a função que decide se um item consolidado pode sair do "Faltando" (`filterFalseTraktMissing`/`isTraktMissingSatisfied`) criava uma instância comum do `TraktSingle` sem avisar que era uma entrada consolidada — comparava o total combinado (ex: 51 de Nanoha) contra só a temporada 1 (13), nunca batia, item ficava preso pra sempre mesmo já sincronizado de verdade. **Fix:** `isTraktMissingSatisfied` agora chama `setConsolidateSeasons()` quando `miss.traktConsolidated` é true. Só lê, nunca escreve — não era risco de dado, só ruído perpétuo na UI.

## Bugs cosméticos/estruturais conhecidos, ainda sem fix

- **Trilogia de filmes compartilhando um ID do Trakt:** Fate/stay night [Heaven's Feel] I, II e III são 3 entradas separadas do MAL, mas o Trakt só tem **um** registro de filme pra elas (`traktId 181245`). É a mesma classe de problema do bug #7, só que pra filmes — e o fix de consolidação só cobre shows (`consolidateTraktMultiSeasonFranchises` pula `isMovie === true` de propósito). Resultado: as 3 entradas ainda competem pela mesma nota. Na última rodada de teste não houve conflito ativo (Heaven's Feel I com nota 10 "venceu" e ninguém desfez), mas isso foi sorte de ordem de processamento, não uma correção — pode voltar a acontecer numa sincronização futura dependendo da ordem em que os itens são processados. **Fix real, se algum dia for feito:** estender a mesma lógica de agrupamento por `traktId` para incluir filmes, tratando decisão de nota como "não mexe se os valores desejados divergem entre as entradas do grupo" (ao invés de simplesmente pular consolidação pra filmes como hoje).
- **6 títulos permanentemente sem sincronizar — não é bug nosso, é dado ausente na origem:** FGO Camelot (mal 38085, `movie_unresolved` — Simkl não tem `traktmslug`/IMDB/TMDB usável), JUJUTSU KAISEN: Execution -Shibuya Incident- (mal 62392, `no_simkl_mapping` — Simkl não indexa esse filme), Akatsuki no Yona (Zoku-hen) (mal 63120), Oshi no Ko Final Season (mal 63794), Witch Hat Atelier Season 2 (mal 64516), Marriage Toxin 2nd Season (mal 64524) — esses 4 últimos falham com `no_tmdb_id`: são lançamentos recentes/futuros que o Simkl ainda não mapeou pro TMDB. Comportamento correto é falhar limpo (o que já acontece), não é pra "corrigir" — é esperar o Simkl atualizar o catálogo deles.
- Nota do Trakt é por show inteiro, não por temporada — se a usuária der notas diferentes por temporada no AniList, elas brigam pela mesma nota no Trakt (mesma raiz do bug #7/trilogia acima, mas para entradas com nota real conflitante, não é um "fix" possível dado o modelo de dados do Trakt). Limitação de modelo, documentada, não resolvida.

## Ferramenta de teste: seleção parcial antes de sincronizar

`settings-list-sync.vue` ganhou checkboxes em cada card ("Atualizações" e "Faltando") + botões "Selecionar todos" / "Desmarcar todos", ligados a `syncList(list, missing, shouldSync?)` em `syncHandler.ts` (parâmetro novo, opcional, backward-compatible — o caminho do background/auto-sync não passa esse argumento e sincroniza tudo como sempre). Permite rodar uma sincronização de teste com só 2-3 títulos marcados antes de soltar pra lista inteira. Já usada e validada nesta sessão.

**Bug de CSS já corrigido:** o checkbox (componente `FormCheckbox`, 60x32px fixo) era espremido por flexbox quando o título do card quebrava linha (títulos longos tipo "Fate/Grand Order Divine Realm of the Round Table: Camelot..."), fazendo o toggle renderizar partido (dois círculos soltos ao invés do slider inteiro). Corrigido com `flex-shrink: 0` no checkbox + `flex: 1; min-width: 0` no texto do título.

## Limitações de acesso descobertas nesta sessão

- **Claude in Chrome não consegue inspecionar a extensão do MALSync, em nenhuma configuração.** Tentativa de navegar até `malsync.moe/pwa/#/settings/listSyncSection` retorna `Cannot access a chrome-extension:// URL of different extension` — o Chrome bloqueia uma extensão (Claude in Chrome) de acessar as páginas de outra extensão (MALSync), por segurança. Não é resolvível com permissões, perfil, ou janela separada de DevTools — é uma barreira estrutural do navegador. **Único caminho viável para depuração:** a usuária abre o DevTools nativo dela (F12, que tem acesso privilegiado por ser parte do próprio browser) e exporta manualmente — Console → botão direito → "Save as..." dá o rastro mais completo (bem mais útil que HAR nessa extensão, que corre risco de vir vazio se a gravação for pausada/limpa sem querer no meio do fluxo).
- HAR exportado pela usuária deu vazio (`"entries": []`) pelo menos uma vez nesta sessão — provável clique no botão de gravação (redondo, vermelho) ao invés do de limpar (🚫), parando a captura sem querer. Console "Save as..." não tem esse problema (não depende de estar "gravando", guarda tudo desde que a aba foi aberta).

## Como testar (ritual de cada ciclo)

1. Editar código
2. `npx vue-tsc --noEmit && npx eslint <arquivos-tocados> --quiet`
3. `npm run build:webextension` (NÃO faz `rm -rf dist` sozinho — builds parciais acumulam e já corromperam a extensão, causando página branca no PWA. Em caso de comportamento esquisito: `rm -rf dist && npm run build:webextension` antes de mais nada)
4. Usuária: `chrome://extensions` → ↻ no MAL-Sync → F5 no PWA → Sincronizar
5. Medir resultado: preferencialmente **Console → Save as...** (rastro completo, mais confiável) e/ou a API pública do Trakt (`curl "https://api.trakt.tv/users/anandami/stats" -H "trakt-api-version: 2" -H "trakt-api-key: kAB0U5mp1WJzbwmab_7vPzB3m6FlaEwISC7P4jyUIWk"`) comparando com uma linha de base tirada antes do clique em Sincronizar. HAR funciona mas é mais frágil de capturar certo (ver seção de limitações acima).

## Estado das branches para contribuição upstream

Preparadas a partir de `origin/master`. **Nenhuma foi ainda dada `push` pra origin** — isso é ação da usuária, não automatizável aqui por política de segurança do ambiente.

| Branch | Conteúdo | Status |
|---|---|---|
| `fix/local-import-export` | commit único, import/export local + fix de tipo em `listFactory.ts` | ✅ pronta pra PR |
| `feature/trakt-sync` | todos os commits do Trakt (auth, filmes, throttle, os bugs #1-5) | ⚠️ pronta pra PR mas **desatualizada** — precisa receber os cherry-picks dos commits novos feitos na `teste-local` nesta sessão (bugs #6-9 + ferramenta de auditoria + checkboxes de seleção). Já foi dado `push` pra `fork` (anandami/MALSync) numa versão anterior, sem PR aberto — ver próximos passos. |
| `feature/prime-video-hbo-max` | Prime Video + HBO Max | ⏸️ **bloqueada**: falta `tests.json` com URLs reais de episódio (exigência da wiki de contribuição — `src/pages-chibi/implementations/<site>/tests.json`, formato visto em `Crunchyroll/tests.json`). Pedir pra usuária: URL de episódio de anime no Prime Video + HBO Max, com título/episódio esperados |

Regras de contribuição da wiki oficial (resumo): sem clones de sites falsos, contribuidor fica responsável pela manutenção, ChibiScript pra páginas novas, `tests.json` obrigatório (pode falhar inicialmente, maintainers verificam depois), seguir `PageInterface`, Discord `#programming` pra discutir features grandes antes — a usuária optou por **não** passar pelo Discord antes de abrir os PRs.

## Chaves e credenciais

`webpackConfig/utils/keys.js` tem client id/secret do Trakt e Simkl (formato client id base64url é o padrão pós-migração deles) seguindo o mesmo padrão de exposição que as chaves do Simkl já têm no repo. Decisão consciente: manter públicas para os revisores conseguirem testar sem criar app próprio; PR menciona que os maintainers podem trocar por um app da organização depois. Essas mesmas chaves foram reusadas no script de auditoria standalone (`scripts/trakt-validation/`).

## Próximos passos sugeridos

A usuária decidiu **finalizar a feature de Trakt nesta sessão** — parar de desenvolver, registrar tudo (este arquivo) e seguir pra próxima etapa. Trabalho de código no Trakt está pausado por decisão dela, não por estar incompleto.

1. **Commitar as mudanças pendentes desta sessão** na `teste-local` (bugs #6-9, script de auditoria, checkboxes de seleção) — ainda não commitadas no momento em que este handoff foi escrito.
2. Cherry-pick desses commits novos pra `feature/trakt-sync`, já que ela ficou pra trás.
3. Usuária dá push nas branches atualizadas e abre os PRs, quando decidir seguir com isso.
4. Resolver o `tests.json` do Prime Video/HBO Max com URLs reais (branch travada nisso).
5. (Opcional, mencionado à usuária mas não feito) reportar o bug do Origin (#1) pro fórum/GitHub do Trakt.
6. (Opcional, baixa prioridade, documentado acima) estender a consolidação pra cobrir trilogias de filmes compartilhando um `traktId`.

## Memória de longo prazo já salva

Os arquivos em `C:\Users\anand\.claude\projects\C--Users-anand-OneDrive-Documentos-MALSync\memory\` (`trakt-integration-state.md`, `user-profile.md`, `MEMORY.md`) têm um resumo persistente disso — este HANDOFF.md é o complemento detalhado. **Vale atualizar `trakt-integration-state.md`** com o resultado desta sessão (feature considerada funcionalmente pronta e validada com dado real, sessão de debug encerrada por decisão da usuária) na próxima vez que a memória for consolidada.
