import { useEffect, useMemo, useState } from 'react'
import { api, fmtDateTime } from '../api'
import type { SearchHit } from '../api'
import { Card, Pill, Spinner } from '../components/ui'
import { useApp } from '../state'

const TYPE_FILTERS = ['', 'person', 'person_known', 'person_unknown', 'object', 'visit.summary']

export function SearchPage() {
  const { cameras } = useApp()
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [type, setType] = useState('')
  const [camera, setCamera] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [scanned, setScanned] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<any>(null)
  const [reindexing, setReindexing] = useState(false)
  const [preview, setPreview] = useState<SearchHit | null>(null)

  const loadStatus = () => api.searchStatus().then(setStatus).catch(() => setStatus(null))
  useEffect(() => { loadStatus() }, [])

  const run = async (q: string) => {
    setBusy(true)
    setError(null)
    try {
      const params: Record<string, string | number> = { limit: 60 }
      if (q) params.q = q
      if (type) params.type = type
      if (camera) params.camera = camera
      const res = await api.search(params)
      setHits(res.results ?? [])
      setScanned(res.scanned ?? null)
      setSubmitted(q)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { run('') /* initial: recent indexed evidence */ }, [])

  const reindex = async () => {
    setReindexing(true)
    try {
      await api.searchReindex(1000)
      await loadStatus()
      await run(submitted)
    } finally {
      setReindexing(false)
    }
  }

  const indexPct = useMemo(() => {
    if (!status?.indexable) return null
    return Math.round((status.indexed / status.indexable) * 100)
  }, [status])

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-lg font-bold">Search</h2>
            <p className="text-xs muted">Describe what happened — results are real evidence images, ranked semantically.</p>
          </div>
          <div className="flex items-center gap-2">
            {status && (
              <Pill kind={status.availability.runtime && status.availability.model ? 'ok' : 'warn'}>
                {status.indexed}/{status.indexable} indexed{indexPct !== null ? ` (${indexPct}%)` : ''}
              </Pill>
            )}
            <button className="btn-ghost text-xs" onClick={reindex} disabled={reindexing || !status}>
              {reindexing ? <Spinner /> : 'Reindex'}
            </button>
          </div>
        </div>

        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); run(query) }}>
          <input
            className="input flex-1"
            placeholder='e.g. "someone entered carrying something" · "person on the sofa" · "a dog"'
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <button className="btn-primary" disabled={busy}>{busy ? <Spinner /> : 'Search'}</button>
        </form>

        <div className="flex flex-wrap gap-2 mt-3">
          <select className="input text-xs w-auto" value={type} onChange={e => { setType(e.target.value); setTimeout(() => run(query), 0) }}>
            {TYPE_FILTERS.map(t => <option key={t} value={t}>{t === '' ? 'All event types' : t}</option>)}
          </select>
          <select className="input text-xs w-auto" value={camera} onChange={e => { setCamera(e.target.value); setTimeout(() => run(query), 0) }}>
            <option value="">All cameras</option>
            {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {submitted && <span className="text-xs muted self-center">query: "{submitted}" {scanned !== null && `· scanned ${scanned} indexed events`}</span>}
        </div>
        {error && <p className="text-xs mt-2" style={{ color: 'var(--danger)' }}>{error}</p>}
      </Card>

      {hits.length === 0 && !busy && (
        <Card><p className="muted text-sm">No indexed evidence{submitted ? ' matches this query' : ' yet'}{status && !status.availability.model ? ' — the search model is not installed (run npm run ai:setup)' : ''}.</p></Card>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
        {hits.map(hit => (
          <button key={hit.id} className="text-left rounded-xl overflow-hidden panel border hover:border-[var(--accent)] transition-colors"
            onClick={() => setPreview(hit)}>
            <div className="aspect-video bg-black/40 relative">
              {hit.thumbUrl
                ? <img src={hit.thumbUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
                : <div className="w-full h-full grid place-items-center muted text-xs">no image</div>}
              {hit.score !== null && (
                <span className="absolute top-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-black/70 text-white">
                  {(hit.score * 100).toFixed(0)}%
                </span>
              )}
              <span className="absolute bottom-1.5 left-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-black/70 text-white">{hit.type}</span>
            </div>
            <div className="p-2">
              <div className="text-[11px] muted">{fmtDateTime(hit.at)} · {cameras.find(c => c.id === hit.cameraId)?.name ?? hit.cameraId}</div>
              <div className="text-xs mt-0.5 line-clamp-2">{hit.description || hit.detail}</div>
              {hit.personName && <div className="text-xs mt-1" style={{ color: 'var(--accent)' }}>{hit.personName}</div>}
            </div>
          </button>
        ))}
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4" onClick={() => setPreview(null)}>
          <div className="panel border rounded-2xl max-w-2xl w-full overflow-hidden" onClick={e => e.stopPropagation()}>
            {preview.thumbUrl && <img src={preview.thumbUrl} alt="" className="w-full max-h-[55vh] object-contain bg-black" />}
            <div className="p-4 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Pill kind="accent">{preview.type}</Pill>
                <span className="text-xs muted">{fmtDateTime(preview.at)}</span>
                {preview.score !== null && <Pill kind="ok">match {(preview.score * 100).toFixed(0)}%</Pill>}
                <Pill>{preview.provenance}</Pill>
              </div>
              <p className="text-sm">{preview.description || preview.detail}</p>
              {preview.personName && <p className="text-xs muted">Person: {preview.personName}</p>}
              <div className="flex gap-2 pt-1">
                {preview.recording && (
                  <a className="btn-ghost text-xs" href={`/api/recordings/${previewGroup(preview)}/file`} target="_blank" rel="noreferrer">
                    {preview.recording.covering ? 'Open covering recording' : 'Open nearest recording'}
                  </a>
                )}
                <button className="btn-ghost text-xs" onClick={() => setPreview(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function previewGroup(hit: SearchHit): string {
  return hit.recording?.groupId ?? ''
}
