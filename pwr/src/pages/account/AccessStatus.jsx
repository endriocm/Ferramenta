import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, createAnnualCheckoutLink, db } from "../../firebase";
import { getExpiryFromEntitlement, isEntitlementValid } from "../../lib/entitlement";

const formatDate = (date) => {
  if (!date) return "-";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date);
};

const AccessStatus = () => {
  const [user, setUser] = useState(() => auth.currentUser);
  const [entitlement, setEntitlement] = useState(null);
  const [loadingEntitlement, setLoadingEntitlement] = useState(true);
  const [entitlementError, setEntitlementError] = useState("");
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser || null);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) {
      setEntitlement(null);
      setLoadingEntitlement(false);
      return undefined;
    }

    setLoadingEntitlement(true);
    setEntitlementError("");

    const entitlementRef = doc(db, "entitlements", user.uid);
    const unsub = onSnapshot(
      entitlementRef,
      (snap) => {
        setEntitlement(snap.exists() ? snap.data() : null);
        setLoadingEntitlement(false);
      },
      () => {
        setEntitlement(null);
        setEntitlementError("Não foi possível carregar o acesso.");
        setLoadingEntitlement(false);
      }
    );

    return () => unsub();
  }, [user]);

  const expiryDate = useMemo(() => getExpiryFromEntitlement(entitlement), [entitlement]);

  const isValid = useMemo(() => isEntitlementValid(entitlement), [entitlement]);

  const daysRemaining = useMemo(() => {
    if (!expiryDate) return 0;
    const diffMs = expiryDate.getTime() - Date.now();
    return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
  }, [expiryDate]);

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

  const actionLabel = isValid
    ? "Renovar / Estender por +12 meses (R$ 12.000,00)"
    : "Comprar acesso anual (12x de R$ 1.000,00)";

  return (
    <div className="page">
      <div className="panel">
        <h2>Meu acesso</h2>

        {!user ? (
          <p className="muted">Faça login para visualizar o status do seu acesso.</p>
        ) : loadingEntitlement ? (
          <p className="muted">Carregando acesso...</p>
        ) : (
          <>
            {entitlement ? (
              <div className="login-fields" style={{ marginTop: 16 }}>
                <div className="login-field">
                  <label className="login-label">Status</label>
                  <div>{isValid ? "Ativo" : "Inativo/Expirado"}</div>
                </div>
                <div className="login-field">
                  <label className="login-label">Validade</label>
                  <div>{formatDate(expiryDate)}</div>
                </div>
                <div className="login-field">
                  <label className="login-label">Dias restantes</label>
                  <div>{daysRemaining}</div>
                </div>
              </div>
            ) : (
              <p className="muted">Nenhum acesso ativo.</p>
            )}
          </>
        )}

        {entitlementError ? (
          <div className="login-alert" role="alert" aria-live="polite">
            {entitlementError}
          </div>
        ) : null}

        <div className="login-actions single">
          <button className="btn btn-primary" type="button" onClick={handlePayAnnual} disabled={payLoading}>
            {payLoading ? "Abrindo checkout..." : actionLabel}
          </button>
        </div>

        {payError ? (
          <div className="login-alert" role="alert" aria-live="polite">
            {payError}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AccessStatus;
