const TOKEN = 'opening-atlas-lichess-token'
const PENDING = 'opening-atlas-lichess-login'
const CLIENT = 'opening-atlas'
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function lichessToken(): string | undefined {
  try {
    const saved = localStorage.getItem(TOKEN)
    if (saved !== null) return saved || undefined
  } catch { /* Fall back to this tab when persistent storage is unavailable. */ }
  try {
    const legacy = sessionStorage.getItem(TOKEN) || undefined
    if (legacy) {
      try { localStorage.setItem(TOKEN, legacy); sessionStorage.removeItem(TOKEN) } catch { /* Keep the working session token. */ }
    }
    return legacy
  } catch { return undefined }
}
export function disconnectLichess() {
  // An empty persistent value prevents another open tab resurrecting a legacy token.
  try { localStorage.setItem(TOKEN, '') } catch { /* Storage may be blocked; still disconnect this tab. */ }
  sessionStorage.removeItem(TOKEN)
}

export async function connectLichess() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const redirect = location.origin + location.pathname + location.search
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, redirect, at: Date.now(), returnUrl: location.href }))
  const url = new URL('https://lichess.org/oauth')
  url.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: redirect, code_challenge_method: 'S256', code_challenge: challenge, state, scope: '' }).toString()
  location.assign(url.href)
}

let completion: Promise<boolean> | undefined
export function finishLichessLogin(): Promise<boolean> {
  return completion ||= finishLogin()
}
async function finishLogin() {
  const url = new URL(location.href)
  if (!url.searchParams.has('state') || (!url.searchParams.has('code') && !url.searchParams.has('error'))) return false
  const code = url.searchParams.get('code'), denied = url.searchParams.has('error')
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null')
  sessionStorage.removeItem(PENDING)
  const valid = pending && pending.state === url.searchParams.get('state') && Date.now() - pending.at < 600000 && new URL(pending.redirect).origin === location.origin && new URL(pending.redirect).pathname === location.pathname
  // Remove the single-use authorization code before any further navigation.
  url.searchParams.delete('code'); url.searchParams.delete('state'); url.searchParams.delete('error'); url.searchParams.delete('error_description')
  history.replaceState(null, '', valid && new URL(pending.returnUrl).origin === location.origin ? pending.returnUrl : url.href)
  if (!valid) throw new Error('Lichess sign-in expired or could not be validated. Please connect again.')
  if (denied || !code) throw new Error('Lichess sign-in was not completed.')
  const response = await fetch('https://lichess.org/api/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: CLIENT, redirect_uri: pending.redirect, code_verifier: pending.verifier }),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`Lichess sign-in failed (HTTP ${response.status}). Please connect again.`)
  const result = await response.json() as { access_token?: string }
  if (!result.access_token || !/^[A-Za-z0-9_]+$/.test(result.access_token)) throw new Error('Lichess did not return a valid access token.')
  try { localStorage.setItem(TOKEN, result.access_token); sessionStorage.removeItem(TOKEN) }
  catch { sessionStorage.setItem(TOKEN, result.access_token) }
  return true
}
