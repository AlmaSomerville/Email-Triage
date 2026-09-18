'use client';

import { useCallback, useEffect, useState } from 'react';

type Tag = { id: number; name: string; color: string; uses?: number };
type Rec = {
  id: number;
  ref: string;
  sentAt: string;
  from: string;
  fromAddr: string;
  subject: string | null;
  snippet: string;
  category: string | null;
  tags: Tag[];
  attachments: { filename: string }[];
  hasAttachment: boolean;
  link: string;
};

const CATEGORIES = ['logistics', 'legal', 'hostile', 'fluff'];

const day = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';

export default function Page() {
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [attachedOnly, setAttachedOnly] = useState<boolean | null>(null);

  const [tags, setTags] = useState<Tag[]>([]);
  const [rows, setRows] = useState<Rec[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [termsUsed, setTermsUsed] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState<any>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');

  const flash = (m: string) => {
    setNote(m);
    setTimeout(() => setNote(''), 1600);
  };

  const loadTags = useCallback(async () => {
    const r = await fetch('/api/tags');
    if (r.ok) setTags((await r.json()).tags);
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const search = useCallback(async () => {
    setBusy(true);
    setError('');
    setAnswer(null);
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          from: from || null,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
          tagIds,
          categories,
          hasAttachment: attachedOnly,
          limit: 150,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Search failed');
      setRows(d.rows);
      setStats(d.stats);
      setTermsUsed(d.termsUsed);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, [query, from, dateFrom, dateTo, tagIds, categories, attachedOnly]);

  useEffect(() => {
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ask() {
    setAsking(true);
    setError('');
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: query || 'Summarise these records.', rows, stats }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not build a finding');
      setAnswer(d);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAsking(false);
    }
  }

  async function toggleTag(rec: Rec, tag: Tag) {
    const on = rec.tags.some((t) => t.id === tag.id);
    await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: on ? 'detach' : 'attach', emailId: rec.id, tagId: tag.id }),
    });
    setRows((prev) =>
      prev.map((r) =>
        r.id === rec.id
          ? { ...r, tags: on ? r.tags.filter((t) => t.id !== tag.id) : [...r.tags, tag] }
          : r
      )
    );
    loadTags();
  }

  async function newTag() {
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
    flash(msg);
  };

  const unsupported = stats ? stats.total - stats.withAttachment : 0;

  return (
    <>
      <header className="masthead">
        <h1>Casefile</h1>
        <span className="sub">{note || (stats ? `${stats.total} records in view` : '')}</span>
      </header>

      <div className="frame">
        <aside className="rail">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
          >
            <div className="field">
              <label htmlFor="q">Words to look for</label>
              <input
                id="q"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="damp, moho, chronic"
              />
            </div>

            <div className="field">
              <label htmlFor="sender">Sender contains</label>
              <input
                id="sender"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="part of an address"
              />
            </div>

            <div className="field row2">
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
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {CATEGORIES.map((c) => (
                  <button
                    type="button"
                    key={c}
                    className="chip"
                    data-on={categories.includes(c)}
                    style={{ color: categories.includes(c) ? 'var(--blue)' : undefined }}
                    onClick={() =>
                      setCategories((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))
                    }
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <div className="field">
              <label>Labels</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tags.map((t) => (
                  <button
                    type="button"
                    key={t.id}
                    className="chip"
                    data-on={tagIds.includes(t.id)}
                    style={{ color: tagIds.includes(t.id) ? t.color : undefined }}
                    onClick={() =>
                      setTagIds((p) => (p.includes(t.id) ? p.filter((x) => x !== t.id) : [...p, t.id]))
                    }
                  >
                    <span className="dot" style={{ background: t.color }} />
                    {t.name}
                    {t.uses ? <span className="mono" style={{ opacity: 0.6 }}>{t.uses}</span> : null}
                  </button>
                ))}
                <button type="button" className="chip" onClick={newTag}>
                  Add a label
                </button>
              </div>
            </div>

            <div className="field">
              <label htmlFor="att">Attachments</label>
              <select
                id="att"
                value={attachedOnly === null ? '' : String(attachedOnly)}
                onChange={(e) =>
                  setAttachedOnly(e.target.value === '' ? null : e.target.value === 'true')
                }
              >
                <option value="">Any</option>
                <option value="true">Something attached</option>
                <option value="false">Nothing attached</option>
              </select>
            </div>

            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Searching' : 'Search records'}
            </button>
          </form>
        </aside>

        <main className="main">
          {error && <div className="error">{error}</div>}

          {stats && (
            <section className="finding">
              <p>
                {stats.total === 0 ? (
                  'No records match these filters.'
                ) : (
                  <>
                    <span className="n">{stats.total}</span>
                    {stats.total === 1 ? ' message' : ' messages'}
                    {stats.firstSent && (
                      <>
                        , between <span className="n">{day(stats.firstSent)}</span> and{' '}
                        <span className="n">{day(stats.lastSent)}</span>
                      </>
                    )}
                    .{' '}
                    {unsupported === stats.total
                      ? 'None had a document attached.'
                      : `${stats.withAttachment} of them had a document attached.`}
                  </>
                )}
              </p>
              {termsUsed && termsUsed.length > 0 && (
                <div className="terms">
                  Matched on: {termsUsed.join(', ')}
                </div>
              )}
              {stats.total > 0 && (
                <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                  <button className="btn quiet" onClick={ask} disabled={asking}>
                    {asking ? 'Reading the records' : 'Write a finding from these'}
                  </button>
                  <button
                    className="btn quiet"
                    onClick={() =>
                      copy(
                        rows
                          .map(
                            (r) =>
                              `[REF# ${r.ref}] ${String(r.sentAt).slice(0, 10)} | ${r.subject || ''}`
                          )
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

          {answer && (
            <section className="answer">
              <h2>Finding</h2>
              <p>{answer.finding}</p>
              {answer.evidence_note && <p>{answer.evidence_note}</p>}
              {answer.timeline?.length > 0 && (
                <ol>
                  {answer.timeline.map((t: any, i: number) => (
                    <li key={i}>
                      <span className="mono">{t.ref}</span> {t.date} — {t.what}
                    </li>
                  ))}
                </ol>
              )}
              {answer.reply_draft && (
                <>
                  <h2>Suggested reply</h2>
                  <div className="draft">{answer.reply_draft}</div>
                  <button
                    className="btn quiet"
                    style={{ marginTop: 10 }}
                    onClick={() => copy(answer.reply_draft, 'Draft copied')}
                  >
                    Copy the draft
                  </button>
                </>
              )}
            </section>
          )}

          <section className="ledger">
            {rows.length === 0 && !busy && (
              <p className="empty">
                Nothing here yet. If you have not run the ingest worker, start there — the ledger
                fills up as messages arrive.
              </p>
            )}

            {rows.map((r) => (
              <article className="rec" key={r.id} data-cat={r.category || 'fluff'}>
                <button
                  className="ref mono"
                  title="Copy this reference"
                  onClick={() => copy(`[REF# ${r.ref}]`, `${r.ref} copied`)}
                >
                  {r.ref}
                </button>
                <span className="when mono">{day(r.sentAt)}</span>

                <div>
                  <div className="subject">{r.subject || '(no subject)'}</div>
                  <div className="snip">{r.snippet}</div>
                  <div className="meta">
                    <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{r.fromAddr}</span>
                    {tags.map((t) => {
                      const on = r.tags.some((x) => x.id === t.id);
                      return (
                        <button
                          key={t.id}
                          className="chip"
                          data-on={on}
                          style={{ color: on ? t.color : 'var(--ink-soft)', opacity: on ? 1 : 0.55 }}
                          onClick={() => toggleTag(r, t)}
                        >
                          <span className="dot" style={{ background: t.color }} />
                          {t.name}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="side">
                  <span className="paper" data-none={!r.hasAttachment}>
                    {r.hasAttachment
                      ? r.attachments.map((a) => a.filename).join(', ')
                      : 'nothing attached'}
                  </span>
                  <a href={r.link} target="_blank" rel="noreferrer">
                    Open in Gmail
                  </a>
                </div>
              </article>
            ))}
          </section>
        </main>
      </div>
    </>
  );
}
