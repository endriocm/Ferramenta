import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icons'
import MultiSelect from './MultiSelect'
import { quickActions } from '../data/navigation'
import { useGlobalFilters } from '../contexts/GlobalFilterContext'
import { auth, db } from '../firebase'
import { EmailAuthProvider, linkWithCredential, signOut } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { getCurrentUserKey } from '../services/currentUser'
import { clearTags } from '../services/tags'
import { clearLastImported } from '../services/vencimentoCache'
import { clearLink } from '../services/vencimentoLink'

const Topbar = ({ title, breadcrumbs, onToggleSidebar, currentPath, user }) => {
  const actions = quickActions[currentPath] || []
  const {
    selectedBroker,
    setSelectedBroker,
    brokerOptions,
    selectedAssessor,
    setSelectedAssessor,
    assessorOptions,
    apuracaoMonths,
    setApuracaoMonths,
    apuracaoOptions,
    setClientCodeFilter,
  } = useGlobalFilters()

  const [menuOpen, setMenuOpen] = useState(false)
  const [logoutStatus, setLogoutStatus] = useState('idle')
  const [logoutError, setLogoutError] = useState('')
  const [senhaModalOpen, setSenhaModalOpen] = useState(false)
  const [novaSenha, setNovaSenha] = useState('')
  const [confirmarSenha, setConfirmarSenha] = useState('')
  const [senhaErro, setSenhaErro] = useState('')
  const [senhaStatus, setSenhaStatus] = useState('')
  const [salvandoSenha, setSalvandoSenha] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const lastMenuState = useRef(false)

  const currentUser = auth.currentUser || user
  const userEmail = currentUser?.email || ''
  const displayName = currentUser?.displayName || (userEmail ? userEmail.split('@')[0] : 'Usuario')
  const displaySub = userEmail || 'Conta ativa'
  const hasPasswordProvider = !!currentUser?.providerData?.some((provider) => provider?.providerId === 'password')
  const canCreatePassword = !!currentUser && !hasPasswordProvider

  const initials = useMemo(() => {
    const source = (displayName || userEmail || 'U').trim()
    if (!source) return 'U'
    const clean = source.includes('@') ? source.split('@')[0] : source
    const parts = clean.split(/\s+/).filter(Boolean)
    if (!parts.length) return 'U'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  }, [displayName, userEmail])

  const isLogoutLoading = logoutStatus === 'loading'
  const isSavingPassword = salvandoSenha

  const APURACAO_ALL = '__ALL__'
  const apuracaoValue = apuracaoMonths.all ? [APURACAO_ALL] : apuracaoMonths.months
  const apuracaoItems = [{ value: APURACAO_ALL, label: 'Todos' }, ...apuracaoOptions]
  const showApuracaoFilter = currentPath === '/' || currentPath === '/times' || currentPath === '/tags'

  const handleApuracaoChange = (values) => {
    const selected = Array.isArray(values) ? values : []
    if (!selected.length) {
      setApuracaoMonths({ all: true, months: [] })
      return
    }
    if (selected.includes(APURACAO_ALL)) {
      const monthsOnly = selected.filter((item) => item !== APURACAO_ALL)
      if (monthsOnly.length) {
        setApuracaoMonths({ all: false, months: monthsOnly })
        return
      }
      setApuracaoMonths({ all: true, months: [] })
      return
    }
    setApuracaoMonths({ all: false, months: selected })
  }

  const logAuthEvent = (payload) => {
    if (!import.meta.env.DEV) return
    console.log('[auth]', payload)
  }

  useEffect(() => {
    if (!currentUser?.uid) {
      setIsAdmin(false)
      return undefined
    }

    const userRef = doc(db, 'users', currentUser.uid)
    const unsub = onSnapshot(
      userRef,
      (snap) => {
        setIsAdmin(snap.exists() && snap.data()?.isAdmin === true)
      },
      () => {
        setIsAdmin(false)
      },
    )

    return () => unsub()
  }, [currentUser?.uid])

  const closeMenu = () => setMenuOpen(false)

  useEffect(() => {
    if (!menuOpen) return

    const handleOutside = (event) => {
      const target = event.target
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      closeMenu()
    }

    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
      }
    }

    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('touchstart', handleOutside)
    document.addEventListener('keydown', handleKey)

    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('touchstart', handleOutside)
      document.removeEventListener('keydown', handleKey)
    }
  }, [menuOpen])

  useEffect(() => {
    if (menuOpen) {
      setLogoutError('')
      setTimeout(() => {
        const firstItem = menuRef.current?.querySelector('[data-menu-item]')
        if (firstItem && typeof firstItem.focus === 'function') firstItem.focus()
      }, 0)
    }
  }, [menuOpen])

  useEffect(() => {
    if (lastMenuState.current && !menuOpen) {
      triggerRef.current?.focus()
    }
    lastMenuState.current = menuOpen
  }, [menuOpen])

  useEffect(() => {
    setMenuOpen(false)
  }, [currentPath])

  const resetLocalState = () => {
    setSelectedBroker([])
    setSelectedAssessor([])
    setClientCodeFilter([])
    setApuracaoMonths({ all: true, months: [] })
  }

  const clearUserCaches = async (userKey) => {
    if (!userKey || typeof window === 'undefined') return

    const prefixes = [
      'pwr.filters.',
      'pwr.vencimento.overrides.',
      'pwr.vencimento.cache.',
      'pwr.vencimento.link.',
      'pwr.vencimento.reportDate.',
    ]

    try {
      const keys = Object.keys(localStorage)
      keys.forEach((key) => {
        const shouldRemove = prefixes.some((prefix) => key.startsWith(prefix) && key.includes(userKey))
        if (shouldRemove) {
          localStorage.removeItem(key)
        }
      })
      localStorage.removeItem('pwr.filters.broadcast')
      localStorage.removeItem('pwr.vencimento.broadcast')
      localStorage.removeItem('pwr.userKey')
      localStorage.removeItem('pwr.user')
      localStorage.removeItem('pwr.currentUser')
    } catch {
      // noop
    }

    await clearTags(userKey)
    clearLastImported(userKey)
    await clearLink(userKey)
  }

  const handleLogout = async () => {
    if (isLogoutLoading) return

    logAuthEvent({ event: 'logout_click' })
    setLogoutError('')
    setLogoutStatus('loading')

    const userKey = getCurrentUserKey()

    try {
      await signOut(auth)
      resetLocalState()
      await clearUserCaches(userKey)
      logAuthEvent({ event: 'logout_success' })
      setLogoutStatus('idle')
      closeMenu()

      if (typeof window !== 'undefined') {
        const nextUrl = `${window.location.pathname}${window.location.search}#/`
        if (window.location.hash !== '#/') {
          window.location.replace(nextUrl)
        } else if (window.history?.replaceState) {
          window.history.replaceState(null, '', nextUrl)
        }
      }
    } catch (err) {
      logAuthEvent({ event: 'logout_error', code: err?.code || null })
      setLogoutStatus('error')
      setLogoutError('N�o foi poss�vel sair. Tenta de novo.')
    }
  }

  const handleOpenCriarSenha = () => {
    setSenhaModalOpen(true)
    setSenhaErro('')
    setSenhaStatus('')
    closeMenu()
  }

  const handleGoToAdmin = () => {
    closeMenu()
    if (typeof window !== 'undefined') {
      window.location.hash = '#/admin/access'
    }
  }

  const handleGoToAccess = () => {
    closeMenu()
    if (typeof window !== 'undefined') {
      window.location.hash = '#/account/access'
    }
  }

  const handleCloseCriarSenha = () => {
    if (isSavingPassword) return
    setSenhaModalOpen(false)
    setNovaSenha('')
    setConfirmarSenha('')
    setSenhaErro('')
    setSenhaStatus('')
  }

  const handleSalvarSenha = async () => {
    if (isSavingPassword) return
    setSenhaErro('')
    setSenhaStatus('')

    if (!novaSenha || novaSenha.length < 6) {
      setSenhaErro('A senha precisa ter pelo menos 6 caracteres.')
      return
    }

    if (novaSenha !== confirmarSenha) {
      setSenhaErro('As senhas não conferem.')
      return
    }

    const email = auth.currentUser?.email
    if (!auth.currentUser || !email) {
      setSenhaErro('Usuário não autenticado.')
      return
    }

    setSalvandoSenha(true)
    try {
      const cred = EmailAuthProvider.credential(email, novaSenha)
      await linkWithCredential(auth.currentUser, cred)
      await auth.currentUser.reload()
      setSenhaStatus('Senha criada. Agora você pode entrar com e-mail e senha.')
      setNovaSenha('')
      setConfirmarSenha('')
    } catch (err) {
      if (err?.code === 'auth/requires-recent-login') {
        setSenhaErro('Faça login de novo com Google e tente novamente.')
      } else if (
        err?.code === 'auth/email-already-in-use' ||
        err?.code === 'auth/credential-already-in-use'
      ) {
        setSenhaErro('Este e-mail já tem senha em outra conta.')
      } else {
        setSenhaErro(err?.message ? String(err.message) : 'Não foi possível criar a senha.')
      }
    } finally {
      setSalvandoSenha(false)
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="icon-btn ghost mobile-only" onClick={onToggleSidebar} aria-label="Abrir menu">
          <Icon name="menu" size={18} />
        </button>
        <div>
          <div className="breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`}>
                {crumb}
                {index < breadcrumbs.length - 1 ? <span className="crumb-sep">/</span> : null}
              </span>
            ))}
          </div>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="topbar-actions">
        {showApuracaoFilter ? (
          <MultiSelect
            value={apuracaoValue}
            options={apuracaoItems}
            onChange={handleApuracaoChange}
            placeholder="Mes de apuracao"
            className="topbar-filter"
            menuClassName="topbar-filter-menu"
            searchable={false}
          />
        ) : null}
        <MultiSelect
          value={selectedBroker}
          options={brokerOptions}
          onChange={setSelectedBroker}
          placeholder="Broker global"
          className="topbar-filter"
          menuClassName="topbar-filter-menu"
        />
        <MultiSelect
          value={selectedAssessor}
          options={assessorOptions}
          onChange={setSelectedAssessor}
          placeholder="Assessor global"
          className="topbar-filter"
          menuClassName="topbar-filter-menu"
        />
        {actions.length ? (
          <div className="action-group">
            {actions.map((action) => (
              <button key={action.label} className="btn btn-secondary" type="button">
                <Icon name={action.icon} size={16} />
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="account-menu">
          <button
            ref={triggerRef}
            type="button"
            className="user-chip account-trigger"
            id="account-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls="account-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="avatar">{initials}</span>
            <div>
              <div className="user-name">{displayName}</div>
              <div className="user-role">{displaySub}</div>
            </div>
            <span className="account-chevron" aria-hidden="true">
              <Icon name={menuOpen ? 'arrow-up' : 'arrow-down'} size={16} />
            </span>
          </button>
          {menuOpen ? (
            <div
              ref={menuRef}
              id="account-menu"
              className="account-dropdown"
              role="menu"
              aria-labelledby="account-trigger"
            >
              <div className="account-menu-header">
                <span className="avatar avatar-sm">{initials}</span>
                <div>
                  <div className="account-menu-name">{displayName}</div>
                  {userEmail ? <div className="account-menu-email">{userEmail}</div> : null}
                </div>
              </div>
              <div className="account-menu-divider" />
              {isAdmin ? (
                <button
                  className="account-menu-item"
                  type="button"
                  data-menu-item
                  onClick={handleGoToAdmin}
                >
                  Admin
                </button>
              ) : null}
              <button
                className="account-menu-item"
                type="button"
                data-menu-item
                onClick={handleGoToAccess}
              >
                Meu Acesso
              </button>
              {canCreatePassword ? (
                <button
                  className="account-menu-item"
                  type="button"
                  data-menu-item
                  onClick={handleOpenCriarSenha}
                >
                  Criar senha
                </button>
              ) : null}
              <button
                className="account-menu-item"
                type="button"
                data-menu-item
                disabled={isLogoutLoading}
                onClick={handleLogout}
              >
                {isLogoutLoading ? 'Saindo...' : 'Sair'}
              </button>
              {logoutError ? (
                <div className="account-menu-error" role="alert" aria-live="polite">
                  {logoutError}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {senhaModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="criar-senha-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(5, 7, 10, 0.64)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1200,
          }}
        >
          <div className="panel" style={{ width: 'min(420px, 92vw)' }}>
            <div className="panel-head">
              <div>
                <h3 id="criar-senha-title">Criar senha</h3>
                <p className="muted">Defina uma senha para entrar com e-mail.</p>
              </div>
            </div>
            <div className="login-fields">
              <div className="login-field">
                <label className="login-label" htmlFor="nova-senha-modal">
                  Nova senha
                </label>
                <input
                  id="nova-senha-modal"
                  className="login-input"
                  type="password"
                  autoComplete="new-password"
                  value={novaSenha}
                  onChange={(event) => setNovaSenha(event.target.value)}
                  disabled={isSavingPassword}
                />
              </div>
              <div className="login-field">
                <label className="login-label" htmlFor="confirmar-senha-modal">
                  Confirmar senha
                </label>
                <input
                  id="confirmar-senha-modal"
                  className="login-input"
                  type="password"
                  autoComplete="new-password"
                  value={confirmarSenha}
                  onChange={(event) => setConfirmarSenha(event.target.value)}
                  disabled={isSavingPassword}
                />
              </div>
            </div>
            {senhaStatus ? (
              <div className="login-helper" role="status" aria-live="polite">
                {senhaStatus}
              </div>
            ) : null}
            {senhaErro ? (
              <div className="login-alert" role="alert" aria-live="polite">
                {senhaErro}
              </div>
            ) : null}
            <div className="panel-actions">
              <button className="btn btn-primary" type="button" onClick={handleSalvarSenha} disabled={isSavingPassword}>
                {isSavingPassword ? 'Salvando...' : 'Salvar senha'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={handleCloseCriarSenha} disabled={isSavingPassword}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </header>
  )
}

export default Topbar
