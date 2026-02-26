const rawApiBase = (import.meta.env.VITE_API_BASE_URL || '').trim()
const apiBase = rawApiBase.replace(/\/+$/, '')

function isApiPath(path: string): boolean {
  return path.startsWith('/api/')
}

function toAbsoluteApiUrl(path: string): string {
  if (!apiBase || !isApiPath(path)) {
    return path
  }

  return `${apiBase}${path}`
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
