import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { hydrateLocalStorage } from './services/nativeStorage'
import App from './App.jsx'


const bootstrap = async () => {
  if (typeof window !== 'undefined' && window.electronAPI?.storage) {
    const keys = [
      'pwr.receita.bovespa',
      'pwr.receita.bmf',
      'pwr.receita.estruturadas',
      'pwr.receita.manual',
      'pwr.market.cache',
    ]
    const data = await hydrateLocalStorage(keys)
    Object.entries(data).forEach(([key, value]) => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // noop
      }
    })
  }

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

bootstrap()
