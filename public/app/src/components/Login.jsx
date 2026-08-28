import { useState } from 'react';
import { chamar } from '../socket.js';

const ETAPA = {
    NOME: 'nome',
    CONFIRMAR_SENHA: 'confirmar-senha',
    OFERECER_CADASTRO: 'oferecer-cadastro',
    NOVA_SENHA: 'nova-senha',
};

// Fluxo em etapas, ao estilo Pokémon Showdown: primeiro só o nome decide o
// que vem a seguir. Nome já registrado pede senha pra confirmar identidade
// (entrar); nome novo pergunta se quer registrar (cadastrar) ou seguir sem
// conta como convidado (entrarComoConvidado — pseudo-guest só em memória,
// nunca grava no banco). Não existe botão de "guest" solto em lugar nenhum:
// é sempre consequência de responder "não" à oferta de cadastro.
export default function Login({ onAutenticado }) {
    const [etapa, setEtapa] = useState(ETAPA.NOME);
    const [nome, setNome] = useState('');
    const [senha, setSenha] = useState('');
    const [carregando, setCarregando] = useState(false);
    const [erro, setErro] = useState(null);

    function voltar() {
        setEtapa(ETAPA.NOME);
        setSenha('');
        setErro(null);
    }

    async function continuar(evento) {
        evento.preventDefault();
        if (!nome.trim()) return;
        setErro(null);
        setCarregando(true);
        try {
            const resposta = await chamar('verificarNome', { nome });
            setEtapa(resposta.existe ? ETAPA.CONFIRMAR_SENHA : ETAPA.OFERECER_CADASTRO);
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        } finally {
            setCarregando(false);
        }
    }

    async function autenticar(evento, tipoDeAcao, payload) {
        evento?.preventDefault();
        setErro(null);
        setCarregando(true);
        try {
            const resposta = await chamar(tipoDeAcao, payload ?? { nome, senha });
            onAutenticado({ nome: resposta.nome, token: resposta.token });
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        } finally {
            setCarregando(false);
        }
    }

    if (etapa === ETAPA.NOME) {
        return (
            <form className="cartao" onSubmit={continuar}>
                <h1>Contra ZAP</h1>
                <label>
                    Nome
                    <input value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
                </label>
                <div className="botoes">
                    <button type="submit" disabled={carregando || !nome.trim()}>
                        Continuar
                    </button>
                </div>
                {erro && <p className="erro">{erro}</p>}
            </form>
        );
    }

    if (etapa === ETAPA.CONFIRMAR_SENHA) {
        return (
            <form className="cartao" onSubmit={(e) => autenticar(e, 'entrar')}>
                <h1>Contra ZAP</h1>
                <p>Usuário registrado. Confirme sua identidade, {nome}.</p>
                <label>
                    Senha
                    <input value={senha} onChange={(e) => setSenha(e.target.value)} type="password" autoFocus />
                </label>
                <div className="botoes">
                    <button type="submit" disabled={carregando}>Entrar</button>
                    <button type="button" onClick={voltar} disabled={carregando} className="secundario">Voltar</button>
                </div>
                {erro && <p className="erro">{erro}</p>}
            </form>
        );
    }

    if (etapa === ETAPA.OFERECER_CADASTRO) {
        return (
            <div className="cartao">
                <h1>Contra ZAP</h1>
                <p>"{nome}" ainda não tem conta. Quer registrar esse nome?</p>
                <div className="botoes">
                    <button type="button" onClick={() => setEtapa(ETAPA.NOVA_SENHA)} disabled={carregando}>
                        Sim, registrar
                    </button>
                    <button
                        type="button"
                        onClick={() => autenticar(null, 'entrarComoConvidado', { nome })}
                        disabled={carregando}
                        className="secundario"
                    >
                        Não, só jogar
                    </button>
                </div>
                <div className="botoes">
                    <button type="button" onClick={voltar} disabled={carregando} className="secundario">Voltar</button>
                </div>
                {erro && <p className="erro">{erro}</p>}
            </div>
        );
    }

    // ETAPA.NOVA_SENHA
    return (
        <form className="cartao" onSubmit={(e) => autenticar(e, 'cadastrar')}>
            <h1>Contra ZAP</h1>
            <p>Escolha uma senha pra registrar "{nome}".</p>
            <label>
                Senha
                <input value={senha} onChange={(e) => setSenha(e.target.value)} type="password" autoFocus />
            </label>
            <div className="botoes">
                <button type="submit" disabled={carregando}>Cadastrar</button>
                <button type="button" onClick={voltar} disabled={carregando} className="secundario">Voltar</button>
            </div>
            {erro && <p className="erro">{erro}</p>}
        </form>
    );
}
