import { getAppConfig, setAppConfig } from './nativeStorage'

export const getLicenseStatus = async () => {
  const config = await getAppConfig()
  return {
    status: 'disabled',
    enabled: config?.license?.enabled === true,
    endpoint: config?.license?.endpoint || '',
  }
}

export const setLicenseEndpoint = async (endpoint) => {
  return setAppConfig({
    license: { enabled: false, endpoint: endpoint || '' },
  })
}

export const getAuthStatus = async () => {
  const config = await getAppConfig()
  return {
    status: 'disabled',
    enabled: config?.auth?.enabled === true,
    endpoint: config?.auth?.endpoint || '',
  }
}

export const setAuthEndpoint = async (endpoint) => {
  return setAppConfig({
    auth: { enabled: false, endpoint: endpoint || '' },
  })
}
