const rawApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim()
const apiBase = rawApiBase.replace(/\/+$/, '')

function isLocalHostname(hostname: string): boolean {
  const value = hostname.trim().toLowerCase()
  return value === 'localhost' || value === '127.0.0.1'
}

function resolveApiBase(): string {
  if (!apiBase) return ''
  if (typeof window === 'undefined') return apiBase

  try {
    const parsed = new URL(apiBase)
    const currentHost = window.location.hostname

    if (isLocalHostname(parsed.hostname) && !isLocalHostname(currentHost)) {
      const port = parsed.port ? `:${parsed.port}` : ''
      return `${parsed.protocol}//${currentHost}${port}`
    }
  } catch {
    return apiBase
  }

  return apiBase
}

const effectiveApiBase = resolveApiBase()

function isApiPath(path: string): boolean {
  return path.startsWith('/api/')
}

function toAbsoluteApiUrl(path: string): string {
  if (!isApiPath(path)) {
    return path
  }

  if (!effectiveApiBase) {
    return path
  }

  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    try {
      const apiOrigin = new URL(effectiveApiBase).origin
      if (apiOrigin !== window.location.origin) {
        return path
      }
    } catch {
      return path
    }
  }

  return `${effectiveApiBase}${path}`
}

export function buildApiUrl(path: string): string {
  return toAbsoluteApiUrl(path)
}

function maybeRewriteAbsoluteApiUrl(url: string): string {
  const originPrefix = `${window.location.origin}/api/`
  if (!url.startsWith(originPrefix)) {
    return url
  }

  const path = url.slice(window.location.origin.length)
  return toAbsoluteApiUrl(path)
}

function withApiCredentials(url: string, init?: RequestInit): RequestInit | undefined {
  if (!url.includes('/api/')) {
    return init
  }
  if (init?.credentials) {
    return init
  }
  return { ...init, credentials: 'include' }
}

export function installApiBaseFetch(): void {
  if (typeof window === 'undefined') return

  const nativeFetch = window.fetch.bind(window)

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') {
      if (input.startsWith('http://') || input.startsWith('https://')) {
        const rewritten = maybeRewriteAbsoluteApiUrl(input)
        return nativeFetch(rewritten, withApiCredentials(rewritten, init))
      }
      const rewritten = toAbsoluteApiUrl(input)
      return nativeFetch(rewritten, withApiCredentials(rewritten, init))
    }

    if (input instanceof URL) {
      const rewritten = maybeRewriteAbsoluteApiUrl(input.toString())
      return nativeFetch(rewritten, withApiCredentials(rewritten, init))
    }

    if (input instanceof Request) {
      const rewritten = maybeRewriteAbsoluteApiUrl(input.url)
      return nativeFetch(rewritten, withApiCredentials(rewritten, init))
    }

    return nativeFetch(input, init)
  }) as typeof window.fetch
}
