const getDateFromValue = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "number") return new Date(value);
  return null;
};

export const getExpiryDate = (activatedAt, durationDays, expiresAt) => {
  const explicitExpiry = getDateFromValue(expiresAt);
  if (explicitExpiry) return explicitExpiry;

  const baseDate = getDateFromValue(activatedAt);
  const days = Number(durationDays);
  if (!baseDate || !Number.isFinite(days) || days <= 0) return null;
  return new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000);
};

export const getExpiryFromEntitlement = (entitlement) => {
  if (!entitlement) return null;
  return getExpiryDate(entitlement.activatedAt, entitlement.durationDays, entitlement.expiresAt);
};

export const isEntitlementValid = (entitlement) => {
  const expiryDate = getExpiryFromEntitlement(entitlement);
  return Boolean(expiryDate && Date.now() <= expiryDate.getTime());
};
