import { useEffect, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth, db } from "../../firebase";
import { isEntitlementValid } from "../../lib/entitlement";

const BillingSuccess = () => {
  const [user, setUser] = useState(() => auth.currentUser);
  const [timeoutReached, setTimeoutReached] = useState(false);
  const [status, setStatus] = useState("Pagamento aprovado. Confirmando liberação...");
  const [error, setError] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser || null);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return undefined;

    setStatus("Pagamento aprovado. Confirmando liberação...");
    setError("");
    setTimeoutReached(false);

    const timeout = setTimeout(() => setTimeoutReached(true), 60000);
    const entitlementRef = doc(db, "entitlements", user.uid);
    const unsub = onSnapshot(
      entitlementRef,
      (snap) => {
        const data = snap.exists() ? snap.data() : null;
        if (data && isEntitlementValid(data)) {
          window.location.hash = "#/";
        }
      },
      () => {
        setError("Não foi possível confirmar a liberação.");
      }
    );

    return () => {
      clearTimeout(timeout);
      unsub();
    };
  }, [user]);

  return (
    <div className="page">
      <div className="panel">
        <h2>Pagamento aprovado</h2>
        {!user ? (
          <p className="muted">Faz login pra validar a liberação.</p>
        ) : (
          <>
            <p className="muted">{status}</p>
            {error ? (
              <p className="login-alert" role="alert" aria-live="polite">
                {error}
              </p>
            ) : null}
            {timeoutReached ? (
              <div className="login-actions single">
                <p className="muted">
                  Se já pagou e ainda não liberou, clica em Recarregar.
                </p>
                <button className="btn btn-secondary" type="button" onClick={() => window.location.reload()}>
                  Recarregar
                </button>
              </div>
            ) : null}
          </>
        )}
        <div className="login-actions single">
          <a className="btn btn-primary" href="#/">
            Ir para o app
          </a>
        </div>
      </div>
    </div>
  );
};

export default BillingSuccess;
