const PORT = process.env.PORT || 4170

let runtimeModule = null

const loadRuntimeModule = () => {
  if (!runtimeModule) {
    runtimeModule = require('./runtimeApp')
  }
  return runtimeModule
}

const getRuntimeApp = () => {
  const runtime = loadRuntimeModule()
  if (!runtime?.app) {
    throw new Error('runtime-app-unavailable')
  }
  return runtime.app
}

const app = new Proxy({}, {
  get(_target, prop) {
    const runtimeApp = getRuntimeApp()
    const value = runtimeApp[prop]
    if (typeof value === 'function') return value.bind(runtimeApp)
    return value
  },
})

if (require.main === module) {
  getRuntimeApp().listen(PORT, () => {
    console.log(`API rodando em http://localhost:${PORT}`)
  })
}

module.exports = { app, getRuntimeApp }
