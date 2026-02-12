import { useEffect, useState } from "react";
import { auth, createAnnualCheckoutLink, db } from "./firebase";
import { doc, getDoc, runTransaction, serverTimestamp } from "firebase/firestore";
import { useHashRoute } from "./hooks/useHashRoute";
import { getExpiryFromEntitlement, isEntitlementValid } from "./lib/entitlement";

const formatDate = (date) => {
  if (!date) return "";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date);
};

export default function AccessGate({ onAccessGranted, children }) {
  const { path } = useHashRoute("/");
  const isBillingRoute = path.startsWith("/billing/");
  const [keyId, setKeyId] = useState("");
  const [erro, setErro] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState("");
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const [refreshError, setRefreshError] = useState("");

  useEffect(() => {
    if (isBillingRoute) return;
    let active = true;

    const checkAccess = async () => {
      const uid = auth.currentUser?.uid;
      if (!uid) {
        if (active) setErro("Usuário não autenticado.");
        return;
      }

      if (active) {
        setLoading(true);
        setErro("");
        setStatus("Verificando acesso...");
      }

      try {
        const adminSnap = await getDoc(doc(db, "users", uid));
        if (adminSnap.exists() && adminSnap.data()?.isAdmin === true) {
          if (active) {
            setStatus("Acesso liberado.");
            if (typeof onAccessGranted === "function") onAccessGranted();
          }
          return;
        }

        const entitlementSnap = await getDoc(doc(db, "entitlements", uid));
        if (entitlementSnap.exists()) {
          const data = entitlementSnap.data() || {};
          const expiryDate = getExpiryFromEntitlement(data);
          if (isEntitlementValid(data)) {
            if (active) {
              setStatus(`Acesso válido até ${formatDate(expiryDate)}`);
              if (typeof onAccessGranted === "function") onAccessGranted();
            }
            return;
          }
          if (active) setErro("Acesso expirou, use uma nova chave");
        }
      } catch (err) {
        if (active) {
          setErro(err?.message ? String(err.message) : "Não foi possível verificar o acesso.");
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    checkAccess();

    return () => {
      active = false;
    };
  }, [onAccessGranted, isBillingRoute]);

  const activateKey = async () => {
    if (loading) return;
    const trimmedKey = keyId.trim();
    if (!trimmedKey) {
      setErro("Digite sua chave.");
      return;
    }

    setLoading(true);
    setErro("");
    setStatus("");

    try {
      const uid = auth.currentUser?.uid;
      if (!uid) {
        setErro("Usuário não autenticado.");
        return;
      }

      const keyRef = doc(db, "licenseKeys", trimmedKey);
      const snap = await getDoc(keyRef);
      const data = snap.data();
      const status = String(data?.status || "").toLowerCase();
      const usedBy = String(data?.usedByUid || "");

      if (!snap.exists()) {
        setErro("Chave não encontrada.");
        return;
      }
      if (status !== "new" || usedBy !== "") {
        setErro("Chave já usada.");
        return;
      }

      const durationDays = Number(data?.durationDays);
      if (!Number.isFinite(durationDays) || durationDays <= 0) {
        setErro("Chave inválida.");
        return;
      }

      await runTransaction(db, async (transaction) => {
        const entitlementRef = doc(db, "entitlements", uid);
        transaction.update(keyRef, {
          status: "used",
          usedByUid: uid,
          usedAt: serverTimestamp(),
        });
        transaction.set(
          entitlementRef,
          {
            sourceKeyId: trimmedKey,
            activatedAt: serverTimestamp(),
            durationDays,
          },
          { merge: true }
        );
      });

      setStatus("Acesso liberado");
      if (typeof onAccessGranted === "function") onAccessGranted();
    } catch (err) {
      if (err?.code === "permission-denied") {
        setErro("Permissão negada.");
      } else {
        setErro(err?.message ? String(err.message) : "Falha ao ativar chave.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePayAnnual = async () => {
    if (payLoading) return;
    setPayLoading(true);
    setPayError("");

    try {
      const result = await createAnnualCheckoutLink({});
      const url = result?.data?.url;

      if (!url) {
        throw new Error("URL de checkout não retornou.");
      }

      const opened =
        typeof window !== "undefined" &&
        window.pwr &&
        typeof window.pwr.openExternal === "function"
          ? await window.pwr.openExternal(url)
          : (window.open(url, "_blank", "noopener,noreferrer"), true);

      if (!opened) {
        throw new Error("Não foi possível abrir o checkout.");
      }
    } catch (err) {
      const msg = err?.message || "";
      setPayError(msg.includes("autenticado") ? msg : "Não consegui abrir o checkout. Tenta de novo em alguns segundos.");
    } finally {
      setPayLoading(false);
    }
  };

  const handleRefreshAccess = () => {
    window.location.reload();
  };

  const handleBackToLogin = () => {
    window.location.hash = "#/login";
  };

  if (isBillingRoute) {
    return <>{children}</>;
  }

  return (
    <main className="login-shell">
      <div className="login-surface">
        <div className="login-card" aria-busy={loading}>
          <div className="login-card-header">
            <h2>Acesso necessário</h2>
            <p className="muted">Digite sua chave</p>
          </div>

          <div className="login-fields">
            <div className="login-field">
              <label className="login-label" htmlFor="access-key">
                Chave
              </label>
              <input
                id="access-key"
                className="login-input"
                type="text"
                value={keyId}
                onChange={(event) => {
                  setKeyId(event.target.value);
                  if (erro) setErro("");
                }}
                placeholder="Cole sua chave"
                disabled={loading}
              />
            </div>
          </div>

          {status ? (
            <div className="login-helper" role="status" aria-live="polite">
              {status}
            </div>
          ) : null}

          {erro ? (
            <div className="login-alert" role="alert" aria-live="polite">
              {erro}
            </div>
          ) : null}

          <div className="login-actions single">
            <button className="btn btn-primary login-button" type="button" onClick={activateKey} disabled={loading}>
              Ativar chave
            </button>
          </div>

          <div className="login-actions single">
            <button
              className="btn btn-secondary login-button"
              type="button"
              onClick={handlePayAnnual}
              disabled={payLoading}
            >
              {payLoading ? "Abrindo checkout..." : "Pagar anual (1x ou 12x)"}
            </button>
          </div>

          {payError ? (
            <div className="login-alert" role="alert" aria-live="polite">
              {payError}
            </div>
          ) : null}

          <div className="login-actions single">
            <button
              className="btn btn-secondary login-button"
              type="button"
              onClick={handleRefreshAccess}
              disabled={checkingAccess}
            >
              Recarregar
            </button>
          </div>

          {lastCheckedAt ? (
            <div className="login-helper muted">
              Última checagem: {new Date(lastCheckedAt).toLocaleTimeString()}
            </div>
          ) : null}

          {refreshError ? (
            <div className="login-alert" role="alert" aria-live="polite">
              {refreshError}
            </div>
          ) : null}

          <div className="login-actions single">
            <button className="btn btn-ghost login-button" type="button" onClick={handleBackToLogin}>
              Voltar ao login
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
