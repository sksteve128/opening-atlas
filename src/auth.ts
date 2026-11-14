const CLIENT_ID = 'opening-atlas.local'
const TOKEN = 'lichess-explorer-token'
const VERIFIER = 'lichess-oauth-verifier'
const STATE = 'lichess-oauth-state'

const redirectUri = () => location.origin + location.pathname
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const lichessToken = () => sessionStorage.getItem(TOKEN)

export async function connectLichess() {
  const verifier = random(), state = random()
  sessionStorage.setItem(VERIFIER, verifier)
  sessionStorage.setItem(STATE, state)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const url = new URL('https://lichess.org/oauth')
  url.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri(), code_challenge_method: 'S256', code_challenge: challenge, state }).toString()
  location.assign(url.href)
}

export async function completeLichess(): Promise<boolean> {
  const url = new URL(location.href)
  const code = url.searchParams.get('code'), error = url.searchParams.get('error'), returnedState = url.searchParams.get('state')
  if (!code && !error) return false
  const state = sessionStorage.getItem(STATE), verifier = sessionStorage.getItem(VERIFIER)
  url.searchParams.delete('code'); url.searchParams.delete('state'); url.searchParams.delete('error'); url.searchParams.delete('error_description')
  history.replaceState(null, '', url)
  sessionStorage.removeItem(STATE); sessionStorage.removeItem(VERIFIER)
  if (error) throw new Error('Lichess connection was cancelled.')
  if (!state || !verifier || state !== returnedState) throw new Error('Lichess connection could not be verified.')
  const response = await fetch('https://lichess.org/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, code_verifier: verifier, redirect_uri: redirectUri(), client_id: CLIENT_ID }) })
  if (!response.ok) throw new Error('Lichess connection failed. Please try again.')
  const { access_token } = await response.json() as { access_token: string }
  if (!access_token) throw new Error('Lichess did not return an access token.')
  sessionStorage.setItem(TOKEN, access_token)
  globalThis.dispatchEvent?.(new Event('lichess-auth-change'))
  return true
}

export function disconnectLichess() { sessionStorage.removeItem(TOKEN); globalThis.dispatchEvent?.(new Event('lichess-auth-change')) }
