const NotFound = () => {
  return (
    <div className="page empty-page">
      <div className="empty-state">
        <h2>Rota nao encontrada</h2>
        <p className="muted">Escolha uma area no menu para continuar.</p>
        <a className="btn btn-primary" href="#/">Voltar ao dashboard</a>
      </div>
    </div>
  )
}

export default NotFound
