'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Tag = { id: number; name: string; color: string; uses?: number };
type Rec = {
  id: number;
  ref: string;
  sentAt: string;
  from: string;
  fromAddr: string;
  subject: string | null;
  snippet: string;
  body: string;
  category: string | null;
  events: any[];
  tags: Tag[];
  attachments: { filename: string }[];
  hasAttachment: boolean;
  link: string;
};

const CATS = [
  { key: 'logistics', label: 'Logistics', color: 'var(--moss)' },
  { key: 'legal', label: 'Legal', color: 'var(--blue)' },
  { key: 'hostile', label: 'Hostile', color: 'var(--oxblood)' },
  { key: 'fluff', label: 'Nothing in it', color: 'var(--ink-3)' },
];

const dayLabel = (d: string) =>
  new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '';
const longDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

export default function Page() {
  const [mode, setMode] = useState<'feed' | 'search'>('feed');

  const [query, setQuery] = useState('');
  const [sender, setSender] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [attached, setAttached] = useState<boolean | null>(null);

  const [tags, setTags] = useState<Tag[]>([]);
  const [rows, setRows] = useState<Rec[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [matched, setMatched] = useState<string[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [problem, setProblem] = useState('');
  const [toast, setToast] = useState('');

  const say = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 1800);
  };

  const loadTags = useCallback(async () => {
    const r = await fetch('/api/tags');
    if (r.ok) setTags((await r.json()).tags);
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const run = useCallback(
    async (opts: { feed?: boolean } = {}) => {
      setLoading(true);
      setProblem('');
      setReport(null);
      setOpen(null);
      try {
        const payload = opts.feed
          ? { query: '', limit: 60 }
          : {
              query,
              from: sender || null,
              dateFrom: dateFrom || null,
              dateTo: dateTo || null,
              tagIds,
              categories: cats,
              hasAttachment: attached,
              limit: 200,
            };
        const r = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'The search did not complete');
        setRows(d.rows);
        setStats(d.stats);
        setMatched(opts.feed ? null : d.termsUsed);
      } catch (e: any) {
        setProblem(e.message);
      } finally {
        setLoading(false);
      }
    },
    [query, sender, dateFrom, dateTo, tagIds, cats, attached]
  );

  useEffect(() => {
    run({ feed: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function switchTo(next: 'feed' | 'search') {
    setMode(next);
    run({ feed: next === 'feed' });
  }

  async function writeFinding() {
    setAsking(true);
    setProblem('');
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: query || 'Summarise these records.', rows, stats }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not write a finding');
      setReport(d);
    } catch (e: any) {
      setProblem(e.message);
    } finally {
      setAsking(false);
    }
  }

  async function toggleTag(rec: Rec, tag: Tag) {
    const on = rec.tags.some((t) => t.id === tag.id);
    setRows((prev) =>
      prev.map((r) =>
        r.id === rec.id
          ? { ...r, tags: on ? r.tags.filter((t) => t.id !== tag.id) : [...r.tags, tag] }
          : r
      )
    );
    await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: on ? 'detach' : 'attach', emailId: rec.id, tagId: tag.id }),
    });
    loadTags();
  }

  async function addLabel() {
    const name = prompt('Name the label');
    if (!name?.trim()) return;
    await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', name: name.trim() }),
    });
    loadTags();
  }

  const copy = (text: string, msg: string) => {
    navigator.clipboard.writeText(text);
    say(msg);
  };

  // Feed groups by day; search stays as one flat run so counts read straight.
  const grouped = useMemo(() => {
    if (mode !== 'feed') return null;
    const out: { day: string; items: Rec[] }[] = [];
    for (const r of rows) {
      const key = String(r.sentAt).slice(0, 10);
      const last = out[out.length - 1];
      if (last && last.day === key) last.items.push(r);
      else out.push({ day: key, items: [r] });
    }
    return out;
  }, [rows, mode]);

  const hostile = rows.filter((r) => r.category === 'hostile').length;
  const unlabelled = rows.filter((r) => !r.category).length;
  const bare = stats ? stats.total - stats.withAttachment : 0;

  const record = (r: Rec) => {
    const isOpen = open === r.id;
    return (
      <article
        className="rec"
        key={r.id}
        data-cat={r.category || 'null'}
        onClick={() => setOpen(isOpen ? null : r.id)}
      >
        <div className="edge" />

        <div className="stamp">
          <span className="ref mono">{r.ref}</span>
          <span className="date mono">{shortDate(r.sentAt)}</span>
        </div>

        <div className="core">
          <div className="subject">{r.subject || 'No subject'}</div>
          <div className="who">{r.from}</div>
          {!isOpen && <div className="snip">{r.snippet}</div>}
          {!isOpen && r.tags.length > 0 && (
            <div className="marks">
              {r.tags.map((t) => (
                <span className="mark" key={t.id} style={{ color: t.color }}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flank">
          <div className="clip" data-none={!r.hasAttachment}>
            {r.hasAttachment ? r.attachments.map((a) => a.filename).join(', ') : 'nothing attached'}
          </div>
        </div>

        {isOpen && (
          <div className="full" onClick={(e) => e.stopPropagation()}>
            <p className="body">{r.body || r.snippet}</p>

            <div className="tagline">
              <span>Labels</span>
              {tags.map((t) => {
                const on = r.tags.some((x) => x.id === t.id);
                return (
                  <button key={t.id} className="pill" data-on={on} onClick={() => toggleTag(r, t)}>
                    <span className="dot" style={{ background: t.color }} />
                    {t.name}
                  </button>
                );
              })}
            </div>

            <div className="tools">
              <button className="btn ghost tiny" onClick={() => copy(`[REF# ${r.ref}]`, `${r.ref} copied`)}>
                Copy {r.ref}
              </button>
              <a className="btn ghost tiny" href={r.link} target="_blank" rel="noreferrer">
                Open in Gmail
              </a>
              <span style={{ fontSize: 12.5, color: 'var(--ink-3)' }}>
                {longDate(r.sentAt)} · {r.fromAddr}
              </span>
            </div>
          </div>
        )}
      </article>
    );
  };

  return (
    <>
      <div className="band">
        <div className="band-inner">
          <h1>Casefile</h1>
          <div className="tally">
            <div>
              <b>{stats ? stats.total : '—'}</b>
              in view
            </div>
            <div className="hot">
              <b>{hostile}</b>
              hostile
            </div>
            <div>
              <b>{bare}</b>
              nothing attached
            </div>
            {unlabelled > 0 && (
              <div>
                <b>{unlabelled}</b>
                unlabelled
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="tabbar">
        <div className="tabbar-inner">
          <button className="tab" data-on={mode === 'feed'} onClick={() => switchTo('feed')}>
            What has arrived
          </button>
          <button className="tab" data-on={mode === 'search'} onClick={() => switchTo('search')}>
            Search the record
          </button>
        </div>
      </div>

      <div className="shell">
        <aside className="panel rail">
          <h2>{mode === 'feed' ? 'Jump to a search' : 'Narrow it down'}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setMode('search');
              run();
            }}
          >
            <div className="field">
              <label htmlFor="q">Words to look for</label>
              <input id="q" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="damp, moho" />
            </div>

            <div className="field">
              <label htmlFor="s">Sender contains</label>
              <input id="s" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="part of an address" />
            </div>

            <div className="field pair">
              <div>
                <label htmlFor="d1">From</label>
                <input id="d1" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor="d2">To</label>
                <input id="d2" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
              </div>
            </div>

            <div className="field">
              <label>Kind of message</label>
              <div className="pills">
                {CATS.map((c) => (
                  <button
                    type="button"
                    key={c.key}
                    className="pill"
                    data-on={cats.includes(c.key)}
                    onClick={() => setCats((p) => (p.includes(c.key) ? p.filter((x) => x !== c.key) : [...p, c.key]))}
                  >
                    <span className="dot" style={{ background: c.color }} />
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Labels</label>
              <div className="pills">
                {tags.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    className="pill"
                    data-on={tagIds.includes(t.id)}
                    onClick={() => setTagIds((p) => (p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id]))}
                  >
                    <span className="dot" style={{ background: t.color }} />
                    {t.name}
                    {t.uses ? <span className="count">{t.uses}</span> : null}
                  </button>
                ))}
                <button type="button" className="pill" onClick={addLabel}>
                  New label
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="att">Attachments</label>
              <select
                id="att"
                value={attached === null ? '' : String(attached)}
                onChange={(e) => setAttached(e.target.value === '' ? null : e.target.value === 'true')}
              >
                <option value="">Either way</option>
                <option value="true">Something attached</option>
                <option value="false">Nothing attached</option>
              </select>
            </div>

            <button className="btn" type="submit" disabled={loading} style={{ width: '100%' }}>
              {loading ? 'Looking' : 'Search records'}
            </button>
          </form>
        </aside>

        <main>
          {problem && <div className="warn">{problem}</div>}

          {mode === 'search' && stats && !loading && (
            <section className="panel finding">
              <p className="headline">
                {stats.total === 0 ? (
                  'Nothing matches those filters.'
                ) : (
                  <>
                    <span className="n">{stats.total}</span>
                    {stats.total === 1 ? ' message' : ' messages'}
                    {stats.firstSent && (
                      <>
                        , between <span className="n">{longDate(stats.firstSent)}</span> and{' '}
                        <span className="n">{longDate(stats.lastSent)}</span>
                      </>
                    )}
                    .{' '}
                    {bare === stats.total ? (
                      <span className="none">None had a document attached.</span>
                    ) : (
                      <>
                        <span className="n">{stats.withAttachment}</span> had a document attached.
                      </>
                    )}
                  </>
                )}
              </p>

              {matched && matched.length > 0 && (
                <div className="matched">Searched for: {matched.join(', ')}</div>
              )}

              {stats.total > 0 && (
                <div className="acts">
                  <button className="btn" onClick={writeFinding} disabled={asking}>
                    {asking ? 'Reading the records' : 'Write a finding'}
                  </button>
                  <button
                    className="btn ghost"
                    onClick={() =>
                      copy(
                        rows
                          .map((r) => `[REF# ${r.ref}] ${String(r.sentAt).slice(0, 10)} | ${r.subject || ''}`)
                          .join('\n'),
                        'Reference list copied'
                      )
                    }
                  >
                    Copy the reference list
                  </button>
                </div>
              )}
            </section>
          )}

          {report && (
            <section className="panel report">
              <h3>Finding</h3>
              <p>{report.finding}</p>
              {report.evidence_note && <p>{report.evidence_note}</p>}

              {report.timeline?.length > 0 && (
                <ol>
                  {report.timeline.map((t: any, i: number) => (
                    <li key={i}>
                      <span className="mono">{t.ref}</span> {t.date} — {t.what}
                    </li>
                  ))}
                </ol>
              )}

              {report.reply_draft && (
                <>
                  <h3>Suggested reply</h3>
                  <div className="draft">{report.reply_draft}</div>
                  <button className="btn ghost tiny" onClick={() => copy(report.reply_draft, 'Draft copied')}>
                    Copy the draft
                  </button>
                </>
              )}
            </section>
          )}

          {loading && (
            <div className="panel stack">
              {[0, 1, 2, 3, 4].map((i) => (
                <div className="ghostrow" key={i} />
              ))}
            </div>
          )}

          {!loading && rows.length === 0 && (
            <div className="panel blank">
              <strong>Nothing to show</strong>
              <p>
                {mode === 'feed'
                  ? 'No messages have been stored yet. Run the ingest worker and they will appear here.'
                  : 'Try fewer filters, or a different word. The sidebar shows which words were actually searched.'}
              </p>
            </div>
          )}

          {!loading && grouped && grouped.map((g) => (
            <div key={g.day}>
              <div className="daymark">{dayLabel(g.day)}</div>
              <div className="panel stack">{g.items.map(record)}</div>
            </div>
          ))}

          {!loading && !grouped && rows.length > 0 && (
            <div className="panel stack">{rows.map(record)}</div>
          )}
        </main>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
