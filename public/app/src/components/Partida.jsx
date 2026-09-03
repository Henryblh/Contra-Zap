import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { socket, chamar } from '../socket.js';
import { assinarSessaoRetomada } from '../sessao.js';
import { MENSAGENS_PRONTAS, CHAT_COOLDOWN_MS } from '../chatMensagens.js';

// Tela 3: uma sala inteira, da espera até o fim da partida. É um componente
// só (não um por fase) porque é uma assinatura contínua dos mesmos eventos
// do GameController, do início ao fim — ver conexao/PROTOCOLO.md pra tabela
// completa de eventos e payloads.
// `reconexao`, quando presente, vem do ack de "reconectar" (chamado pela
// Lobby depois de sair de uma partida em andamento) — { mao, cartasRodada,
// suaVez, jogadorDaVez, suaVezDaAposta, jogadorDaVezAposta } — e é o que
// permite montar esta tela já em andamento, sem esperar um
// novaRodadaIniciada/suaMao/turnoAposta que já aconteceram antes da gente
// voltar (a partida não pausa enquanto o assento está no automático). As
// duas frentes (aposta e carta) nunca vêm preenchidas ao mesmo tempo — no
// máximo uma delas reflete a espera de verdade, a outra some sozinha assim
// que a fase seguinte começar de verdade.

// Quanto tempo a vaza encerrada fica congelada na mesa (com a carta
// vencedora destacada) antes de limpar pra próxima — só pra dar tempo de
// ver quem levou. Cancelada na hora se a partida andar antes disso.
const PAUSA_VAZA_MS = 1600;

// Naipe -> símbolo + cor. Toda carta é desenhada assim: rank grande no
// meio + naipe colorido embaixo, uma cor sólida por naipe — continua
// legível mesmo com um filtro pesado (pixelado etc.) por cima da tela.
const NAIPES = {
    Ouros:   { simbolo: '♦', cor: '#f2555a' },
    Copas:   { simbolo: '♥', cor: '#f2555a' },
    Espadas: { simbolo: '♠', cor: '#5c9dff' },
    Paus:    { simbolo: '♣', cor: '#42c98a' },
};

// As cartas chegam do servidor como a string "[4 de Ouros]"
// (Carta.toString()) — quebra em rank/naipe pra desenhar a carta.
function lerCarta(texto) {
    const m = /^\[(.+) de (.+)]$/.exec(String(texto ?? '').trim());
    return m ? { rank: m[1], naipe: m[2] } : null;
}

function CartaGrande({ texto }) {
    const carta = lerCarta(texto);
    if (!carta) return <>{texto}</>;
    const naipe = NAIPES[carta.naipe] ?? { simbolo: '', cor: 'var(--texto)' };
    return (
        <span className="carta-grande-face" style={{ color: naipe.cor }}>
            <span className="carta-grande-rank">{carta.rank}</span>
            <span className="carta-grande-naipe">{naipe.simbolo}</span>
        </span>
    );
}

// Filtro CSS aplicado na TELA INTEIRA (no #root) — brincadeira de estética,
// sem nada especial por trás, só troca a string. `url(#fx-pixelar)` é o
// filtro SVG definido no portal lá embaixo (tamanho do pixel vem do slider).
const FILTROS = {
    nenhum:    '',
    pixelado:  'url(#fx-pixelar)',
    gameboy:   'url(#fx-pixelar) grayscale(1) sepia(1) saturate(2.6) hue-rotate(55deg) contrast(1.4) brightness(0.95)',
    crt:       'saturate(1.6) contrast(1.35) brightness(1.12) drop-shadow(0 0 1px rgba(255,255,255,0.35))',
    sepia:     'sepia(0.85) contrast(1.1)',
    negativo:  'invert(1) hue-rotate(180deg)',
    cinza:     'grayscale(1) contrast(1.15)',
    desfoque:  'blur(2px)',
};
const USA_PIXEL = new Set(['pixelado', 'gameboy']);

// Mapa de deslocamento pro feDisplacementMap da curvatura CRT: um
// gradiente num eixo só (X -> canal R, Y -> canal G), com stops em "S"
// (varia devagar no meio, rápido perto das bordas) pra dar cara de
// barril/tubo em vez de um esticão linear. 128 no canal do eixo = "não
// desloca". Os outros canais ficam em 0 pra os dois mapas (X e Y) poderem
// ser somados por um feBlend screen num único feDisplacementMap. Sai como
// data-URI de SVG esticado com preserveAspectRatio="none".
function mapaCurvatura(eixo) {
    const stops = [[0, 0], [0.15, 30], [0.35, 85], [0.5, 128], [0.65, 171], [0.85, 225], [1, 255]];
    const paradas = stops
        .map(([o, v]) => `<stop offset='${o}' stop-color='${eixo === 'x' ? `rgb(${v},0,0)` : `rgb(0,${v},0)`}'/>`)
        .join('');
    const svg =
        `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>` +
        `<defs><linearGradient id='m' x1='0' y1='0' x2='${eixo === 'x' ? 1 : 0}' y2='${eixo === 'x' ? 0 : 1}'>` +
        `${paradas}</linearGradient></defs><rect width='64' height='64' fill='url(#m)'/></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
const MAPA_CURV_X = mapaCurvatura('x');
const MAPA_CURV_Y = mapaCurvatura('y');

export default function Partida({ salaId, jogadoresIniciais, segundosIniciais, reconexao, chatAberto, meuNome, onSairDaSala, onSairDaPartida, onEntrouNaSala }) {
    // Semeado do ack de criarSala/entrarSala, não do broadcast de
    // listaJogadores — o primeiro broadcast sai antes desta tela existir
    // (e o listener abaixo com ele), então dependeria de um evento que já
    // passou. Broadcasts seguintes (mais gente entrando) chegam normal.
    const [jogadores, setJogadores] = useState(jogadoresIniciais ?? []);
    // Semeado do ack de criarSala/entrarSala (não do broadcast de
    // partidaIniciandoEm): quando os bots — ou a última entrada — lotam a
    // sala, esse broadcast sai antes desta tela existir. Broadcasts
    // seguintes (ex.: forcarInicio cancelado não existe, mas outra lotação
    // depois de um sairSala, sim) chegam normal pelo handler abaixo.
    const [segundosParaIniciar, setSegundosParaIniciar] = useState(segundosIniciais ?? null);
    const [iniciada, setIniciada] = useState(!!reconexao);
    const [mao, setMao] = useState(reconexao?.mao ?? []);
    // { [nome]: string[] } — mãos dos outros que o servidor deixou este
    // jogador ver. Hoje só a rodada de 1 carta ("testa") preenche isto: cada
    // um vê a mão dos outros e esconde a sua. Zera a cada novaRodadaIniciada.
    const [maosReveladas, setMaosReveladas] = useState(
        () => Object.fromEntries((reconexao?.maosReveladas ?? []).map((m) => [m.jogador, m.mao]))
    );
    const [jogadorDaVezAposta, setJogadorDaVezAposta] = useState(reconexao?.jogadorDaVezAposta ?? null);
    const [valorAposta, setValorAposta] = useState('');
    const [cartasRodada, setCartasRodada] = useState(reconexao?.cartasRodada ?? 0);
    const [jogadorDaVez, setJogadorDaVez] = useState(reconexao?.jogadorDaVez ?? null);
    const [mesa, setMesa] = useState([]);
    // Vaza recém-encerrada, segurada na tela por PAUSA_VAZA_MS antes de
    // limpar a mesa — { vencedor: string|null, carta: string|null }, ou
    // null quando não tem pausa rolando. O ref espelha o mesmo valor de
    // forma síncrona porque os handlers de socket (efeito com deps
    // [salaId]) capturam só o estado do primeiro render — sem o ref, um
    // cartaJogada da vaza seguinte não enxergaria a pausa em andamento.
    const [vazaResultado, setVazaResultado] = useState(null);
    const vazaResultadoRef = useRef(null);
    const limparVazaTimerRef = useRef(null);
    // Painel flutuante de filtro de tela — brincadeira de estética, 100%
    // local, não toca no servidor nem no protocolo. `efeito` é uma chave
    // de FILTROS; `pixel` é o tamanho do quadradinho do filtro pixelado.
    const [efeito, setEfeito] = useState('nenhum');
    const [pixel, setPixel] = useState(7);
    // Grão / dither: ruído por-pixel somado à tela toda pra quebrar as
    // áreas de cor chapada — a mesma ideia do filtro "Old_Data" de
    // Inscryption. `grao` é a intensidade (0 = desligado); `graoColorido`
    // mexe em cada canal RGB em vez de só no brilho; `graoAnimado`
    // re-semeia o ruído a ~15fps pra ele "ferver" que nem grão de filme.
    // `graoSeed` é o seed atual do feTurbulence (só muda com o animado).
    const [grao, setGrao] = useState(0);
    const [graoColorido, setGraoColorido] = useState(false);
    const [graoAnimado, setGraoAnimado] = useState(false);
    const [graoSeed, setGraoSeed] = useState(1);
    // CRT: três peças independentes, cada uma no seu slider (0 = off).
    // `curvatura` = feDisplacementMap em barril (a tela "boja" pra fora);
    // `scanlines` = intensidade do overlay de linhas escuras (multiply, é
    // uma div dentro do #root, então curva junto), e `scanlinePasso` é o
    // período em px (grande = linhas grossas e esparsas; pequeno = finas e
    // densas); `aberracao` = separa os canais RGB e empurra cada um um
    // tanto diferente (franja cromática de tubo).
    const [curvatura, setCurvatura] = useState(0);
    const [scanlines, setScanlines] = useState(0);
    const [scanlinePasso, setScanlinePasso] = useState(3);
    const [aberracao, setAberracao] = useState(0);
    const [vira, setVira] = useState(null);
    const [ultimoPlacar, setUltimoPlacar] = useState([]);
    const [vencedor, setVencedor] = useState(null);
    // { novaSalaId, jogador } quando o adm da sala chama jogarDeNovo depois
    // do fim da partida — ver convidadoParaRevanche em PROTOCOLO.md. null
    // enquanto ninguém chamou (ou depois que este jogador já respondeu).
    const [conviteRevanche, setConviteRevanche] = useState(null);
    const [criandoRevanche, setCriandoRevanche] = useState(false);
    const [log, setLog] = useState([]);
    const [erro, setErro] = useState(null);
    // Espelha apostaFeita/jogadoresEliminados num formato fácil de olhar na
    // UI (o log de eventos já registra isso, mas em texto corrido — ruim
    // pra debugar de relance quem já apostou e quem já morreu). `apostas`
    // zera a cada novaRodadaIniciada; `eliminados` só cresce (eliminação é
    // definitiva na partida).
    const [apostas, setApostas] = useState({});
    const [eliminados, setEliminados] = useState([]);
    // Nomes de quem está jogando no automático agora (jogadorExpulsoPorInatividade
    // sem um jogadorReconectou depois) — flag visual pro front marcar "isso
    // aqui é um bot temporário", diferente de `eliminados` (não zera sozinha,
    // só sai daqui de novo se reconectar).
    const [desconectados, setDesconectados] = useState([]);
    // Chat da sala (ver conexao/PROTOCOLO.md). `mensagensChat` acumula o que
    // chega em chatMensagem (broadcast, inclui o que eu mesmo mandei).
    // `cooldownAte` é o timestamp até quando os botões de envio ficam
    // travados — 3s depois de qualquer envio, pra não virar spam.
    const [mensagensChat, setMensagensChat] = useState([]);
    const [textoChat, setTextoChat] = useState('');
    const [erroChat, setErroChat] = useState(null);
    const [cooldownAte, setCooldownAte] = useState(0);
    const [agora, setAgora] = useState(() => Date.now());
    const feedChatRef = useRef(null);

    useEffect(() => {
        const registrar = (linha) => setLog((anterior) => [...anterior.slice(-49), linha]);
        const daSala = (payload) => payload.salaId === salaId;
        // Corta a pausa da vaza na hora (timer + estado + ref) — usado
        // quando a partida anda antes do PAUSA_VAZA_MS acabar.
        const encerrarPausaVaza = () => {
            clearTimeout(limparVazaTimerRef.current);
            limparVazaTimerRef.current = null;
            vazaResultadoRef.current = null;
            setVazaResultado(null);
        };

        if (reconexao) {
            if (reconexao.jogadorDaVezAposta) {
                registrar(`🔌 Reconectado — ${reconexao.suaVezDaAposta ? 'sua vez de apostar agora' : `vez de ${reconexao.jogadorDaVezAposta} apostar`}`);
            } else {
                registrar(`🔌 Reconectado — ${reconexao.suaVez ? 'sua vez agora' : `vez de ${reconexao.jogadorDaVez ?? '...'}`}`);
            }
        }

        const handlers = {
            listaJogadores(p) {
                if (!daSala(p)) return;
                setJogadores(p.jogadores);
                registrar(`Sala: ${p.jogadores.map((j) => j.nome).join(', ')}`);
            },
            partidaIniciandoEm(p) {
                if (!daSala(p)) return;
                setSegundosParaIniciar(p.segundos);
                registrar(`Sala cheia — partida em ${p.segundos}s (ou "Forçar início")`);
            },
            novaRodadaIniciada(p) {
                if (!daSala(p)) return;
                setIniciada(true);
                setMesa([]);
                encerrarPausaVaza();
                setVira(null);
                setJogadorDaVezAposta(null);
                setCartasRodada(p.cartas);
                setApostas({});
                setMaosReveladas({});
                registrar(`Rodada ${p.numero} (${p.cartas} carta(s))`);
            },
            suaMao(p) {
                if (!daSala(p)) return;
                setMao(p.mao);
                registrar(`Sua mão: ${p.mao.join(', ')}`);
            },
            maosReveladas(p) {
                if (!daSala(p)) return;
                setMaosReveladas(Object.fromEntries(p.maos.map((m) => [m.jogador, m.mao])));
                registrar(`👁️ Rodada cega — ${p.maos.map((m) => `${m.jogador}: ${m.mao.join(', ')}`).join(' | ')}`);
            },
            manilhaVirada(p) {
                if (!daSala(p)) return;
                setVira({ carta: p.vira, valor: p.viraValor });
                registrar(`Vira: ${p.vira} — manilha valor ${p.viraValor}`);
            },
            turnoAposta(p) {
                if (!daSala(p)) return;
                setJogadorDaVezAposta(p.jogador);
                registrar(`Vez de ${p.jogador} apostar`);
            },
            apostaFeita(p) {
                if (!daSala(p)) return;
                setJogadorDaVezAposta(null);
                setApostas((anterior) => ({ ...anterior, [p.jogador]: p.aposta }));
                registrar(`${p.jogador} apostou ${p.aposta}`);
            },
            turnoJogador(p) {
                if (!daSala(p)) return;
                setJogadorDaVez(p.jogador);
                registrar(`Vez de ${p.jogador}`);
            },
            cartaJogada(p) {
                if (!daSala(p)) return;
                // Se a vaza anterior ainda está congelada na mesa (pausa
                // rodando), a primeira carta da vaza nova abre a mesa do
                // zero em vez de empilhar em cima da que acabou.
                const abrindoVazaNova = vazaResultadoRef.current != null;
                if (abrindoVazaNova) encerrarPausaVaza();
                setMesa((anterior) => [
                    ...(abrindoVazaNova ? [] : anterior),
                    { jogador: p.jogador, carta: p.carta },
                ]);
                // Cobre a jogada automática por timeout: nesse caso ninguém
                // chamou jogar() localmente, então a carta nunca saiu da
                // mão — sem isso ficava uma carta fantasma na UI. Pra
                // jogada manual (que já removeu por índice em jogar()) isso
                // não acha a carta de novo e não faz nada.
                if (p.jogador === meuNome) {
                    setMao((anterior) => {
                        const indice = anterior.indexOf(p.carta);
                        return indice === -1 ? anterior : anterior.filter((_, i) => i !== indice);
                    });
                }
                registrar(`${p.jogador} jogou ${p.carta}`);
            },
            vazaFinalizada(p) {
                if (!daSala(p)) return;
                // Não limpa na hora: segura a mesa por PAUSA_VAZA_MS com a
                // carta vencedora destacada (borda verde), pra dar tempo de
                // ver quem levou. cartaJogada / novaRodadaIniciada cancelam
                // o timer e limpam na hora se a partida andar antes disso.
                vazaResultadoRef.current = { vencedor: p.vencedor, carta: p.carta };
                setVazaResultado(vazaResultadoRef.current);
                clearTimeout(limparVazaTimerRef.current);
                limparVazaTimerRef.current = setTimeout(() => {
                    limparVazaTimerRef.current = null;
                    vazaResultadoRef.current = null;
                    setMesa([]);
                    setVazaResultado(null);
                }, PAUSA_VAZA_MS);
                registrar(p.vencedor ? `Vaza: ${p.vencedor} venceu com ${p.carta}` : 'Vaza melada — ninguém pontuou');
            },
            rodadaFinalizada(p) {
                if (!daSala(p)) return;
                setUltimoPlacar(p.resultado);
                registrar(`Fim da rodada ${p.numero}`);
            },
            jogadoresEliminados(p) {
                if (!daSala(p)) return;
                const nomes = p.eliminados.map((j) => j.nome);
                setEliminados((anterior) => [...new Set([...anterior, ...nomes])]);
                registrar(`💀 Eliminado(s): ${nomes.join(', ')}`);
            },
            jogoFinalizado(p) {
                if (!daSala(p)) return;
                setVencedor(p.vencedor);
                registrar(`🏆 Vencedor: ${p.vencedor}`);
            },
            convidadoParaRevanche(p) {
                if (!daSala(p)) return;
                // Sou eu quem chamou jogarDeNovo — já sei pelo ack, e já vou
                // transicionar pra sala nova por ele; não preciso do meu
                // próprio convite (o broadcast inclui todo mundo da sala,
                // inclusive quem chamou).
                if (p.jogador === meuNome) return;
                setConviteRevanche({ novaSalaId: p.novaSalaId, jogador: p.jogador });
            },
            jogadaAutomatica(p) {
                if (!daSala(p)) return;
                registrar(`⏱️ ${p.jogador} não respondeu a tempo — jogada automática`);
            },
            jogadorReconectou(p) {
                if (!daSala(p)) return;
                setDesconectados((anterior) => anterior.filter((nome) => nome !== p.jogador));
                registrar(`🔌 ${p.jogador} reconectou`);
            },
            chatMensagem(p) {
                if (!daSala(p)) return;
                setMensagensChat((anterior) => [
                    ...anterior.slice(-99),
                    { jogador: p.jogador, texto: p.texto, tipo: p.tipo },
                ]);
            },
            jogadorExpulsoPorInatividade(p) {
                if (!daSala(p)) return;
                // Mesmo evento pra inatividade de verdade e pra "Sair da
                // partida" (ver PROTOCOLO.md) — o cliente não distingue os
                // dois casos, e a mensagem serve pros dois igual.
                setDesconectados((anterior) => (anterior.includes(p.jogador) ? anterior : [...anterior, p.jogador]));
                if (p.jogador === meuNome) {
                    registrar('⏱️ Você foi desconectado da sala por inatividade');
                    onSairDaPartida(salaId);
                } else {
                    registrar(`🤖 ${p.jogador} desconectou — um bot assumiu o lugar dele até reconectar`);
                }
            },
            novoAdm(p) {
                if (!daSala(p)) return;
                setJogadores((anterior) => anterior.map((j) => ({ ...j, adm: j.nome === p.jogador })));
                registrar(p.jogador === meuNome ? '👑 Você virou o adm da sala' : `👑 ${p.jogador} virou o adm da sala`);
            },
        };

        // Loga todo evento recebido, com nome e payload — cobre qualquer
        // handler acima sem precisar espalhar console.log manual por dentro
        // de cada um. Confira o console do navegador (F12) pra debugar o
        // que chega ao abrir/jogar numa sala.
        const comLog = Object.fromEntries(
            Object.entries(handlers).map(([evento, handler]) => [
                evento,
                (payload) => {
                    console.log(`[socket] ${evento}`, payload);
                    handler(payload);
                },
            ])
        );

        for (const [evento, handler] of Object.entries(comLog)) socket.on(evento, handler);
        return () => {
            for (const [evento, handler] of Object.entries(comLog)) socket.off(evento, handler);
            clearTimeout(limparVazaTimerRef.current);
        };
    }, [salaId]);

    // String de filtro CSS montada na ordem da cadeia: cor/base -> grão ->
    // ótica do tubo (aberração + curvatura por último, pra tudo — inclusive
    // o ruído — bojar junto). O pixelado entra ANTES do grão (senão o
    // feFlood dele amostra 1 ponto por célula e engole o ruído).
    //
    // O #fx-pixelar carrega o tamanho no id (#fx-pixelar-7) porque a Chrome
    // não reavalia esse filtro só por mudar atributo de feTile/feFlood. Já
    // grão e CRT usam id FIXO: um <filter> sem ninguém referenciando não
    // custa nada, e id estável evita recriar/re-rasterizar feTurbulence e
    // feImage a cada mexida de slider (era isso que travava ao arrastar).
    // Exceção: o grão animado precisa do seed no id pra "ferver" de fato.
    const grId = grao > 0 && graoAnimado ? `fx-grao-${graoSeed}` : 'fx-grao';
    const crtAtivo = curvatura > 0 || aberracao > 0;
    const filtroCss = [
        (FILTROS[efeito] ?? '').replaceAll('#fx-pixelar', `#fx-pixelar-${pixel}`),
        grao > 0 ? `url(#${grId})` : '',
        crtAtivo ? 'url(#fx-crt)' : '',
    ].filter(Boolean).join(' ');
    const usaPixel = USA_PIXEL.has(efeito);
    // feComponentTransfer linear em torno de 0.5: saída = 0.5 + k*(ruído -
    // 0.5), com k = 2*(grao/100). k=0 não mexe no pixel (soft-light com
    // cinza 50% é no-op); k alto satura em preto/branco puro (chiado).
    const grK = (grao / 100) * 2;
    const grC = 0.5 - grao / 100;
    // Aberração: deslocamento em px INTEIROS (feOffset sub-pixel cai no
    // caminho lento de reamostragem bilinear — e isso re-roda a cada
    // repaint, inclusive ao scrollar o log). Curvatura negativa = barril
    // (feDisplacementMap desloca por scale*(canal-0.5); gradiente 0->255,
    // scale<0 empurra as bordas pra fora).
    const abInt = aberracao > 0 ? Math.max(1, Math.round((aberracao / 100) * 8)) : 0;
    const curvPx = -(curvatura / 100) * 28;

    // Filtro de tela: aplicado direto no #root (a app inteira), não em cada
    // carta — a ideia é "tacar um filtro na estética do jogo" e ver como
    // fica, sem mexer em mais nada. O painel de controle fica num portal
    // pro <body>, fora do #root, então não é afetado pelo próprio filtro.
    //
    // `filter` só pega o elemento + descendentes: o #root é a coluna de
    // 720px, então o FUNDO que sobra dos lados (pintado pelo <body>, pai do
    // #root) ficava de fora. Enquanto tem filtro ligado a gente "promove" o
    // #root a tela cheia e joga o background nele, pro filtro pegar o fundo
    // junto; ao desligar, volta tudo pro que o CSS define. A .partida-layout
    // já se centraliza sozinha na viewport (left:50% + translateX(-50%)),
    // então tirar o max-width do #root não mexe no layout.
    // Overscan quando a curvatura tá ligada: o barril puxa o conteúdo pra
    // dentro e deixaria cunhas de fundo nos 4 cantos (não dá pra ver o
    // canto). Um scale de leve empurra isso pra fora da viewport — que é
    // exatamente o overscan de uma TV de tubo de verdade.
    const overscan = curvatura > 0 ? 1 + (curvatura / 100) * 0.06 : 1;
    useEffect(() => {
        const root = document.getElementById('root');
        if (!root) return;
        root.style.filter = filtroCss;
        root.style.maxWidth = filtroCss ? 'none' : '';
        root.style.minHeight = filtroCss ? '100vh' : '';
        root.style.background = filtroCss ? 'var(--bg)' : '';
        root.style.transform = overscan !== 1 ? `scale(${overscan})` : '';
        return () => {
            root.style.filter = '';
            root.style.maxWidth = '';
            root.style.minHeight = '';
            root.style.background = '';
            root.style.transform = '';
        };
    }, [filtroCss, overscan]);

    // "Ferve" o grão re-semeando o feTurbulence a ~15fps — capado bem
    // baixo de propósito (feTurbulence é caro, e frame rate baixo combina
    // com o look lo-fi). Só roda com o grão ligado E animado.
    useEffect(() => {
        if (grao <= 0 || !graoAnimado) return;
        let raf;
        let ultimo = 0;
        const passo = (t) => {
            raf = requestAnimationFrame(passo);
            if (t - ultimo < 66) return;
            ultimo = t;
            setGraoSeed((s) => (s % 97) + 1);
        };
        raf = requestAnimationFrame(passo);
        return () => cancelAnimationFrame(raf);
    }, [grao, graoAnimado]);

    // Reconexão de rede enquanto esta tela já estava aberta (ver App.jsx e
    // sessao.js): o socket muda de id, então o servidor não sabe mais que
    // este socket pertence a esta room — sem chamar `reconectar` de novo,
    // a tela continuaria parecendo viva, mas surda a qualquer evento novo
    // da partida. Assina `assinarSessaoRetomada`, não o `connect` cru do
    // socket.io — só dispara DEPOIS que o servidor já reautenticou o
    // socket (ver App.jsx), senão este `reconectar` chegaria cedo demais e
    // voltaria NAO_IDENTIFICADO. Antes da partida começar não faz sentido
    // tentar: uma queda de conexão nessa fase já tira o assento de verdade
    // (sairSala automático, ver PROTOCOLO.md) — não tem pra onde voltar.
    useEffect(() => {
        if (!iniciada) return;

        async function ressincronizar() {
            try {
                const resposta = await chamar('reconectar', { salaId });
                setMao(resposta.mao);
                setCartasRodada(resposta.cartasRodada);
                setMaosReveladas(Object.fromEntries((resposta.maosReveladas ?? []).map((m) => [m.jogador, m.mao])));
                setJogadorDaVez(resposta.jogadorDaVez);
                setJogadorDaVezAposta(resposta.jogadorDaVezAposta);
                setLog((anterior) => [...anterior.slice(-49), '🔌 Conexão restabelecida — sincronizado com a partida']);
            } catch {
                // melhor esforço — se a sala não existir mais, ou a vaga já
                // tiver expirado enquanto estávamos fora (ver
                // PROTOCOLO.md), não tem o que sincronizar; a próxima ação
                // que falhar avisa o jogador do jeito de sempre.
            }
        }

        return assinarSessaoRetomada(ressincronizar);
    }, [iniciada, salaId]);

    // Enquanto o cooldown está de pé, um tiquetaque só pra atualizar o
    // contador na tela; para sozinho quando zera.
    useEffect(() => {
        if (cooldownAte <= Date.now()) return;
        const id = setInterval(() => setAgora(Date.now()), 250);
        return () => clearInterval(id);
    }, [cooldownAte]);

    // Rola o feed do chat pro fim sempre que chega mensagem nova.
    useEffect(() => {
        const el = feedChatRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [mensagensChat]);

    const segundosCooldown = Math.max(0, Math.ceil((cooldownAte - agora) / 1000));
    const chatEmCooldown = segundosCooldown > 0;

    // Um caminho só pros dois tipos de envio: manda, arma o cooldown de 3s no
    // sucesso, mostra o erro do ack no painel do chat.
    async function enviarChat(conteudo) {
        setErroChat(null);
        try {
            await chamar('chat', { salaId, ...conteudo });
            setCooldownAte(Date.now() + CHAT_COOLDOWN_MS);
            setAgora(Date.now());
            return true;
        } catch (erroDaChamada) {
            setErroChat(erroDaChamada.message);
            return false;
        }
    }

    function enviarChatPronta(id) {
        if (chatEmCooldown) return;
        enviarChat({ tipo: 'restrita', id });
    }

    async function enviarChatLivre(evento) {
        evento.preventDefault();
        if (chatEmCooldown) return;
        const texto = textoChat.trim();
        if (!texto) return;
        if (await enviarChat({ tipo: 'aberta', texto })) setTextoChat('');
    }

    async function apostar(evento) {
        evento.preventDefault();
        setErro(null);
        const valor = Number(valorAposta);
        if (!Number.isInteger(valor) || valor < 0 || valor > cartasRodada) {
            setErro(`Aposta precisa ser um número inteiro entre 0 e ${cartasRodada}.`);
            return;
        }
        try {
            await chamar('apostar', { salaId, valor });
            setValorAposta('');
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    async function jogar(indice) {
        setErro(null);
        try {
            await chamar('jogarCarta', { salaId, indice });
            setMao((anterior) => anterior.filter((_, i) => i !== indice));
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    async function forcarInicio() {
        setErro(null);
        try {
            await chamar('forcarInicio', { salaId });
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        }
    }

    // Só o adm vê o botão que chama isto (ver souDono mais abaixo) — cria
    // uma sala nova com a mesma config da que acabou e já entra nela; quem
    // mais estava aqui recebe o convite (convidadoParaRevanche) por fora.
    async function jogarDeNovo() {
        setErro(null);
        setCriandoRevanche(true);
        try {
            const resposta = await chamar('jogarDeNovo', { salaId });
            onEntrouNaSala(resposta.salaId, resposta.jogadores, resposta.segundosParaIniciar, resposta.chatAberto);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
            setCriandoRevanche(false);
        }
    }

    // Sim: primeiro sai de verdade da sala antiga (sairDaPartida,
    // best-effort — precisa vir ANTES de entrarSala na nova: o servidor só
    // tira o socket da room antiga se `salaPorSocket` ainda apontar pra ela
    // nesse momento; se a ordem fosse invertida, o socket já estaria
    // marcado como pertencendo à sala nova e a saída da antiga seria
    // ignorada, deixando a room velha presa pra sempre — ver
    // encerrarSeFinalizadaEVazia em conexao/socketServer.js). Só depois
    // entra na sala nova, igual um entrarSala normal (o convite não é mais
    // que isso — o adm já criou a sala, o resto do fluxo é o de sempre).
    async function aceitarConviteRevanche() {
        setErro(null);
        try {
            try {
                await chamar('sairDaPartida', { salaId });
            } catch {
                // melhor esforço — a sala antiga já terminou, o assento não importa mais
            }
            const resposta = await chamar('entrarSala', { salaId: conviteRevanche.novaSalaId });
            onEntrouNaSala(conviteRevanche.novaSalaId, resposta.jogadores, resposta.segundosParaIniciar, resposta.chatAberto);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
            setConviteRevanche(null);
        }
    }

    // Botão de sair é sempre uma opção, antes ou depois da partida começar —
    // só muda o que significa "sair". Antes: sairSala de verdade (tira o
    // assento, ver PROTOCOLO.md). Depois: sairDaPartida — o assento vira bot
    // na hora no servidor (reaproveita o caminho da expulsão por
    // inatividade), em vez de esperar o timeout de inatividade acumular a
    // cada turno. Nos dois casos a gente volta pra tela de salas; se a
    // partida já tinha começado, a Lobby oferece reconectar (a vaga
    // continua reservada). O onSairDaPartida também é chamado pelo handler
    // de jogadorExpulsoPorInatividade quando o evento chega — chamar aqui
    // cobre o caso de a resposta demorar/falhar, e a dupla chamada é
    // idempotente (mesmo salaId, mesmo setSala(null)).
    async function sair() {
        if (!iniciada) {
            try {
                await chamar('sairSala', { salaId });
            } catch {
                // melhor esforço — se a partida começou bem nesse meio tempo, cai no caso abaixo
            }
            onSairDaSala();
            return;
        }
        try {
            await chamar('sairDaPartida', { salaId });
        } catch {
            // melhor esforço — mesmo se falhar, saímos da tela; o assento
            // acaba virando bot pelo timeout de inatividade de qualquer jeito
        }
        onSairDaPartida(salaId);
    }

    const souEuNaVez = iniciada && jogadorDaVez === meuNome && !vencedor;
    const souEuNaVezDaAposta = iniciada && jogadorDaVezAposta === meuNome && !vencedor;
    const souDono = jogadores.find((j) => j.nome === meuNome)?.adm === true;
    // Rodada de 1 carta: a própria carta fica virada (o servidor manda o
    // valor em suaMao, mas aqui a gente não mostra — a mão continua jogável
    // normalmente por índice). As cartas dos outros vêm em maosReveladas.
    const rodadaCega = iniciada && cartasRodada === 1;
    const outrosNaTesta = Object.entries(maosReveladas);

    return (
        <>
        <div className="partida-layout">
            {/* Portal pro <body>: fica FORA do #root, então o filtro de tela
                (aplicado no #root) não pega o painel nem o próprio <filter>.
                O filtro SVG "pixelado": feFlood/feComposite/feTile amostra 1
                ponto por célula e feMorphology infla pra encher o quadradinho;
                o id carrega o tamanho (#fx-pixelar-7) pra reavaliar ao mexer
                no slider. */}
            {createPortal(
                <>
                    <svg className="fx-defs" aria-hidden="true">
                        {/* região justa: com filtro ligado o #root já é a
                            viewport inteira (a .partida-layout não estoura
                            mais pros lados), então não precisa de folga
                            gigante — quanto menor a região, menos pixel o
                            filtro reprocessa a cada repaint. */}
                        <filter id={`fx-pixelar-${pixel}`} x="-6%" y="-6%" width="112%" height="112%" colorInterpolationFilters="sRGB">
                            <feFlood x={pixel / 2} y={pixel / 2} width="2" height="2" />
                            <feComposite width={pixel} height={pixel} />
                            <feTile result="grade" />
                            <feComposite in="SourceGraphic" in2="grade" operator="in" />
                            <feMorphology operator="dilate" radius={pixel / 2} />
                        </filter>
                        {/* Grão/dither: feTurbulence só num quadrado de 220px
                            (stitchTiles + feTile repete sem emenda) — calcular
                            ruído na viewport inteira era ~40x mais caro. Daí
                            feColorMatrix achata pra cinza (modo brilho),
                            feComponentTransfer faz o contraste em torno de 0.5
                            = intensidade, e soft-light aplica na tela. */}
                        <filter id={grId} x="-6%" y="-6%" width="112%" height="112%" colorInterpolationFilters="sRGB">
                            <feTurbulence
                                type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed={graoSeed}
                                x="0" y="0" width="220" height="220" stitchTiles="stitch" result="grTile"
                            />
                            <feTile in="grTile" result="grBruto" />
                            {!graoColorido && (
                                <feColorMatrix
                                    in="grBruto" type="matrix"
                                    values="0.333 0.333 0.333 0 0 0.333 0.333 0.333 0 0 0.333 0.333 0.333 0 0 0 0 0 0 1"
                                    result="grLum"
                                />
                            )}
                            <feComponentTransfer in={graoColorido ? 'grBruto' : 'grLum'} result="grFinal">
                                <feFuncR type="linear" slope={grK} intercept={grC} />
                                <feFuncG type="linear" slope={grK} intercept={grC} />
                                <feFuncB type="linear" slope={grK} intercept={grC} />
                                <feFuncA type="linear" slope="0" intercept="1" />
                            </feComponentTransfer>
                            <feBlend mode="soft-light" in="grFinal" in2="SourceGraphic" result="grMix" />
                            <feComposite in="grMix" in2="SourceGraphic" operator="in" />
                        </filter>
                        {/* CRT. Aberração: só R e B deslocados no eixo X (px
                            inteiro), G no lugar e carregando o alpha; soma os
                            três (canais não se sobrepõem). Curvatura: um
                            feDisplacementMap com os dois mapas de rampa (X no
                            canal R, Y no G, stops em "S" = barril) somados.
                            Cada bloco só entra na cadeia se o slider dele > 0
                            — com só aberração ligada não paga feImage nenhum. */}
                        <filter id="fx-crt" x="-8%" y="-8%" width="116%" height="116%" colorInterpolationFilters="sRGB">
                            {aberracao > 0 && (
                                <>
                                    <feOffset in="SourceGraphic" dx={abInt} dy="0" result="shR" />
                                    <feOffset in="SourceGraphic" dx={-abInt} dy="0" result="shB" />
                                    {/* cada camada FICA opaca (alpha 1) — zerar
                                        o alpha some com a cor no compositing
                                        premultiplicado e a tela fica só verde.
                                        screen de canais que não se sobrepõem
                                        (R/G/B) reconstrói a imagem exata. */}
                                    <feColorMatrix in="shR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="rOnly" />
                                    <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="gOnly" />
                                    <feColorMatrix in="shB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="bOnly" />
                                    <feBlend mode="screen" in="rOnly" in2="gOnly" result="rg" />
                                    <feBlend mode="screen" in="rg" in2="bOnly" result="aberrada" />
                                </>
                            )}
                            {curvatura > 0 && (
                                <>
                                    <feImage href={MAPA_CURV_X} preserveAspectRatio="none" x="-8%" y="-8%" width="116%" height="116%" result="mapaX" />
                                    <feImage href={MAPA_CURV_Y} preserveAspectRatio="none" x="-8%" y="-8%" width="116%" height="116%" result="mapaY" />
                                    <feBlend mode="screen" in="mapaX" in2="mapaY" result="mapaXY" />
                                    <feDisplacementMap in={aberracao > 0 ? 'aberrada' : 'SourceGraphic'} in2="mapaXY" scale={curvPx} xChannelSelector="R" yChannelSelector="G" />
                                </>
                            )}
                        </filter>
                    </svg>
                    <details className="experimentos" open>
                        <summary>🎨 filtro de tela</summary>
                        <div className="experimentos-corpo">
                            <label>
                                Filtro
                                <select value={efeito} onChange={(e) => setEfeito(e.target.value)}>
                                    {Object.keys(FILTROS).map((nome) => (
                                        <option key={nome} value={nome}>{nome}</option>
                                    ))}
                                </select>
                            </label>
                            {usaPixel && (
                                <label>
                                    Tamanho do pixel: {pixel}px
                                    <input
                                        type="range" min="2" max="16" step="1"
                                        value={pixel}
                                        onChange={(e) => setPixel(Number(e.target.value))}
                                    />
                                </label>
                            )}
                            <label>
                                Grão / dither: {grao || 'off'}
                                <input
                                    type="range" min="0" max="100" step="1"
                                    value={grao}
                                    onChange={(e) => setGrao(Number(e.target.value))}
                                />
                            </label>
                            {grao > 0 && (
                                <>
                                    <label className="linha-check">
                                        <input
                                            type="checkbox"
                                            checked={graoColorido}
                                            onChange={(e) => setGraoColorido(e.target.checked)}
                                        />
                                        ruído colorido (RGB, não só brilho)
                                    </label>
                                    <label className="linha-check">
                                        <input
                                            type="checkbox"
                                            checked={graoAnimado}
                                            onChange={(e) => setGraoAnimado(e.target.checked)}
                                        />
                                        animar (grão "fervendo")
                                    </label>
                                </>
                            )}
                            <hr className="experimentos-sep" />
                            <label>
                                CRT · curvatura: {curvatura || 'off'}
                                <input
                                    type="range" min="0" max="100" step="1"
                                    value={curvatura}
                                    onChange={(e) => setCurvatura(Number(e.target.value))}
                                />
                            </label>
                            <label>
                                CRT · scanlines: {scanlines || 'off'}
                                <input
                                    type="range" min="0" max="100" step="1"
                                    value={scanlines}
                                    onChange={(e) => setScanlines(Number(e.target.value))}
                                />
                            </label>
                            {scanlines > 0 && (
                                <label>
                                    CRT · linha: {scanlinePasso}px ({scanlinePasso <= 4 ? 'finas/densas' : scanlinePasso >= 10 ? 'grossas/esparsas' : 'meio-termo'})
                                    <input
                                        type="range" min="2" max="16" step="1"
                                        value={scanlinePasso}
                                        onChange={(e) => setScanlinePasso(Number(e.target.value))}
                                    />
                                </label>
                            )}
                            <label>
                                CRT · aberração: {aberracao || 'off'}
                                <input
                                    type="range" min="0" max="100" step="1"
                                    value={aberracao}
                                    onChange={(e) => setAberracao(Number(e.target.value))}
                                />
                            </label>
                        </div>
                    </details>
                </>,
                document.body
            )}
            <aside className="chat-painel">
                <h3>Chat</h3>
                <div className="chat-prontas">
                    {MENSAGENS_PRONTAS.map((m) => (
                        <button
                            key={m.id}
                            type="button"
                            className="secundario"
                            disabled={chatEmCooldown}
                            onClick={() => enviarChatPronta(m.id)}
                        >
                            {m.texto}
                        </button>
                    ))}
                </div>

                <div className="chat-feed" ref={feedChatRef}>
                    {mensagensChat.length === 0
                        ? <span className="vazio">(sem mensagens)</span>
                        : mensagensChat.map((m, i) => (
                            <div key={i} className="chat-msg">
                                <strong>{m.jogador === meuNome ? 'Você' : m.jogador}:</strong> {m.texto}
                            </div>
                        ))}
                </div>

                {chatAberto && (
                    <form className="chat-livre" onSubmit={enviarChatLivre}>
                        <input
                            type="text"
                            maxLength={200}
                            placeholder="Mensagem..."
                            value={textoChat}
                            onChange={(e) => setTextoChat(e.target.value)}
                        />
                        <button type="submit" disabled={chatEmCooldown || !textoChat.trim()}>
                            Enviar
                        </button>
                    </form>
                )}

                {chatEmCooldown && <span className="vazio">aguarde {segundosCooldown}s pra enviar de novo</span>}
                {erroChat && <p className="erro">{erroChat}</p>}
            </aside>

            <div className="cartao cartao-larga">
            <div className="linha" style={{ justifyContent: 'space-between' }}>
                <h1>Sala {salaId}</h1>
                <button className="secundario" onClick={sair} type="button">
                    {iniciada ? 'Sair da partida' : 'Sair da sala'}
                </button>
            </div>

            {!iniciada && (
                <section>
                    <h2>Aguardando ({jogadores.length})</h2>
                    <ul>
                        {jogadores.map((j) => <li key={j.nome}>{j.nome}</li>)}
                    </ul>
                    {segundosParaIniciar != null && (
                        <>
                            <p>Sala cheia — começa sozinha em {segundosParaIniciar}s.</p>
                            <button onClick={forcarInicio} type="button">Forçar início agora porra</button>
                        </>
                    )}
                </section>
            )}

            {iniciada && (
                <section>
                    <div className="status-jogadores">
                        {jogadores.map((j) => {
                            const morreu = eliminados.includes(j.nome);
                            const bot = desconectados.includes(j.nome);
                            const aposta = apostas[j.nome];
                            return (
                                <span
                                    key={j.nome}
                                    className={`status-jogador${morreu ? ' status-jogador-morto' : bot ? ' status-jogador-bot' : ''}`}
                                >
                                    {morreu
                                        ? `💀 ${j.nome} morreu`
                                        : bot
                                            ? `🤖 ${j.nome} (bot)`
                                            : aposta !== undefined
                                                ? `${j.nome} apostou ${aposta}`
                                                : j.nome}
                                </span>
                            );
                        })}
                    </div>

                    <h2>{vencedor ? `Vencedor: ${vencedor}` : `Vez de: ${jogadorDaVez ?? '...'}`}</h2>

                    {vencedor && souDono && (
                        <div className="botoes">
                            <button type="button" onClick={jogarDeNovo} disabled={criandoRevanche}>
                                {criandoRevanche ? 'Criando sala...' : 'Jogar de novo'}
                            </button>
                        </div>
                    )}

                    {vencedor && conviteRevanche && (
                        <section>
                            <p>{conviteRevanche.jogador} está te chamando pra outra partida.</p>
                            <div className="botoes">
                                <button type="button" onClick={aceitarConviteRevanche}>Sim</button>
                                <button type="button" onClick={sair} className="secundario">Não</button>
                            </div>
                        </section>
                    )}

                    <h3>Mesa</h3>
                    <div className="mesa">
                        {mesa.map((jogada, i) => {
                            const venceu = vazaResultado?.vencedor === jogada.jogador;
                            return (
                                <span
                                    key={i}
                                    className={`carta${venceu ? ' carta-vencedora' : ''}`}
                                >
                                    <span className="carta-face">
                                        <CartaGrande texto={jogada.carta} />
                                    </span>
                                    <small>{jogada.jogador}</small>
                                </span>
                            );
                        })}
                        {mesa.length === 0 && <span className="vazio">(vazia)</span>}
                    </div>
                    {vazaResultado && (
                        <p className="vaza-resultado">
                            {vazaResultado.vencedor
                                ? `✅ ${vazaResultado.vencedor} levou a vaza`
                                : '🫠 vaza melada — ninguém levou'}
                        </p>
                    )}

                    {vira && (
                        <>
                            <h3>Vira</h3>
                            <div className="mao">
                                <span className="carta">
                                    <span className="carta-face">
                                        <CartaGrande texto={vira.carta} />
                                    </span>
                                    <small>manilha: {vira.valor}</small>
                                </span>
                            </div>
                        </>
                    )}

                    {outrosNaTesta.length > 0 && (
                        <>
                            <h3>Rodada cega — cartas dos outros (você não vê a sua)</h3>
                            <div className="mao">
                                {outrosNaTesta.map(([nome, cartas]) => (
                                    <span key={nome} className="carta">
                                        <span className="carta-face">
                                            {cartas.length === 1
                                                ? <CartaGrande texto={cartas[0]} />
                                                : cartas.join(' ')}
                                        </span>
                                        <small>{nome}</small>
                                    </span>
                                ))}
                            </div>
                        </>
                    )}

                    {jogadorDaVezAposta && (
                        <>
                            <h3>Aposta{souEuNaVezDaAposta ? ' — sua vez' : ` — vez de ${jogadorDaVezAposta}`}</h3>
                            {souEuNaVezDaAposta ? (
                                <form className="linha" onSubmit={apostar}>
                                    <label>
                                        Quantas vazas você acha que vai fazer?
                                        <input
                                            type="number" min="0" max={cartasRodada}
                                            value={valorAposta}
                                            onChange={(e) => setValorAposta(e.target.value)}
                                            autoFocus
                                        />
                                    </label>
                                    <button type="submit">Apostar</button>
                                </form>
                            ) : (
                                <p>Aguardando {jogadorDaVezAposta} apostar...</p>
                            )}
                        </>
                    )}

                    <h3>
                        Sua mão
                        {rodadaCega ? ' — virada (rodada cega)' : ''}
                        {souEuNaVez ? ' — sua vez, clique numa carta' : ''}
                    </h3>
                    <div className="mao">
                        {mao.map((carta, indice) => (
                            <button
                                key={indice}
                                className="carta carta-clicavel"
                                disabled={!souEuNaVez}
                                onClick={() => jogar(indice)}
                            >
                                <span className="carta-face">
                                    {rodadaCega ? '🂠' : <CartaGrande texto={carta} />}
                                </span>
                            </button>
                        ))}
                        {mao.length === 0 && <span className="vazio">(sem cartas)</span>}
                    </div>

                    {ultimoPlacar.length > 0 && (
                        <>
                            <h3>Placar (última rodada)</h3>
                            <ul>
                                {ultimoPlacar.map((jogador) => (
                                    <li key={jogador.nome}>{jogador.nome}: hp {jogador.hp}</li>
                                ))}
                            </ul>
                        </>
                    )}
                </section>
            )}

            {erro && <p className="erro">{erro}</p>}

            <section>
                <h3>Log de eventos (debug)</h3>
                <pre className="log">{log.join('\n')}</pre>
            </section>
            </div>
        </div>
        {/* Scanlines: overlay de linhas escuras (multiply) fixado na
            viewport, DEPOIS do conteúdo pra multiplicar por cima dele.
            Fica dentro do #root (não num portal) de propósito: assim
            curva/pixela junto quando os filtros SVG estão ligados. */}
        {scanlines > 0 && (
            <div
                className="fx-scanlines"
                style={{ '--sl-op': (scanlines / 100) * 0.5, '--sl-periodo': `${scanlinePasso}px` }}
            />
        )}
        </>
    );
}
