# Firebase Functions (Mercado Pago - Passo 1)

## Requisitos
- Node 18+
- Firebase CLI configurado

## Instalar dependencias

```bash
npm --prefix functions install
```

## Segredos (nao versionar)

### Desenvolvimento local
Crie `functions/.secret.local` com:

```
MP_ACCESS_TOKEN=SEU_TOKEN
MP_WEBHOOK_SECRET=SEU_WEBHOOK_SECRET
```

O arquivo ja esta no `.gitignore`.

### Produção (Firebase Secrets)

```bash
firebase functions:secrets:set MP_ACCESS_TOKEN
firebase functions:secrets:set MP_WEBHOOK_SECRET
```

## Emulador

```bash
firebase emulators:start --only functions
```

## Funcoes
- `createAnnualCheckoutLink` (callable): retorna `{ ok:false, reason:"NOT_IMPLEMENTED" }`.
- `mercadoPagoWebhook` (HTTP): responde `200 ok` e loga headers/body.
