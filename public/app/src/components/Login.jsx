import { useState } from 'react';
import { chamar } from '../socket.js';

// Tela 1: entrar numa conta existente ou cadastrar uma nova. Os dois eventos
// devolvem o mesmo formato de ack ({ ok, nome, token }) — cadastrar já
// autentica, não precisa de um "entrar" separado depois.
export default function Login({ onAutenticado }) {
    const [nome, setNome] = useState('');
    const [senha, setSenha] = useState('');
    const [carregando, setCarregando] = useState(false);
    const [erro, setErro] = useState(null);

    async function enviar(evento, tipoDeAcao) {
        evento.preventDefault();
        setErro(null);
        setCarregando(true);
        try {
            const resposta = await chamar(tipoDeAcao, { nome, senha });
            onAutenticado({ nome: resposta.nome, token: resposta.token });
        } catch (erroDaChamada) {
            setErro(erroDaChamada.message);
        } finally {
            setCarregando(false);
        }
    }

    return (
        <form className="cartao">
            <h1>Contra ZAP</h1>
            <label>
                Nome
                <input value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
            </label>
            <label>
                Senha
                <input value={senha} onChange={(e) => setSenha(e.target.value)} type="password" />
            </label>
            <div className="botoes">
                <button onClick={(e) => enviar(e, 'entrar')} disabled={carregando}>
                    Entrar
                </button>
                <button onClick={(e) => enviar(e, 'cadastrar')} disabled={carregando} className="secundario">
                    Cadastrar
                </button>
            </div>
            {erro && <p className="erro">{erro}</p>}
        </form>
    );
}
