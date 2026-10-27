import { useCallback, useEffect, useState } from 'react'
import { api, fmtBytes, type ProductSettings, type SessionInfo, type StorageStats } from '../api'
import { useApp } from '../state'
import { Card, ConfirmButton, Pill, SectionTitle, StatRow, Toggle } from '../components/ui'

export function SettingsPage() {
  const { pushToast, logout } = useApp()
  const [settings, setSettings] = useState<ProductSettings | null>(null)
  const [storage, setStorage] = useState<StorageStats | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [audit, setAudit] = useState<any[]>([])
  const [health, setHealth] = useState<any>(null)
  const [adapter, setAdapter] = useState<any>(null)
  const [confirmRec, setConfirmRec] = useState(false)
  const [confirmMic, setConfirmMic] = useState(false)
  const [confirmAI, setConfirmAI] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, st, se, au, h, ad] = await Promise.all([
        api.settings(), api.storage(), api.sessions(), api.audit(), api.health(), api.adapterManifest(),
      ])
      setSettings(s.settings)
      setStorage(st)
      setSessions(se.sessions)
      setAudit(au.entries)
      setHealth(h)
      setAdapter(ad)
    } catch { /* */ }
  }, [])
  useEffect(() => { load() }, [load])

  const patch = async (body: any, msg: string) => {
    try {
      const r = await api.patchSettings(body)
      setSettings(r.settings)
      pushToast('ok', msg)
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  if (!settings) return null

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-4">
      {/* Privacy */}
      <Card>
        <SectionTitle>Privacy <span className="normal-case font-normal">— everything off by default; enforced on the appliance, not just in the UI</span></SectionTitle>
        <div className="flex flex-col gap-3">
          <GateRow
            title="Recording"
            desc="Allows manual recordings and motion-triggered recordings. Video is stored only on this appliance."
            checked={settings.privacy.recordingEnabled}
            confirming={confirmRec}
            onAsk={() => setConfirmRec(true)}
            onCancel={() => setConfirmRec(false)}
            onConfirm={on => { patch({ privacy: { recordingEnabled: on } }, on ? 'Recording enabled' : 'Recording disabled'); setConfirmRec(false) }}
          />
          <GateRow
            title="Microphone (listen + audio in recordings)"
            desc="Allows one-way listening from the camera mic and including audio in recordings. Two-way talk is not available via the camera protocol."
            checked={settings.privacy.microphoneEnabled}
            confirming={confirmMic}
            onAsk={() => setConfirmMic(true)}
            onCancel={() => setConfirmMic(false)}
            onConfirm={on => { patch({ privacy: { microphoneEnabled: on } }, on ? 'Microphone enabled' : 'Microphone disabled'); setConfirmMic(false) }}
          />
          <GateRow
            title="Video analysis (AI)"
            desc="Allows local motion analysis. Required for motion events and automations."
            checked={settings.privacy.aiEnabled}
            confirming={confirmAI}
            onAsk={() => setConfirmAI(true)}
            onCancel={() => setConfirmAI(false)}
            onConfirm={on => { patch({ privacy: { aiEnabled: on } }, on ? 'AI enabled' : 'AI disabled'); setConfirmAI(false) }}
          />
        </div>
        <p className="muted text-xs mt-3">Per-camera privacy blocks live in Cameras. No video, audio or still image ever leaves this appliance; there is no cloud component.</p>
      </Card>

      {/* Storage */}
      {storage && (
        <Card>
          <SectionTitle>Storage & retention</SectionTitle>
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="text-sm block">
              <span className="muted block mb-1">Recording quota (GB)</span>
              <input type="number" className="input" min={1} max={8000} defaultValue={settings.storage.maxStorageGb}
                onBlur={e => patch({ storage: { maxStorageGb: Number(e.target.value) } }, 'Quota updated')} />
            </label>
            <label className="text-sm block">
              <span className="muted block mb-1">Recording retention (days)</span>
              <input type="number" className="input" min={1} max={3650} defaultValue={settings.storage.retentionDays}
                onBlur={e => patch({ storage: { retentionDays: Number(e.target.value) } }, 'Retention updated')} />
            </label>
            <label className="text-sm block">
              <span className="muted block mb-1">Event history (days)</span>
              <input type="number" className="input" min={1} max={365} defaultValue={settings.storage.eventRetentionDays ?? 30}
                onBlur={e => patch({ storage: { eventRetentionDays: Number(e.target.value) } }, 'Event retention updated')} />
            </label>
            <label className="text-sm block">
              <span className="muted block mb-1">Motion pre-event buffer (GOPs)</span>
              <input type="number" className="input" min={0} max={4} defaultValue={settings.motion.preBufferGops ?? 0}
                onBlur={e => patch({ motion: { preBufferGops: Number(e.target.value) } }, 'Pre-event buffer updated')} />
            </label>
            <label className="text-sm block">
              <span className="muted block mb-1">Keep free disk (GB)</span>
              <input type="number" className="input" min={1} max={500} defaultValue={settings.storage.minFreeGb}
                onBlur={e => patch({ storage: { minFreeGb: Number(e.target.value) } }, 'Disk guard updated')} />
            </label>
          </div>
          <div className="mt-3 text-sm space-y-1">
            <StatRow label="Recordings" value={`${storage.recordingSegments} segments · ${fmtBytes(storage.recordingBytes)}`} />
            <StatRow label="Snapshots & events" value={fmtBytes(storage.snapshotBytes)} />
            <StatRow label="Quota used" value={`${fmtBytes(storage.totalBytes)} of ${fmtBytes(storage.maxBytes)}`} />
            <StatRow label="Disk free" value={fmtBytes(storage.freeBytes)} />
          </div>
        </Card>
      )}

      {/* Access */}
      <Card>
        <SectionTitle right={<button className="btn btn-danger" onClick={async () => {
          await api.revokeAllSessions(); pushToast('ok', 'All sessions revoked — sign in again'); logout()
        }}>Revoke all sessions</button>}>
          Access
        </SectionTitle>
        <div className="text-sm space-y-1 mb-3">
          {sessions.filter(s => !s.revoked && !s.expired).map(s => (
            <div key={s.id} className="flex items-center gap-3 py-1">
              <Pill kind="ok">active</Pill>
              <span className="font-mono text-xs">{s.id}</span>
              <span className="muted text-xs">{s.label}</span>
              <span className="muted text-xs ml-auto">expires {new Date(s.expires_at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
        <p className="muted text-xs">Sign-in uses the appliance API token (HUGO_EYE_API_TOKEN in .env). Rotate it there and restart the service to invalidate everything at once.</p>
      </Card>

      {/* System */}
      {health && (
        <Card>
          <SectionTitle>System</SectionTitle>
          <div className="text-sm">
            <StatRow label="Product" value={`${health.product} v${health.version}`} />
            <StatRow label="Camera" value={health.cameras?.['tapo-main']?.ok ? 'healthy' : 'degraded'} />
            <StatRow label="PTZ lock" value={health.ptzLock?.busy ? `busy (${health.ptzLock.holder})` : 'idle'} />
            <StatRow label="Storage usage" value={storage ? fmtBytes(storage.totalBytes) : '—'} />
          </div>
        </Card>
      )}

      {/* Integrations */}
      <Card>
        <SectionTitle>Integrations</SectionTitle>
        <div className="text-sm space-y-2">
          <div className="flex items-center gap-2">
            <Pill kind="accent">prepared</Pill>
            <span><b>HUGO Core</b> — governed DeviceAdapter boundary is implemented (capabilities: {adapter?.capabilities?.map((c: any) => c.action).join(', ')}). Not connected; a separate approved milestone wires it.</span>
          </div>
          <div className="flex items-center gap-2">
            <Pill>interface prepared</Pill>
            <span><b>Home Assistant</b> — explicit future interface; no HA integration is active in this product.</span>
          </div>
          <div className="flex items-center gap-2">
            <Pill>local only</Pill>
            <span><b>Media gateway (go2rtc / WebRTC)</b> — evaluated; current build uses the verified in-process MJPEG pipeline. See docs/ARCHITECTURE.md §6.</span>
          </div>
          <div className="flex items-center gap-2">
            <Pill>planned</Pill>
            <span><b>Remote phone viewing / TV wall panel</b> — requires the encrypted remote-access milestone; not available yet.</span>
          </div>
        </div>
      </Card>

      {/* Audit */}
      <Card>
        <SectionTitle>Audit log <span className="normal-case font-normal">— last {audit.length}, no private media content</span></SectionTitle>
        <div className="text-xs font-mono space-y-1 max-h-72 overflow-y-auto">
          {audit.map((e, i) => (
            <div key={i} className="flex gap-3">
              <span className="muted">{new Date(e.at).toLocaleString()}</span>
              <span style={{ color: 'var(--accent)' }}>{e.action}</span>
              <span className="muted truncate">{e.detail}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

function GateRow({ title, desc, checked, confirming, onAsk, onCancel, onConfirm }: {
  title: string; desc: string; checked: boolean
  confirming: boolean; onAsk: () => void; onCancel: () => void; onConfirm: (on: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <Toggle checked={checked} onChange={v => {
        if (v) onAsk()          // enabling needs explicit confirmation
        else onConfirm(false)   // disabling is immediate
      }} />
      <div className="flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="muted text-xs">{desc}</div>
      </div>
      {checked && <Pill kind="ok">enabled</Pill>}
      {confirming && (
        <div className="fixed inset-0 z-50 grid place-items-center p-6" style={{ background: 'rgba(4,8,18,0.6)' }}>
          <div className="card p-6 max-w-md w-full">
            <div className="font-semibold mb-1">Enable “{title}”?</div>
            <div className="muted text-sm mb-4">{desc}</div>
            <div className="flex gap-2 justify-end">
              <button className="btn" onClick={onCancel}>Cancel</button>
              <button className="btn btn-primary" onClick={() => onConfirm(true)}>I understand — enable</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
