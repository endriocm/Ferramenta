import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from '../../firebase'
import { isEntitlementValid } from '../../lib/entitlement'

const BillingSuccess = () => {
  const [user, setUser] = useState(() => auth.currentUser)
  const [timeoutReached, setTimeoutReached] = useState(false)
  const [error, setError] = useState('')
  const statusMessage = 'Pagamento aprovado. Confirmando liberacao...'

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser || null)
      setTimeoutReached(false)
      setError('')
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!user) return undefined

    const timeout = setTimeout(() => setTimeoutReached(true), 60000)
    const entitlementRef = doc(db, 'entitlements', user.uid)
    const unsub = onSnapshot(
      entitlementRef,
      (snap) => {
        const data = snap.exists() ? snap.data() : null
        if (data && isEntitlementValid(data)) {
          window.location.hash = '#/'
        }
      },
      () => {
        setError('Nao foi possivel confirmar a liberacao.')
      },
    )

    return () => {
      clearTimeout(timeout)
      unsub()
    }
  }, [user])

  return (
    <div className="page">
      <div className="panel">
        <h2>Pagamento aprovado</h2>
        {!user ? (
          <p className="muted">Faca login para validar a liberacao.</p>
        ) : (
          <>
            <p className="muted">{statusMessage}</p>
            {error ? (
              <p className="login-alert" role="alert" aria-live="polite">
                {error}
              </p>
            ) : null}
            {timeoutReached ? (
              <div className="login-actions single">
                <p className="muted">
                  Se ja pagou e ainda nao liberou, clique em Recarregar.
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
  )
}

export default BillingSuccess
