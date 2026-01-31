const Busboy = require('busboy')
const { parseBovespaReceitas } = require('../../lib/bovespaParser')

module.exports = (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.status(204).end()
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Metodo nao permitido.' } })
    return
  }

  res.setHeader('Access-Control-Allow-Origin', '*')

  const busboy = Busboy({
    headers: req.headers,
    limits: { fileSize: 25 * 1024 * 1024 },
  })

  let fileBuffer = null
  let fileName = null
  let fileTooLarge = false

  busboy.on('file', (_name, file, info) => {
    fileName = info?.filename || null
    const chunks = []
    file.on('data', (data) => {
      chunks.push(data)
    })
    file.on('limit', () => {
      fileTooLarge = true
    })
    file.on('end', () => {
      if (!fileTooLarge) {
        fileBuffer = Buffer.concat(chunks)
      }
    })
  })

  busboy.on('finish', () => {
    if (fileTooLarge) {
      res.status(413).json({ ok: false, error: { code: 'FILE_TOO_LARGE', message: 'Arquivo muito grande.' } })
      return
    }
    if (!fileBuffer) {
      res.status(400).json({ ok: false, error: { code: 'FILE_NOT_RECEIVED', message: 'Arquivo nao enviado.' } })
      return
    }
    const tipo = (req.query?.tipo || 'variavel').toString()
    const result = parseBovespaReceitas(fileBuffer, { tipo })
    if (!result.ok) {
      res.status(400).json(result)
      return
    }
    res.status(200).json({ ...result, fileName })
  })

  req.pipe(busboy)
}
