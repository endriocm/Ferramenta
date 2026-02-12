const admin = require("firebase-admin");
const { randomUUID, createHmac, timingSafeEqual } = require("crypto");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

const MP_ACCESS_TOKEN = defineSecret("MP_ACCESS_TOKEN");
const MP_WEBHOOK_SECRET_TEST = defineSecret("MP_WEBHOOK_SECRET_TEST");
const MP_WEBHOOK_SECRET_PROD = defineSecret("MP_WEBHOOK_SECRET_PROD");
const ANNUAL_PRICE_BRL = defineString("ANNUAL_PRICE_BRL");
const APP_BASE_URL = defineString("APP_BASE_URL");
const MIN_ANNUAL_PRICE_BRL = 12000;

admin.initializeApp();
setGlobalOptions({ region: "us-central1" });

const validateEnv = () => {
  const priceRaw = ANNUAL_PRICE_BRL.value();
  let appBase = APP_BASE_URL.value();

  if (!priceRaw || !appBase) {
    throw new HttpsError("failed-precondition", "ANNUAL_PRICE_BRL e APP_BASE_URL devem estar configurados.");
  }

  appBase = String(appBase).trim().replace(/\/+$/, ""); // remove barras no fim

  if (!/^https?:\/\//i.test(appBase)) {
    throw new HttpsError("failed-precondition", "APP_BASE_URL deve come?ar com http:// ou https://");
  }

  const configuredPrice = Number(priceRaw);
  if (!Number.isFinite(configuredPrice) || configuredPrice <= 0) {
    throw new HttpsError("failed-precondition", "ANNUAL_PRICE_BRL invalido.");
  }

  const price = configuredPrice < MIN_ANNUAL_PRICE_BRL ? MIN_ANNUAL_PRICE_BRL : configuredPrice;
  if (price !== configuredPrice) {
    logger.warn("[checkout] annual price adjusted to minimum", {
      configuredPrice,
      adjustedPrice: price,
      minimum: MIN_ANNUAL_PRICE_BRL,
    });
  }
  return { price, appBase };
};

const formatBrl = (value) =>
  new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);

const buildAnnualPlanTitle = (annualPrice) => {
  const monthlyEquivalent = annualPrice / 12;
  return `PWR - Acesso anual (${formatBrl(monthlyEquivalent)}/mes | ${formatBrl(annualPrice)}/ano)`;
};

const mpCreatePreference = async ({ uid, email, price, appBase }) => {
  const payload = {
    items: [
      {
        title: buildAnnualPlanTitle(price),
        quantity: 1,
        unit_price: price,
      },
    ],
    external_reference: uid,
    back_urls: {
      success: `${appBase}/billing/success`,
      pending: `${appBase}/billing/pending`,
      failure: `${appBase}/billing/failure`,
    },
    notification_url: "https://us-central1-pwr-endrio.cloudfunctions.net/mercadoPagoWebhook",
    auto_return: "approved",
    payment_methods: {
      installments: 12,
    },
    metadata: {
      uid,
      product: "pwr_annual",
    },
  };

  if (email) {
    payload.payer = { email };
  }

  const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": `${uid}-${randomUUID()}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new HttpsError(
      "internal",
      `Falha ao criar preference no Mercado Pago (status ${res.status}).`,
      { status: res.status, body: errorBody }
    );
  }

  const data = await res.json();
  return {
    id: data.id,
    init_point: data.init_point,
    sandbox_init_point: data.sandbox_init_point,
  };
};

const getHeaderValue = (req, name) => {
  const direct = req.get(name);
  if (direct) return direct;
  const lower = req.headers?.[name.toLowerCase()];
  if (Array.isArray(lower)) return lower[0];
  return lower || "";
};

const getQueryValue = (value) => {
  if (Array.isArray(value)) return value[0];
  return value || "";
};

const parseSignature = (signatureHeader) => {
  if (!signatureHeader) return {};
  return String(signatureHeader)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const [key, value] = part.split("=");
      if (key && value) acc[key.trim()] = value.trim();
      return acc;
    }, {});
};

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const parseMpDate = (value) => {
  if (!value) return 0;
  const parsed = new Date(value);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : 0;
};

const msDays = (days) => days * 24 * 60 * 60 * 1000;

const toMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return 0;
};

const computeCurrentExpiryMs = (entitlement) => {
  if (!entitlement) return 0;
  const expiresAtMs = toMillis(entitlement.expiresAt);
  if (expiresAtMs) return expiresAtMs;

  const activatedAtMs = toMillis(entitlement.activatedAt);
  const durationDays = Number(entitlement.durationDays);
  if (!activatedAtMs || !Number.isFinite(durationDays) || durationDays <= 0) return 0;
  return activatedAtMs + msDays(durationDays);
};

const buildEntitlementFields = ({ approvedAtMs, newExpiryMs, paymentId }) => {
  const durationDays = Math.ceil((newExpiryMs - approvedAtMs) / msDays(1));
  return {
    expiresAt: admin.firestore.Timestamp.fromMillis(newExpiryMs),
    status: "active",
    lastPaymentId: paymentId,
    activatedAt: admin.firestore.Timestamp.fromMillis(approvedAtMs),
    durationDays,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
};

const getPaymentUid = (payment) => {
  const externalUid = payment?.external_reference;
  const metadataUid = payment?.metadata?.uid;

  if (externalUid && metadataUid && String(externalUid) !== String(metadataUid)) {
    return { uid: "", mismatch: true };
  }

  const uid = String(externalUid || metadataUid || "").trim();
  return { uid, mismatch: false };
};

const isAdminUid = async (uid) => {
  if (!uid) return false;
  const snap = await admin.firestore().doc(`users/${uid}`).get();
  return snap.exists && snap.data()?.isAdmin === true;
};

const assertAdmin = async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Autenticacao obrigatoria.");
  }
  const ok = await isAdminUid(request.auth.uid);
  if (!ok) {
    throw new HttpsError("permission-denied", "Acesso restrito ao admin.");
  }
};

const applyPaymentToEntitlement = async ({ payment, paymentId, db }) => {
  const status = String(payment?.status || "").toLowerCase();
  const statusDetail = String(payment?.status_detail || "").toLowerCase();
  const revokedByStatus = ["cancelled", "refunded", "charged_back"].includes(status);
  const revokedByDetail =
    statusDetail.includes("charged_back") || statusDetail.includes("reimbursed");

  const { uid, mismatch } = getPaymentUid(payment);
  if (mismatch) {
    console.warn("[applyPaymentToEntitlement] uid divergente no pagamento.");
    return { actionTaken: "ignored", uid: "", status };
  }

  if (!uid) {
    console.warn("[applyPaymentToEntitlement] uid ausente no pagamento.");
    return { actionTaken: "ignored", uid: "", status };
  }

  if (status === "approved") {
    const expectedAmount = Number(ANNUAL_PRICE_BRL.value());
    const amount = Number(payment.transaction_amount);
    const currency = String(payment.currency_id || "").toUpperCase();
    const approvedAtMs = parseMpDate(payment?.date_approved);

    if (Number.isFinite(expectedAmount) && expectedAmount > 0) {
      const amountMatches = Math.abs(amount - expectedAmount) < 0.01;
      const currencyMatches = currency === "BRL";
      if (!amountMatches || !currencyMatches) {
        console.warn(
          "[applyPaymentToEntitlement] pagamento divergente, ignorando concessao.",
          { paymentId, amount, expectedAmount, currency }
        );
        return { actionTaken: "ignored", uid, status };
      }
    }

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const ADD_DAYS = 365;
    const ADD_MS = ADD_DAYS * ONE_DAY_MS;

    let actionTaken = "granted";
    let newExpiresAtMs = null;
    let prevEntitlement = null;
    let nextEntitlement = null;

    await db.runTransaction(async (tx) => {
      const entitlementRef = db.collection("entitlements").doc(uid);
      const paymentRef = db.collection("mpPayments").doc(String(paymentId));
      const paySnap = await tx.get(paymentRef);

      if (paySnap.exists && (paySnap.get("processedAt") || paySnap.get("entitlementApplied") === true)) {
        actionTaken = "noop";
        return;
      }

      const entSnap = await tx.get(entitlementRef);
      prevEntitlement = entSnap.exists ? entSnap.data() : null;

      const now = admin.firestore.Timestamp.now();
      const approvedBaseMs = approvedAtMs || now.toMillis();
      let baseMs = approvedBaseMs;
      const currentExpiryMs = computeCurrentExpiryMs(prevEntitlement);
      if (currentExpiryMs && currentExpiryMs > baseMs) {
        baseMs = currentExpiryMs;
      }

      newExpiresAtMs = baseMs + ADD_MS;
      const newExpiresAt = admin.firestore.Timestamp.fromMillis(newExpiresAtMs);

      const activatedAt = entSnap.exists && entSnap.get("activatedAt") ? entSnap.get("activatedAt") : now;
      const grantedAt = entSnap.exists && entSnap.get("grantedAt") ? entSnap.get("grantedAt") : now;
      const durationDays = Math.ceil((newExpiresAt.toMillis() - activatedAt.toMillis()) / ONE_DAY_MS);

      nextEntitlement = {
        status: "active",
        plan: "annual",
        provider: "mercadopago",
        sourceKeyId: "mercadopago",
        product: "pwr_annual",
        lastPaymentId: paymentId,
        paymentId,
        expiresAt: newExpiresAt,
        activatedAt,
        durationDays,
        grantedAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      tx.set(entitlementRef, nextEntitlement, { merge: true });

      tx.set(
        paymentRef,
        {
          uid,
          status,
          status_detail: payment.status_detail || null,
          transaction_amount: amount,
          currency_id: payment.currency_id || null,
          processedAt: now,
          entitlementApplied: true,
          grantExpiresAt: newExpiresAt,
          preference_id: payment?.preference_id || payment?.order?.id || null,
          amount,
          createdAt: now,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return {
      actionTaken,
      uid,
      status,
      newExpiresAtMs,
      prevEntitlement,
      nextEntitlement,
    };
  }

  if (revokedByStatus || revokedByDetail) {
    let actionTaken = "ignored";
    let prevEntitlement = null;
    let nextEntitlement = null;

    await db.runTransaction(async (tx) => {
      const entRef = db.doc(`entitlements/${uid}`);
      const payRef = db.doc(`mpPayments/${paymentId}`);
      const entSnap = await tx.get(entRef);
      prevEntitlement = entSnap.exists ? entSnap.data() : null;

      tx.set(
        payRef,
        {
          status,
          status_detail: payment.status_detail || null,
          revoked: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (entSnap.exists() && entSnap.data()?.lastPaymentId === paymentId) {
        const now = admin.firestore.Timestamp.fromDate(new Date());
        nextEntitlement = {
          status: "revoked",
          expiresAt: now,
          revokedAt: now,
        };

        tx.set(
          entRef,
          {
            ...nextEntitlement,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        actionTaken = "revoked";
      }
    });

    return {
      actionTaken,
      uid,
      status,
      prevEntitlement,
      nextEntitlement,
    };
  }

  return { actionTaken: "ignored", uid, status };
};

exports.createAnnualCheckoutLink = onCall({ secrets: [MP_ACCESS_TOKEN] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Autenticacao obrigatoria.");
  }

  const uid = request.auth.uid;
  const email = request.auth.token?.email || "";
  logger.info("[checkout] start", { uid, email });

  let price, appBase;
  try {
    ({ price, appBase } = validateEnv());
    logger.info("[checkout] env ok", { price, appBase });
  } catch (err) {
    logger.error("[checkout] validateEnv failed", { code: err.code, message: err.message });
    throw err;
  }

  let preference;
  try {
    logger.info("[checkout] calling MP createPreference", { uid, price, appBase });
    preference = await mpCreatePreference({ uid, email, price, appBase });
    logger.info("[checkout] MP ok", {
      preferenceId: preference.id,
      init_point: preference.init_point,
      sandbox_init_point: preference.sandbox_init_point,
    });
    const db = admin.firestore();

    await db.collection("mpPayments").doc(preference.id).set(
      {
        kind: "intent",
        uid,
        email,
        status: "preference_created",
        amount: price,
        preferenceId: preference.id,
        init_point: preference.init_point,
        sandbox_init_point: preference.sandbox_init_point,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log("[checkout] saved intent", { preferenceId: preference.id });
  } catch (err) {
    logger.error("[checkout] mpCreatePreference failed", {
      code: err.code,
      message: err.message,
      details: err.details || null,
      stack: err.stack,
    });
    if (err instanceof HttpsError) throw err;
    throw new HttpsError("internal", `Erro ao criar checkout: ${err.message}`);
  }

  return {
    ok: true,
    preferenceId: preference.id,
    url: preference.init_point,
    sandboxUrl: preference.sandbox_init_point,
  };
});

exports.adminFindUserByEmail = onCall(async (request) => {
  await assertAdmin(request);

  const email = String(request.data?.email || "").trim().toLowerCase();
  if (!email) {
    throw new HttpsError("invalid-argument", "Email obrigatorio.");
  }

  try {
    const userRecord = await admin.auth().getUserByEmail(email);
    return {
      uid: userRecord.uid,
      email: userRecord.email || email,
      displayName: userRecord.displayName || "",
    };
  } catch (err) {
    if (err?.code === "auth/user-not-found") {
      throw new HttpsError("not-found", "Usuario nao encontrado.");
    }
    throw new HttpsError("internal", "Falha ao buscar usuario.");
  }
});

exports.adminGetUserAccess = onCall(async (request) => {
  await assertAdmin(request);

  const uid = String(request.data?.uid || "").trim();
  if (!uid) {
    throw new HttpsError("invalid-argument", "UID obrigatorio.");
  }

  const db = admin.firestore();
  const userRef = db.doc(`users/${uid}`);
  const entRef = db.doc(`entitlements/${uid}`);

  const [userSnap, entSnap, authUser] = await Promise.all([
    userRef.get(),
    entRef.get(),
    admin.auth().getUser(uid).catch(() => null),
  ]);

  const userDocData = userSnap.exists ? userSnap.data() : {};
  const userDoc = {
    uid,
    email: authUser?.email || userDocData?.email || null,
    displayName: authUser?.displayName || userDocData?.displayName || null,
    ...userDocData,
  };

  const entitlementDoc = entSnap.exists ? entSnap.data() : null;
  const expiryMs = computeCurrentExpiryMs(entitlementDoc);
  const computed = {
    isValid: Boolean(expiryMs && Date.now() <= expiryMs),
    expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
    expiresAtMs: expiryMs || null,
  };

  const paymentsSnap = await db
    .collection("mpPayments")
    .where("uid", "==", uid)
    .orderBy("updatedAt", "desc")
    .limit(20)
    .get();

  const payments = paymentsSnap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      paymentId: doc.id,
      status: data.status || null,
      status_detail: data.status_detail || null,
      transaction_amount: data.transaction_amount || null,
      currency_id: data.currency_id || null,
      date_approved: data.date_approved || null,
      date_created: data.date_created || null,
      updatedAt: data.updatedAt || null,
    };
  });

  return {
    userDoc,
    entitlementDoc,
    payments,
    computed,
  };
});

exports.getMyAccessStatus = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Autenticacao obrigatoria.");
  }

  const uid = request.auth.uid;
  const db = admin.firestore();
  const entSnap = await db.doc(`entitlements/${uid}`).get();
  const entitlementDoc = entSnap.exists ? entSnap.data() : null;

  const expiryMs = computeCurrentExpiryMs(entitlementDoc);
  const isValid = Boolean(expiryMs && Date.now() <= expiryMs);

  return {
    ok: true,
    computed: {
      isValid,
      expiresAtMs: expiryMs || null,
      expiresAt: expiryMs ? new Date(expiryMs).toISOString() : null,
    },
    entitlement: entitlementDoc
      ? { status: entitlementDoc.status || null, lastPaymentId: entitlementDoc.lastPaymentId || null }
      : null,
  };
});


exports.adminGrantAccess = onCall(async (request) => {
  await assertAdmin(request);

  const uid = String(request.data?.uid || "").trim();
  const days = Number(request.data?.days);
  const reason = String(request.data?.reason || "").trim();

  if (!uid) {
    throw new HttpsError("invalid-argument", "UID obrigatorio.");
  }
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    throw new HttpsError("invalid-argument", "Dias invalidos.");
  }

  const db = admin.firestore();
  const nowMs = Date.now();
  const manualPaymentId = `manual:${nowMs}`;

  await db.runTransaction(async (tx) => {
    const entRef = db.doc(`entitlements/${uid}`);
    const entSnap = await tx.get(entRef);
    const prevEntitlement = entSnap.exists ? entSnap.data() : null;

    const currentExpiryMs = computeCurrentExpiryMs(prevEntitlement);
    const baseMs = Math.max(currentExpiryMs || 0, nowMs);
    const newExpiryMs = baseMs + msDays(days);

    const existingActivatedAt = prevEntitlement?.activatedAt;
    const activatedAtMs = existingActivatedAt ? toMillis(existingActivatedAt) || baseMs : baseMs;
    const durationDays = Math.ceil((newExpiryMs - activatedAtMs) / msDays(1));

    const activatedAtValue = existingActivatedAt
      ? existingActivatedAt
      : admin.firestore.Timestamp.fromMillis(activatedAtMs);

    const nextEntitlement = {
      status: "active",
      provider: "manual",
      lastPaymentId: manualPaymentId,
      expiresAt: admin.firestore.Timestamp.fromMillis(newExpiryMs),
      activatedAt: activatedAtValue,
      durationDays,
    };

    tx.set(
      entRef,
      {
        ...nextEntitlement,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const auditRef = db.collection("accessAudits").doc();
    tx.set(auditRef, {
      actorUid: request.auth.uid,
      targetUid: uid,
      action: "grant",
      days,
      reason,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      prevEntitlement: prevEntitlement || null,
      nextEntitlement,
    });
  });

  return { ok: true };
});

exports.adminRevokeAccess = onCall(async (request) => {
  await assertAdmin(request);

  const uid = String(request.data?.uid || "").trim();
  const reason = String(request.data?.reason || "").trim();

  if (!uid) {
    throw new HttpsError("invalid-argument", "UID obrigatorio.");
  }

  const db = admin.firestore();
  const now = admin.firestore.Timestamp.fromDate(new Date());

  await db.runTransaction(async (tx) => {
    const entRef = db.doc(`entitlements/${uid}`);
    const entSnap = await tx.get(entRef);
    const prevEntitlement = entSnap.exists ? entSnap.data() : null;

    const nextEntitlement = {
      status: "revoked",
      provider: "manual",
      expiresAt: now,
      revokedAt: now,
    };

    tx.set(
      entRef,
      {
        ...nextEntitlement,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const auditRef = db.collection("accessAudits").doc();
    tx.set(auditRef, {
      actorUid: request.auth.uid,
      targetUid: uid,
      action: "revoke",
      days: 0,
      reason,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      prevEntitlement: prevEntitlement || null,
      nextEntitlement,
    });
  });

  return { ok: true };
});

exports.adminReprocessPayment = onCall({ secrets: [MP_ACCESS_TOKEN] }, async (request) => {
  await assertAdmin(request);

  const paymentId = String(request.data?.paymentId || "").trim();
  if (!paymentId) {
    throw new HttpsError("invalid-argument", "paymentId obrigatorio.");
  }

  const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
    },
  });

  if (!paymentRes.ok) {
    const errorBody = await paymentRes.text();
    throw new HttpsError(
      "internal",
      `Falha ao buscar pagamento no Mercado Pago (status ${paymentRes.status}).`,
      { status: paymentRes.status, body: errorBody }
    );
  }

  const payment = await paymentRes.json();
  const { uid } = getPaymentUid(payment);
  const db = admin.firestore();
  const mpPaymentRef = db.doc(`mpPayments/${paymentId}`);

  await mpPaymentRef.set(
    {
      uid: uid || null,
      status: payment.status || null,
      status_detail: payment.status_detail || null,
      transaction_amount: payment.transaction_amount || null,
      currency_id: payment.currency_id || null,
      date_approved: payment.date_approved || null,
      date_created: payment.date_created || null,
      rawPayment: payment,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      reprocessedAt: admin.firestore.FieldValue.serverTimestamp(),
      reprocessedBy: request.auth.uid,
      source: "admin",
    },
    { merge: true }
  );

  const result = await applyPaymentToEntitlement({ payment, paymentId, db });
  const actionTaken = result.actionTaken || "ignored";
  const resultUid = result.uid || uid || null;
  const status = result.status || String(payment.status || "").toLowerCase();

  if (resultUid) {
    await db.collection("accessAudits").add({
      actorUid: request.auth.uid,
      targetUid: resultUid,
      action: "reprocess_payment",
      days: 0,
      reason: "",
      paymentId,
      status,
      actionTaken,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      prevEntitlement: result.prevEntitlement || null,
      nextEntitlement: result.nextEntitlement || null,
    });
  }

  return {
    ok: true,
    paymentId,
    uid: resultUid,
    status,
    actionTaken,
    newExpiresAt: result.newExpiresAtMs ? new Date(result.newExpiresAtMs).toISOString() : null,
  };
});

exports.mercadoPagoWebhook = onRequest(
  { secrets: [MP_WEBHOOK_SECRET_TEST, MP_WEBHOOK_SECRET_PROD, MP_ACCESS_TOKEN] },
  async (req, res) => {
    const queryId = getQueryValue(req.query?.id);
    const queryDataId = getQueryValue(req.query?.["data.id"]);
    const bodyDataId = req.body?.data?.id;
    const bodyId = req.body?.id;
    const resourceId = String(queryId || queryDataId || bodyDataId || bodyId || "").trim();
    const topicRaw =
      getQueryValue(req.query?.topic) ||
      getQueryValue(req.query?.type) ||
      String(req.body?.topic || req.body?.type || "");
    const topic = String(topicRaw || "").toLowerCase().trim();

    if (!resourceId) {
      console.warn("[mercadoPagoWebhook] resourceId ausente, ignorando.");
      return res.status(200).send("ok");
    }

    const xRequestId = getHeaderValue(req, "x-request-id") || "";
    const xSignature = getHeaderValue(req, "x-signature") || "";

    const tsMatch = xSignature.match(/ts=([0-9]+)/);
    const v1Match = xSignature.match(/v1=([a-f0-9]+)/i);

    if (!xRequestId || !tsMatch || !v1Match) {
      console.warn("[mercadoPagoWebhook] assinatura ausente ou invalida.");
      return res.status(401).send("missing signature");
    }

    const ts = tsMatch[1];
    const received = v1Match[1].toLowerCase();

    const manifest = `id:${resourceId};request-id:${xRequestId};ts:${ts};`;

    const sign = (secret) => createHmac("sha256", secret).update(manifest).digest("hex");
    const expectedProd = sign(MP_WEBHOOK_SECRET_PROD.value());
    const expectedTest = sign(MP_WEBHOOK_SECRET_TEST.value());

    const ok = safeEqual(received, expectedProd) || safeEqual(received, expectedTest);

    if (!ok) {
      console.warn("[mercadoPagoWebhook] assinatura invalida.");
      return res.status(401).send("invalid signature");
    }

    let paymentId = resourceId;

    if (topic === "merchant_order") {
      try {
        const orderRes = await fetch(`https://api.mercadopago.com/merchant_orders/${resourceId}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
          },
        });

        if (!orderRes.ok) {
          const errorBody = await orderRes.text();
          console.warn(
            `[mercadoPagoWebhook] falha ao buscar merchant_order ${resourceId} (status ${orderRes.status})`,
            errorBody
          );
          return res.status(200).send("ok");
        }

        const order = await orderRes.json();
        const payments = Array.isArray(order?.payments) ? order.payments : [];
        const approved = payments.find((p) => String(p?.status || "").toLowerCase() === "approved");
        const fallback = approved || payments[0];
        paymentId = String(fallback?.id || "").trim();

        if (!paymentId) {
          console.warn("[mercadoPagoWebhook] merchant_order sem pagamentos, ignorando.");
          return res.status(200).send("ok");
        }
      } catch (err) {
        console.error("[mercadoPagoWebhook] erro ao buscar merchant_order:", err?.message || err);
        return res.status(200).send("ok");
      }
    }

    if (!paymentId) {
      console.warn("[mercadoPagoWebhook] paymentId ausente apos resolver evento, ignorando.");
      return res.status(200).send("ok");
    }

    try {
      const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN.value()}`,
        },
      });

      if (!paymentRes.ok) {
        const errorBody = await paymentRes.text();
        console.warn(
          `[mercadoPagoWebhook] falha ao buscar pagamento ${paymentId} (status ${paymentRes.status})`,
          errorBody
        );
        return res.status(200).send("ok");
      }

      const payment = await paymentRes.json();
      const { uid, mismatch } = getPaymentUid(payment);

      if (mismatch) {
        console.warn("[mercadoPagoWebhook] uid divergente no pagamento, ignorando.");
        return res.status(200).send("ok");
      }

      if (!uid) {
        console.warn("[mercadoPagoWebhook] uid ausente no pagamento, ignorando.");
        return res.status(200).send("ok");
      }

      const db = admin.firestore();
      const mpPaymentRef = db.doc(`mpPayments/${paymentId}`);

      await mpPaymentRef.set(
        {
          uid,
          status: payment.status || null,
          status_detail: payment.status_detail || null,
          transaction_amount: payment.transaction_amount || null,
          currency_id: payment.currency_id || null,
          date_approved: payment.date_approved || null,
          date_created: payment.date_created || null,
          rawPayment: payment,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      await applyPaymentToEntitlement({ payment, paymentId, db });

      return res.status(200).send("ok");
    } catch (err) {
      console.error("[mercadoPagoWebhook] erro inesperado:", err?.message || err);
      return res.status(200).send("ok");
    }
  }
);
