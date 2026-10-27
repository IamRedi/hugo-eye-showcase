import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type PersonProfile } from '../api'
import { useApp } from '../state'
import { Card, ConfirmButton, Pill, SectionTitle, Toggle } from '../components/ui'

/**
 * People — familiar-face management (Gate 6). Enrollment is explicit and
 * owner-driven: create a profile, add reference photos (upload or a live
 * camera snapshot), review quality, remove wrong references. The system
 * never labels unknown people by itself.
 */
export function People() {
  const { pushToast, cameras } = useApp()
  const camera = cameras[0]
  const [people, setPeople] = useState<PersonProfile[]>([])
  const [loaded, setLoaded] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const enrollTarget = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      setPeople((await api.people()).people)
      setLoaded(true)
    } catch { /* auth */ }
  }, [])
  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!newName.trim()) return
    try {
      const r = await api.createPerson(newName.trim())
      setNewName('')
      setCreating(false)
      setExpanded(r.person.id)
      pushToast('ok', `Profile "${r.person.name}" created — now enroll reference photos`)
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  const enrollFromFile = (personId: string) => {
    enrollTarget.current = personId
    fileInput.current?.click()
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    const personId = enrollTarget.current
    e.target.value = ''
    if (!file || !personId) return
    if (!/image\/(jpeg|jpg|png)/.test(file.type)) { pushToast('bad', 'Use a JPEG or PNG photo'); return }
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const r = await api.enrollFace(personId, { image: String(reader.result) })
        if (r.ok) {
          pushToast('ok', `Reference enrolled (quality ${(r.quality ?? 0).toFixed(2)}${r.ambiguity ? ', multiple faces found — first used' : ''})`)
        } else {
          pushToast('bad', r.error ?? 'enrollment failed')
        }
        load()
      } catch (e: any) { pushToast('bad', e.message) }
    }
    reader.readAsDataURL(file)
  }

  const enrollFromCamera = async (personId: string) => {
    if (!camera) { pushToast('bad', 'No camera available'); return }
    try {
      const r = await api.enrollFace(personId, { camera: camera.id })
      if (r.ok) pushToast('ok', `Snapshot enrolled (quality ${(r.quality ?? 0).toFixed(2)})`)
      else pushToast('bad', r.error ?? 'enrollment failed')
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  const toggleEnabled = async (p: PersonProfile, enabled: boolean) => {
    try {
      await api.updatePerson(p.id, { enabled })
      pushToast('ok', enabled ? `${p.name} included in recognition` : `${p.name} excluded from recognition`)
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  const removePerson = async (p: PersonProfile) => {
    try {
      await api.deletePerson(p.id)
      pushToast('ok', `${p.name} deleted with all references`)
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  const removeReference = async (p: PersonProfile, refId: string) => {
    try {
      await api.removeReference(p.id, refId)
      load()
    } catch (e: any) { pushToast('bad', e.message) }
  }

  if (!loaded) return null

  return (
    <div className="max-w-4xl mx-auto flex flex-col gap-4">
      <Card>
        <SectionTitle right={
          <button className="btn btn-primary" onClick={() => setCreating(v => !v)}>
            {creating ? 'Cancel' : 'Add person'}
          </button>
        }>
          Familiar people <span className="normal-case font-normal">— enrolled faces, recognized locally. Unknown people stay unknown.</span>
        </SectionTitle>
        <p className="muted text-xs">
          Recognition runs only when it is enabled in Intelligence and a profile is switched on below.
          Reference photos stay on this appliance and can be deleted at any time — deletion removes the
          stored face embedding too.
        </p>
        {creating && (
          <div className="mt-3 flex gap-2">
            <input className="input flex-1" placeholder="Name (e.g. Mom)" value={newName}
              onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} autoFocus />
            <button className="btn btn-primary" onClick={create} disabled={!newName.trim()}>Create</button>
          </div>
        )}
        <input ref={fileInput} type="file" accept="image/jpeg,image/png" className="hidden" onChange={onFile} />
      </Card>

      {people.length === 0 && (
        <Card><div className="muted">No profiles yet. Add a person, then enroll one or more clear face photos.</div></Card>
      )}

      {people.map(p => (
        <Card key={p.id}>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-sm font-semibold">{p.name}</div>
              <div className="muted text-xs">{p.referenceCount ?? p.references.length} reference photo(s) · added {new Date(p.createdAt).toLocaleDateString()}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="muted text-xs">in recognition</span>
              <Toggle checked={p.enabled} onChange={v => toggleEnabled(p, v)} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <button className="btn" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
              {expanded === p.id ? 'Hide references' : 'Manage references'}
            </button>
            <button className="btn" onClick={() => enrollFromFile(p.id)}>Enroll photo…</button>
            {camera && <button className="btn" onClick={() => enrollFromCamera(p.id)}>Enroll from camera now</button>}
            <ConfirmButton confirmText={`Delete ${p.name} + references?`}
              onConfirm={() => removePerson(p)}>Delete profile</ConfirmButton>
          </div>
          {expanded === p.id && (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
              {p.references.map(ref => (
                <div key={ref.id} className="relative rounded-xl overflow-hidden" style={{ background: 'var(--bg-soft)' }}>
                  <img src={ref.imageUrl} className="w-full aspect-square object-cover" alt="reference" />
                  <div className="absolute top-1 left-1"><Pill kind={ref.quality > 0.7 ? 'ok' : 'default'}>{ref.quality.toFixed(2)}</Pill></div>
                  <button className="absolute top-1 right-1 rounded-full text-xs"
                    style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', width: 22, height: 22 }}
                    onClick={() => removeReference(p, ref.id)}>✕</button>
                  <div className="absolute bottom-0 inset-x-0 text-center text-[10px] py-0.5" style={{ background: 'rgba(0,0,0,0.5)', color: '#fff' }}>
                    {ref.source}
                  </div>
                </div>
              ))}
              {p.references.length === 0 && (
                <div className="col-span-full muted text-sm">No references yet — enroll a clear, front-facing photo.</div>
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  )
}
