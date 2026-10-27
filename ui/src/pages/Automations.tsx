import { useCallback, useEffect, useState } from 'react'
import { api, type Automation, type AutomationRule, type ProductSettings } from '../api'
import { useApp } from '../state'
import { Card, ConfirmButton, Pill, SectionTitle, Toggle } from '../components/ui'

export function Automations() {
  const { pushToast } = useApp()
  const [automations, setAutomations] = useState<Automation[]>([])
  const [settings, setSettings] = useState<ProductSettings | null>(null)

  const load = useCallback(async () => {
    try {
      setAutomations((await api.automations()).automations)
      setSettings((await api.settings()).settings)
    } catch { /* */ }
  }, [])
  useEffect(() => { load() }, [load])

  const setEnabled = async (id: string, enabled: boolean, seconds?: number) => {
    try {
      await api.patchAutomation({ id, enabled, seconds })
      pushToast('ok', `Automation ${enabled ? 'enabled' : 'disabled'}`)
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  const enabledIf = (requires: string[]) => requires.every(r => {
    if (r === 'aiEnabled') return settings?.privacy.aiEnabled
    if (r === 'recordingEnabled') return settings?.privacy.recordingEnabled
    return true
  })

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-4">
      <Card>
        <SectionTitle>Bounded event → action rules</SectionTitle>
        <p className="muted text-sm mb-3">
          Automations run locally on this appliance with strict limits (cooldowns, single slot, bounded
          duration). They only fire while their required privacy gates are enabled.
        </p>
        <div className="flex flex-col gap-3">
          {automations.map(a => {
            const usable = enabledIf(a.requires)
            return (
              <div key={a.id} className="flex items-start gap-3 p-3 rounded-xl" style={{ background: 'var(--bg-soft)' }}>
                <Toggle checked={a.enabled} disabled={!usable}
                  onChange={v => setEnabled(a.id, v, a.configurable?.seconds ? settings?.automations.motionRecord.seconds : undefined)} />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{a.label}</span>
                    {!usable && <Pill kind="warn">requires {a.requires.join(' + ')}</Pill>}
                    {a.enabled && usable && <Pill kind="ok">armed</Pill>}
                  </div>
                  <div className="muted text-xs mt-0.5">{a.description}</div>
                  {a.id === 'motion_record' && a.enabled && usable && (
                    <label className="text-xs muted block mt-2">
                      Recording length:
                      <input type="number" min={5} max={300} className="input inline-block w-24 ml-2 py-1"
                        value={settings?.automations.motionRecord.seconds ?? 30}
                        onChange={e => setEnabled('motion_record', true, Number(e.target.value))} /> seconds
                    </label>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <RulesCard />
    </div>
  )
}

const EVENT_TYPES = ['person', 'person_known', 'person_unknown', 'object', 'motion', 'entered_zone', 'exited_zone', 'stream.lost', 'stream.recovered']

function RulesCard() {
  const { pushToast, cameras } = useApp()
  const [rules, setRules] = useState<AutomationRule[]>([])
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<any>({
    name: '', conditions: { eventType: 'person', minConfidence: 0.6 }, actions: [{ type: 'notify' }], cooldownSec: 60,
  })
  const [testResult, setTestResult] = useState<Record<string, any>>({})

  const load = useCallback(async () => {
    try { setRules((await api.rules()).rules) } catch { /* */ }
  }, [])
  useEffect(() => { load() }, [load])

  const create = async () => {
    try {
      await api.createRule(draft)
      setCreating(false)
      setDraft({ name: '', conditions: { eventType: 'person', minConfidence: 0.6 }, actions: [{ type: 'notify' }], cooldownSec: 60 })
      pushToast('ok', 'Rule created')
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  const test = async (id: string) => {
    try {
      const r = await api.testRule(id)
      setTestResult(prev => ({ ...prev, [id]: r.matched ? `matched (dry run, no actions executed)` : 'did not match the test event' }))
    } catch (e: any) { setTestResult(prev => ({ ...prev, [id]: e.message })) }
  }

  return (
    <Card>
      <SectionTitle right={<button className="btn btn-primary" onClick={() => setCreating(v => !v)}>{creating ? 'Cancel' : 'New rule'}</button>}>
        Event rules <span className="normal-case font-normal">— if conditions match a live event, run actions (cooldown-limited, audited)</span>
      </SectionTitle>
      {creating && (
        <div className="p-3 rounded-xl mt-3 flex flex-col gap-3" style={{ background: 'var(--bg-soft)' }}>
          <input className="input" placeholder="Rule name (e.g. Warn when someone enters at night)" value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <div className="grid sm:grid-cols-3 gap-3 text-sm">
            <label>When event
              <select className="input mt-1" value={draft.conditions.eventType}
                onChange={e => setDraft({ ...draft, conditions: { ...draft.conditions, eventType: e.target.value } })}>
                {EVENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label>Class / label
              <input className="input mt-1" placeholder="person" value={draft.conditions.label ?? ''}
                onChange={e => setDraft({ ...draft, conditions: { ...draft.conditions, label: e.target.value || undefined } })} />
            </label>
            <label>Familiarity
              <select className="input mt-1" value={draft.conditions.familiarity ?? 'any'}
                onChange={e => setDraft({ ...draft, conditions: { ...draft.conditions, familiarity: e.target.value } })}>
                <option value="any">any</option>
                <option value="known">known person</option>
                <option value="unknown">unknown person</option>
              </select>
            </label>
            <label>Min confidence
              <input type="number" step="0.05" min="0" max="1" className="input mt-1" value={draft.conditions.minConfidence ?? 0.6}
                onChange={e => setDraft({ ...draft, conditions: { ...draft.conditions, minConfidence: Number(e.target.value) } })} />
            </label>
            <label>Active from
              <input type="time" className="input mt-1" value={draft.conditions.timeWindow?.from ?? '00:00'}
                onChange={e => setDraft({ ...draft, conditions: { ...draft.conditions, timeWindow: { from: e.target.value, to: draft.conditions.timeWindow?.to ?? '23:59' } } })} />
            </label>
            <label>Until
              <input type="time" className="input mt-1" value={draft.conditions.timeWindow?.to ?? '23:59'}
                onChange={e => setDraft({ ...draft, conditions: { ...draft.conditions, timeWindow: { from: draft.conditions.timeWindow?.from ?? '00:00', to: e.target.value } } })} />
            </label>
          </div>
          <div className="text-sm">Then:
            <div className="flex flex-wrap gap-3 mt-2">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={draft.actions.some((a: any) => a.type === 'notify')}
                  onChange={e => setDraft({ ...draft, actions: mergeAction(draft.actions, 'notify', e.target.checked, { message: '' }) })} />
                notify
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={draft.actions.some((a: any) => a.type === 'snapshot')}
                  onChange={e => setDraft({ ...draft, actions: mergeAction(draft.actions, 'snapshot', e.target.checked, { zone: 'rule' }) })} />
                snapshot
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={draft.actions.some((a: any) => a.type === 'record')}
                  onChange={e => setDraft({ ...draft, actions: mergeAction(draft.actions, 'record', e.target.checked, { seconds: 30 }) })} />
                <span>record</span>
                {draft.actions.some((a: any) => a.type === 'record') && (
                  <input type="number" min={5} max={300} className="input inline-block w-20 py-0.5 ml-1"
                    value={draft.actions.find((a: any) => a.type === 'record')?.seconds ?? 30}
                    onChange={e => setDraft({ ...draft, actions: draft.actions.map((a: any) => a.type === 'record' ? { ...a, seconds: Number(e.target.value) } : a) })} />
                )}
                {draft.actions.some((a: any) => a.type === 'record') && <span>s</span>}
              </label>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="number" className="input w-28" min={5} max={86400} value={draft.cooldownSec}
              onChange={e => setDraft({ ...draft, cooldownSec: Number(e.target.value) })} /> <span className="muted text-sm">s cooldown</span>
            <button className="btn btn-primary ml-auto" onClick={create} disabled={!draft.name.trim() || draft.actions.length === 0}>Create rule</button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 mt-3">
        {rules.map(r => (
          <div key={r.id} className="p-3 rounded-xl" style={{ background: 'var(--bg-soft)' }}>
            <div className="flex items-center gap-2">
              <Toggle checked={r.enabled} onChange={async v => { await api.updateRule(r.id, { enabled: v }); load() }} />
              <span className="text-sm font-medium flex-1">{r.name}</span>
              <button className="btn" onClick={() => test(r.id)}>Test</button>
              <ConfirmButton confirmText="Delete rule?" onConfirm={async () => { await api.deleteRule(r.id); load() }}>Delete</ConfirmButton>
            </div>
            <div className="muted text-xs mt-1">
              when {describeConditions(r.conditions)} → {r.actions.map(a => a.type + (a.type === 'record' ? ` ${a.seconds}s` : '')).join(', ')} · cooldown {r.cooldownSec}s
              {r.fireCount > 0 && ` · fired ${r.fireCount}×`}
              {r.lastError && <span style={{ color: 'var(--bad)' }}> · last error: {r.lastError}</span>}
            </div>
            {testResult[r.id] && <div className="text-xs mt-1" style={{ color: 'var(--accent)' }}>{testResult[r.id]}</div>}
          </div>
        ))}
        {rules.length === 0 && <div className="muted text-sm">No rules yet — create one to react to real events.</div>}
      </div>
    </Card>
  )
}

function mergeAction(actions: any[], type: string, on: boolean, template: any) {
  if (on) return [...actions.filter(a => a.type !== type), template]
  return actions.filter(a => a.type !== type)
}

function describeConditions(c: any): string {
  const parts = []
  if (c.eventType) parts.push(c.eventType)
  if (c.label) parts.push(`label=${c.label}`)
  if (c.zone) parts.push(`zone=${c.zone}`)
  if (c.familiarity && c.familiarity !== 'any') parts.push(c.familiarity)
  if (c.minConfidence !== undefined) parts.push(`conf≥${c.minConfidence}`)
  if (c.timeWindow) parts.push(`between ${c.timeWindow.from}–${c.timeWindow.to}`)
  return parts.join(', ') || 'any event'
}
