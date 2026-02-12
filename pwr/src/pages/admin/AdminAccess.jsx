import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "../../firebase";

const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const AdminAccess = () => {
  const [user, setUser] = useState(() => auth.currentUser);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminLoading, setAdminLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("suporte");
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState("");
  const [reprocessLoadingId, setReprocessLoadingId] = useState("");
  const [reprocessMsg, setReprocessMsg] = useState("");
  const [reprocessError, setReprocessError] = useState("");
  const [accessData, setAccessData] = useState(null);
  const [resolvedUid, setResolvedUid] = useState("");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser || null);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user?.uid) {
      setIsAdmin(false);
      setAdminLoading(false);
      return undefined;
    }

    setAdminLoading(true);
    const userRef = doc(db, "users", user.uid);
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        setIsAdmin(snap.exists() && snap.data()?.isAdmin === true);
        setAdminLoading(false);
      },
      () => {
        setIsAdmin(false);
        setAdminLoading(false);
      }
    );

    return () => unsub();
  }, [user?.uid]);

  const refreshAccess = async (uid) => {
    const fn = httpsCallable(functions, "adminGetUserAccess");
    const res = await fn({ uid });
    setAccessData(res.data || null);
  };

  const handleSearch = async () => {
    const input = query.trim();
    if (!input) {
      setError("Digite um e-mail ou UID.");
      return;
    }

    setLoading(true);
    setError("");
    setActionError("");
    setActionStatus("");
    setReprocessError("");
    setReprocessMsg("");
    setAccessData(null);

    try {
      let uid = input;
      if (input.includes("@")) {
        const fn = httpsCallable(functions, "adminFindUserByEmail");
        const res = await fn({ email: input });
        uid = res.data?.uid || "";
      }

      if (!uid) {
        throw new Error("Usuário não encontrado.");
      }

      setResolvedUid(uid);
      await refreshAccess(uid);
    } catch (err) {
      if (err?.code === "permission-denied") {
        setError("Sem permissão.");
      } else {
        setError(err?.message ? String(err.message) : "Falha ao buscar usuário.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleReprocess = async (paymentId) => {
    if (!paymentId) return;
    setReprocessLoadingId(paymentId);
    setReprocessError("");
    setReprocessMsg("");

    try {
      const fn = httpsCallable(functions, "adminReprocessPayment");
      const res = await fn({ paymentId });
      const data = res.data || {};
      const actionTaken = data.actionTaken || "noop";
      const expiryLabel = data.newExpiresAt ? ` | expira em ${formatDateTime(data.newExpiresAt)}` : "";
      setReprocessMsg(`Reprocessado: ${actionTaken}${expiryLabel}`);
      if (resolvedUid) {
        await refreshAccess(resolvedUid);
      }
    } catch (err) {
      setReprocessError(err?.message ? String(err.message) : "Falha ao reprocessar pagamento.");
    } finally {
      setReprocessLoadingId("");
    }
  };

  const handleGrant = async (days) => {
    if (!resolvedUid) return;
    setActionLoading(`grant-${days}`);
    setActionError("");
    setActionStatus("");

    try {
      const fn = httpsCallable(functions, "adminGrantAccess");
      await fn({ uid: resolvedUid, days, reason });
      await refreshAccess(resolvedUid);
      setActionStatus(`Acesso estendido por ${days} dias.`);
    } catch (err) {
      setActionError(err?.message ? String(err.message) : "Falha ao conceder acesso.");
    } finally {
      setActionLoading("");
    }
  };

  const handleRevoke = async () => {
    if (!resolvedUid) return;
    setActionLoading("revoke");
    setActionError("");
    setActionStatus("");

    try {
      const fn = httpsCallable(functions, "adminRevokeAccess");
      await fn({ uid: resolvedUid, reason });
      await refreshAccess(resolvedUid);
      setActionStatus("Acesso revogado.");
    } catch (err) {
      setActionError(err?.message ? String(err.message) : "Falha ao revogar acesso.");
    } finally {
      setActionLoading("");
    }
  };

  const computed = accessData?.computed;
  const expiryDate = useMemo(() => {
    if (!computed?.expiresAt) return null;
    const date = new Date(computed.expiresAt);
    return Number.isNaN(date.getTime()) ? null : date;
  }, [computed?.expiresAt]);

  const daysRemaining = useMemo(() => {
    if (!expiryDate) return 0;
    const diffMs = expiryDate.getTime() - Date.now();
    return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
  }, [expiryDate]);

  if (!user) {
    return (
      <div className="page">
        <div className="panel">
          <h2>Admin - Acesso</h2>
          <p className="muted">Faça login para continuar.</p>
        </div>
      </div>
    );
  }

  if (adminLoading) {
    return (
      <div className="page">
        <div className="panel">
          <h2>Admin - Acesso</h2>
          <p className="muted">Verificando permissões...</p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="panel">
          <h2>Admin - Acesso</h2>
          <p className="muted">Sem permissão.</p>
        </div>
      </div>
    );
  }

  const entitlement = accessData?.entitlementDoc || null;
  const payments = accessData?.payments || [];
  const userDoc = accessData?.userDoc || {};

  return (
    <div className="page">
      <div className="panel">
        <h2>Admin - Acesso</h2>
        <div className="login-fields">
          <div className="login-field">
            <label className="login-label" htmlFor="admin-lookup">
              Email ou UID
            </label>
            <input
              id="admin-lookup"
              className="login-input"
              type="text"
              placeholder="email@dominio.com ou UID"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={loading}
            />
          </div>
          <div className="login-field">
            <label className="login-label" htmlFor="admin-reason">
              Motivo
            </label>
            <input
              id="admin-reason"
              className="login-input"
              type="text"
              placeholder="suporte"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={loading || actionLoading}
            />
          </div>
        </div>

        <div className="login-actions single">
          <button className="btn btn-primary" type="button" onClick={handleSearch} disabled={loading}>
            {loading ? "Buscando..." : "Buscar"}
          </button>
        </div>

        {error ? (
          <div className="login-alert" role="alert" aria-live="polite">
            {error}
          </div>
        ) : null}

        {accessData ? (
          <>
            <div className="panel" style={{ marginTop: 24 }}>
              <h3>Usuário</h3>
              <p className="muted">UID: {userDoc.uid || resolvedUid}</p>
              <p className="muted">Email: {userDoc.email || "-"}</p>
              <p className="muted">Nome: {userDoc.displayName || "-"}</p>
            </div>

            <div className="panel" style={{ marginTop: 24 }}>
              <h3>Entitlement</h3>
              <div className="login-fields">
                <div className="login-field">
                  <label className="login-label">Status</label>
                  <div>{computed?.isValid ? "Ativo" : "Inativo/Expirado"}</div>
                </div>
                <div className="login-field">
                  <label className="login-label">Validade</label>
                  <div>{expiryDate ? formatDateTime(expiryDate) : "-"}</div>
                </div>
                <div className="login-field">
                  <label className="login-label">Dias restantes</label>
                  <div>{daysRemaining}</div>
                </div>
                <div className="login-field">
                  <label className="login-label">Provider</label>
                  <div>{entitlement?.provider || "-"}</div>
                </div>
                <div className="login-field">
                  <label className="login-label">Último pagamento</label>
                  <div>{entitlement?.lastPaymentId || entitlement?.paymentId || "-"}</div>
                </div>
              </div>
            </div>

            <div className="login-actions single" style={{ gap: 12, flexWrap: "wrap" }}>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => handleGrant(30)}
                disabled={actionLoading}
              >
                {actionLoading === "grant-30" ? "Aplicando..." : "Conceder +30 dias"}
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => handleGrant(365)}
                disabled={actionLoading}
              >
                {actionLoading === "grant-365" ? "Aplicando..." : "Conceder +365 dias"}
              </button>
              <button
                className="btn btn-danger"
                type="button"
                onClick={handleRevoke}
                disabled={actionLoading}
              >
                {actionLoading === "revoke" ? "Revogando..." : "Revogar"}
              </button>
            </div>

            {actionStatus ? (
              <div className="login-helper" role="status" aria-live="polite">
                {actionStatus}
              </div>
            ) : null}
            {actionError ? (
              <div className="login-alert" role="alert" aria-live="polite">
                {actionError}
              </div>
            ) : null}

            <div className="panel" style={{ marginTop: 24 }}>
              <h3>Pagamentos (últimos 20)</h3>
              {payments.length ? (
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>PaymentId</th>
                        <th>Status</th>
                        <th>Valor</th>
                        <th>Aprovado em</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((payment) => (
                        <tr key={payment.paymentId}>
                          <td>{payment.paymentId}</td>
                          <td>{payment.status || "-"}</td>
                          <td>
                            {payment.transaction_amount != null ? `${payment.transaction_amount} ${payment.currency_id || ""}` : "-"}
                          </td>
                          <td>{payment.date_approved ? formatDateTime(payment.date_approved) : "-"}</td>
                          <td>
                            <button
                              className="btn btn-secondary btn-compact"
                              type="button"
                              onClick={() => handleReprocess(payment.paymentId)}
                              disabled={reprocessLoadingId === payment.paymentId || actionLoading || loading}
                            >
                              {reprocessLoadingId === payment.paymentId ? "Reprocessando..." : "Reprocessar"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="muted">Nenhum pagamento encontrado.</p>
              )}
            </div>
            {reprocessMsg ? (
              <div className="login-helper" role="status" aria-live="polite">
                {reprocessMsg}
              </div>
            ) : null}
            {reprocessError ? (
              <div className="login-alert" role="alert" aria-live="polite">
                {reprocessError}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
};

export default AdminAccess;
