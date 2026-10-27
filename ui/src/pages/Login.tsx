import { useState } from 'react'
import { useApp } from '../state'

export function Login() {
  const { login } = useApp()
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!token) return
    setBusy(true)
    setError('')
    try {
      await login(token)
    } catch {
      setError('Invalid token')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full grid place-items-center p-6">
      <div className="card p-8 w-full max-w-sm">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl grid place-items-center text-white font-bold"
            style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' }}>HE</div>
          <div>
            <div className="text-lg font-bold">HUGO Eye</div>
            <div className="muted text-sm">Sign in to your local camera platform</div>
          </div>
        </div>
        <label className="section-label block mb-1.5" htmlFor="token">API token</label>
        <input id="token" type="password" className="input" placeholder="HUGO_EYE_API_TOKEN"
          value={token} onChange={e => setToken(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} autoFocus autoComplete="off" />
        {error && <p className="text-sm mt-2" style={{ color: 'var(--bad)' }}>{error}</p>}
        <button className="btn btn-primary w-full mt-4" onClick={submit} disabled={busy || !token}>
          {busy ? 'Signing in…' : 'Unlock'}
        </button>
        <p className="muted text-xs mt-4">The token is set in <code>.env</code> on the appliance (HUGO_EYE_API_TOKEN). Sessions expire after 12 hours.</p>
      </div>
    </div>
  )
}
