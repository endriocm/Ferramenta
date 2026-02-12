import { useEffect, useState } from "react";
import { auth, googleProvider } from "./firebase";
import SignupWizard from "./SignupWizard";
import DesktopControls from "./components/DesktopControls";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  signInWithPopup,
} from "firebase/auth";

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const firebaseErrorMap = {
  "auth/invalid-email": "E-mail inválido.",
  "auth/user-not-found": "Não encontramos uma conta com esse e-mail.",
  "auth/wrong-password": "Senha incorreta.",
  "auth/too-many-requests": "Muitas tentativas. Tenta de novo em alguns minutos.",
  "auth/network-request-failed": "Sem conexão no momento. Verifica tua internet.",
  "auth/user-disabled": "Essa conta foi desativada. Fala com o suporte.",
  "auth/email-already-in-use": "Esse e-mail já está em uso.",
  "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
  "auth/invalid-credential": "E-mail ou senha inválidos.",
  "auth/missing-password": "Informe tua senha.",
};

const mapFirebaseError = (error, fallback = "Não foi possível entrar. Tenta novamente.") => {
  const code = error?.code;
  return firebaseErrorMap[code] || fallback;
};

const now = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
};

const logAuthEvent = (payload) => {
  if (!import.meta.env.DEV) return;
  console.log("[auth]", payload);
};

export default function Login() {
  const [email, setEmail] = useState(() => {
    try {
      return localStorage.getItem("pwr_last_email") || "";
    } catch {
      return "";
    }
  });
  const [senha, setSenha] = useState("");
  const [status, setStatus] = useState("idle");
  const [erro, setErro] = useState("");
  const [usuario, setUsuario] = useState(null);
  const [acao, setAcao] = useState("login");
  const [mostrarCadastro, setMostrarCadastro] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({ email: "", senha: "" });

  const isLoading = status === "loading";
  const isLoginLoading = isLoading && acao === "login";
  const isSignupLoading = isLoading && acao === "signup";

  useEffect(() => {
    // Escuta se alguém entrou/saiu (logado/deslogado)
    const unsub = onAuthStateChanged(auth, (u) => {
      setUsuario(u || null);
    });
    return () => unsub();
  }, []);

  const handleEmailChange = (event) => {
    setEmail(event.target.value);
    if (fieldErrors.email) {
      setFieldErrors((prev) => ({ ...prev, email: "" }));
    }
    if (erro) setErro("");
    if (status === "error") setStatus("idle");
  };

  const handleSenhaChange = (event) => {
    setSenha(event.target.value);
    if (fieldErrors.senha) {
      setFieldErrors((prev) => ({ ...prev, senha: "" }));
    }
    if (erro) setErro("");
    if (status === "error") setStatus("idle");
  };

  const validate = () => {
    const normalizedEmail = email.trim();
    const nextErrors = { email: "", senha: "" };
    let reason = "ok";

    if (!normalizedEmail) {
      nextErrors.email = "Informe teu e-mail.";
      reason = "email_empty";
    } else if (!emailRegex.test(normalizedEmail)) {
      nextErrors.email = "E-mail inválido.";
      reason = "email_invalid";
    }

    if (!senha) {
      nextErrors.senha = "Informe tua senha.";
      if (reason === "ok") {
        reason = "senha_empty";
      }
    }

    setFieldErrors(nextErrors);

    if (nextErrors.email || nextErrors.senha) {
      setErro("");
      setStatus("error");
      return { ok: false, reason, email: normalizedEmail };
    }

    if (email !== normalizedEmail) {
      setEmail(normalizedEmail);
    }

    return { ok: true, reason: "ok", email: normalizedEmail };
  };

  const handleAuth = async (mode) => {
    if (isLoading) return;

    const validation = validate();
    logAuthEvent({
      event: "login_attempt",
      action: mode,
      valid: validation.ok,
      reason: validation.reason,
    });

    if (!validation.ok) {
      logAuthEvent({ event: "login_result", action: mode, skipped: true });
      return;
    }

    setStatus("loading");
    setAcao(mode);
    setErro("");

    const startedAt = now();
    let capturedError = null;

    try {
      if (mode === "login") {
        await signInWithEmailAndPassword(auth, validation.email, senha);
      } else {
        await createUserWithEmailAndPassword(auth, validation.email, senha);
      }
      try {
        localStorage.setItem("pwr_last_email", validation.email);
      } catch {
        // ignore
      }
      setStatus("idle");
    } catch (err) {
      capturedError = err;
      const fallback =
        mode === "signup"
          ? "Não foi possível criar tua conta. Tenta novamente."
          : "Não foi possível entrar. Tenta novamente.";
      setErro(mapFirebaseError(err, fallback));
      setStatus("error");
    } finally {
      const elapsedMs = Math.round(now() - startedAt);
      logAuthEvent({
        event: "login_result",
        action: mode,
        ms: elapsedMs,
        code: capturedError?.code || null,
        success: !capturedError,
      });
    }
  };

  const entrarComGoogle = async () => {
    if (isLoading) return;
    setErro("");
    setStatus("loading");
    setAcao("login");
    try {
      await signInWithPopup(auth, googleProvider);
      setStatus("idle");
    } catch (err) {
      setErro(err?.message ? String(err.message) : "Não foi possível entrar com Google.");
      setStatus("error");
    }
  };

  const sair = async () => {
    if (isLoading) return;
    setErro("");
    setStatus("loading");
    try {
      await signOut(auth);
      setStatus("idle");
    } catch (err) {
      setErro(mapFirebaseError(err, "Não foi possível sair. Tenta novamente."));
      setStatus("error");
    }
  };

  const emailId = "login-email";
  const senhaId = "login-senha";
  const emailHelpId = "login-email-help";
  const senhaHelpId = "login-senha-help";
  const emailErrorId = "login-email-error";
  const senhaErrorId = "login-senha-error";

  const emailDescribedBy = fieldErrors.email ? `${emailHelpId} ${emailErrorId}` : emailHelpId;
  const senhaDescribedBy = fieldErrors.senha ? `${senhaHelpId} ${senhaErrorId}` : senhaHelpId;

  const brand = (
    <div className="login-brand-inline">
      <div className="brand">
        <span className="brand-mark">PWR</span>
        <span className="brand-name">Endrio</span>
      </div>
    </div>
  );

  if (usuario) {
    return (
      <main className="login-shell">
        <div className="login-surface">
          <div className="login-card" data-state={status}>
            {brand}
            <div className="login-card-header">
              <h2>Tu já estás logado</h2>
              <p className="muted">Conta atual: {usuario.email}</p>
            </div>
            <button className="btn btn-secondary login-button" onClick={sair} disabled={isLoading}>
              {isLoading ? "Saindo..." : "Sair"}
            </button>
            {erro ? (
              <div className="login-alert" role="alert" aria-live="polite">
                {erro}
              </div>
            ) : null}
          </div>
        </div>
      </main>
    );
  }

  if (mostrarCadastro) {
    return (
      <SignupWizard
        onCancel={() => setMostrarCadastro(false)}
        onDone={() => setMostrarCadastro(false)}
      />
    );
  }

  return (
    <main className="login-shell">
      <div className="login-surface">
        <div className="login-layout">
          <section className="login-hero">
            {brand}
            <DesktopControls />
          </section>
        <form
          className="login-card"
          onSubmit={(event) => {
            event.preventDefault();
            handleAuth("login");
          }}
          noValidate
          data-state={status}
          aria-busy={isLoading}
        >
          {brand}
          <div className="login-card-header">
            <h2>Entrar na conta</h2>
            <p className="muted">Usa teu e-mail para continuar.</p>
          </div>

          <div className="login-fields">
            <div className="login-field">
              <label className="login-label" htmlFor={emailId}>
                E-mail
              </label>
              <input
                id={emailId}
                name="email"
                className="login-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={handleEmailChange}
                placeholder="teuemail@exemplo.com"
                aria-invalid={fieldErrors.email ? "true" : "false"}
                aria-describedby={emailDescribedBy}
                disabled={isLoading}
              />
              <small id={emailHelpId} className="login-helper">
                Usa o e-mail cadastrado para acessar.
              </small>
              {fieldErrors.email ? (
                <span id={emailErrorId} className="login-field-error">
                  {fieldErrors.email}
                </span>
              ) : null}
            </div>

            <div className="login-field">
              <label className="login-label" htmlFor={senhaId}>
                Senha
              </label>
              <input
                id={senhaId}
                name="password"
                className="login-input"
                type="password"
                autoComplete="current-password"
                value={senha}
                onChange={handleSenhaChange}
                placeholder="Sua senha"
                aria-invalid={fieldErrors.senha ? "true" : "false"}
                aria-describedby={senhaDescribedBy}
                disabled={isLoading}
              />
              <small id={senhaHelpId} className="login-helper">
                A senha precisa ter pelo menos 6 caracteres.
              </small>
              {fieldErrors.senha ? (
                <span id={senhaErrorId} className="login-field-error">
                  {fieldErrors.senha}
                </span>
              ) : null}
            </div>
          </div>

          {erro ? (
            <div className="login-alert" role="alert" aria-live="polite">
              {erro}
            </div>
          ) : null}

          <div className="login-actions">
            <button className="btn btn-primary login-button" type="submit" disabled={isLoading}>
              {isLoginLoading ? <span className="login-spinner" aria-hidden="true" /> : null}
              {isLoginLoading ? "Entrando..." : "Entrar"}
            </button>
            <button
              className="btn btn-secondary login-button"
              type="button"
              disabled={isLoading}
              onClick={() => setMostrarCadastro(true)}
            >
              {isSignupLoading ? <span className="login-spinner" aria-hidden="true" /> : null}
              {isSignupLoading ? "Criando..." : "Criar conta"}
            </button>
          </div>
          <button
            className="btn btn-secondary login-button login-google"
            type="button"
            onClick={entrarComGoogle}
            disabled={isLoading}
          >
            <span className="login-google-mark" aria-hidden="true">
              <svg viewBox="0 0 18 18" focusable="false">
                <path fill="#4285F4" d="M17.64 9.2045c0-.638-.0573-1.2518-.1636-1.8409H9v3.4818h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2582h2.9082c1.7027-1.5673 2.6836-3.8745 2.6836-6.6155z" />
                <path fill="#34A853" d="M9 18c2.43 0 4.4673-.8055 5.9564-2.1791l-2.9082-2.2582c-.8055.54-1.8368.8591-3.0482.8591-2.3441 0-4.3282-1.5832-5.0364-3.7091H.9573v2.3327C2.4382 16.0909 5.4818 18 9 18z" />
                <path fill="#FBBC05" d="M3.9636 10.7127c-.18-.54-.2823-1.1168-.2823-1.7127s.1023-1.1727.2823-1.7127V4.9545H.9573C.3477 6.1691 0 7.5482 0 9s.3477 2.8309.9573 4.0455l3.0063-2.3328z" />
                <path fill="#EA4335" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.3459l2.5809-2.5809C13.4636.8918 11.4264 0 9 0 5.4818 0 2.4382 2.0909.9573 4.9545l3.0063 2.3328C4.6718 5.1627 6.6559 3.5795 9 3.5795z" />
              </svg>
            </span>
            Entrar com Google
          </button>

        </form>
        </div>
      </div>
    </main>
  );
}