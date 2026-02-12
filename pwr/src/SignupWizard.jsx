import { useState } from "react";
import { auth } from "./firebase";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  updateProfile,
} from "firebase/auth";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignupWizard({ onCancel, onDone }) {
  const [step, setStep] = useState(0);
  const [nome, setNome] = useState("");
  const [sobrenome, setSobrenome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [status, setStatus] = useState("idle");
  const [confirmado, setConfirmado] = useState(false);

  const isLoading = status === "loading";

  const stepLabels = ["Nome", "Sobrenome", "E-mail", "Senha", "Confirmar e-mail"];

  const brand = (
    <div className="login-brand-inline">
      <div className="brand">
        <span className="brand-mark">PWR</span>
        <span className="brand-name">Endrio</span>
      </div>
    </div>
  );

  const handleCancel = () => {
    if (typeof onCancel === "function") onCancel();
  };

  const handleBack = () => {
    if (isLoading || step === 0) return;
    setErro("");
    setConfirmado(false);
    setStep((prev) => Math.max(0, prev - 1));
  };

  const validarAtual = () => {
    const nomeTrim = nome.trim();
    const sobrenomeTrim = sobrenome.trim();
    const emailTrim = email.trim();

    if (step === 0 && !nomeTrim) {
      setErro("Informe seu nome.");
      return false;
    }

    if (step === 1 && !sobrenomeTrim) {
      setErro("Informe seu sobrenome.");
      return false;
    }

    if (step === 2) {
      if (!emailTrim) {
        setErro("Informe seu e-mail.");
        return false;
      }
      if (!emailRegex.test(emailTrim)) {
        setErro("E-mail inválido.");
        return false;
      }
    }

    if (step === 3 && !senha) {
      setErro("Informe sua senha.");
      return false;
    }

    if (step === 2 && email !== emailTrim) {
      setEmail(emailTrim);
    }

    return true;
  };

  const criarConta = async () => {
    if (isLoading) return;
    setErro("");
    setStatus("loading");

    const nomeCompleto = `${nome} ${sobrenome}`.trim();
    const emailTrim = email.trim();

    try {
      await createUserWithEmailAndPassword(auth, emailTrim, senha);
      if (auth.currentUser) {
        if (nomeCompleto) {
          await updateProfile(auth.currentUser, { displayName: nomeCompleto });
        }
        await sendEmailVerification(auth.currentUser);
      }
      setStep(4);
    } catch (err) {
      setErro(err?.message ? String(err.message) : "Não foi possível criar sua conta.");
    } finally {
      setStatus("idle");
    }
  };

  const confirmarEmail = async () => {
    if (isLoading) return;
    setErro("");
    setConfirmado(false);
    setStatus("loading");

    try {
      if (!auth.currentUser) {
        setErro("Nenhum usuário logado.");
        return;
      }
      await auth.currentUser.reload();
      if (auth.currentUser.emailVerified) {
        setConfirmado(true);
        if (typeof onDone === "function") onDone();
      } else {
        setErro("Ainda não confirmou");
      }
    } catch (err) {
      setErro(err?.message ? String(err.message) : "Não foi possível verificar seu e-mail.");
    } finally {
      setStatus("idle");
    }
  };

  const handleNext = async () => {
    if (isLoading) return;
    setErro("");

    if (!validarAtual()) return;

    if (step < 3) {
      setStep((prev) => prev + 1);
      return;
    }

    if (step === 3) {
      await criarConta();
      return;
    }

    if (step === 4) {
      await confirmarEmail();
    }
  };

  const renderField = () => {
    if (step === 0) {
      return (
        <div className="login-field">
          <label className="login-label" htmlFor="signup-nome">
            Nome
          </label>
          <input
            id="signup-nome"
            className="login-input"
            type="text"
            value={nome}
            onChange={(event) => {
              setNome(event.target.value);
              if (erro) setErro("");
            }}
            placeholder="Seu nome"
            disabled={isLoading}
          />
        </div>
      );
    }

    if (step === 1) {
      return (
        <div className="login-field">
          <label className="login-label" htmlFor="signup-sobrenome">
            Sobrenome
          </label>
          <input
            id="signup-sobrenome"
            className="login-input"
            type="text"
            value={sobrenome}
            onChange={(event) => {
              setSobrenome(event.target.value);
              if (erro) setErro("");
            }}
            placeholder="Seu sobrenome"
            disabled={isLoading}
          />
        </div>
      );
    }

    if (step === 2) {
      return (
        <div className="login-field">
          <label className="login-label" htmlFor="signup-email">
            E-mail
          </label>
          <input
            id="signup-email"
            className="login-input"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (erro) setErro("");
            }}
            placeholder="teuemail@exemplo.com"
            disabled={isLoading}
          />
        </div>
      );
    }

    if (step === 3) {
      return (
        <div className="login-field">
          <label className="login-label" htmlFor="signup-senha">
            Senha
          </label>
          <input
            id="signup-senha"
            className="login-input"
            type="password"
            autoComplete="new-password"
            value={senha}
            onChange={(event) => {
              setSenha(event.target.value);
              if (erro) setErro("");
            }}
            placeholder="Crie uma senha"
            disabled={isLoading}
          />
          <small className="login-helper">A senha precisa ter pelo menos 6 caracteres.</small>
        </div>
      );
    }

    return (
      <div className="login-field">
        <p className="muted">
          Enviamos um e-mail de confirmação. Abra seu e-mail e clique no link.
        </p>
        {confirmado ? (
          <div
            className="login-alert"
            style={{
              borderColor: "rgba(40, 242, 230, 0.45)",
              background: "rgba(40, 242, 230, 0.14)",
              color: "#bafef5",
            }}
          >
            Confirmado!
          </div>
        ) : null}
      </div>
    );
  };

  const primaryLabel = step < 3 ? "Próximo" : step === 3 ? "Criar conta" : "Já confirmei";

  return (
    <main className="login-shell">
      <div className="login-surface">
        <div className="login-card" data-state={status} aria-busy={isLoading}>
          {brand}
          <div className="login-card-header">
            <h2>Criar conta</h2>
            <p className="muted">
              Etapa {step + 1} de {stepLabels.length}: {stepLabels[step]}
            </p>
          </div>

          <div className="login-fields">{renderField()}</div>

          {erro ? (
            <div className="login-alert" role="alert" aria-live="polite">
              {erro}
            </div>
          ) : null}

          <div className={`login-actions${step === 0 ? " single" : ""}`}>
            {step > 0 ? (
              <button
                className="btn btn-secondary login-button"
                type="button"
                onClick={handleBack}
                disabled={isLoading}
              >
                Voltar
              </button>
            ) : null}
            <button
              className="btn btn-primary login-button"
              type="button"
              onClick={handleNext}
              disabled={isLoading}
            >
              {primaryLabel}
            </button>
          </div>

          <button
            className="btn btn-secondary login-button"
            type="button"
            onClick={handleCancel}
            disabled={isLoading}
          >
            Cancelar
          </button>
        </div>
      </div>
    </main>
  );
}
