'use client';
import { useState } from 'react';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (r.ok) window.location.href = '/';
    else setError((await r.json()).error);
  }

  return (
    <div className="gate">
      <div className="panel">
      <h1>Casefile</h1>
      <p>This holds private correspondence. Enter the password to continue.</p>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </div>
        {error && <div className="warn">{error}</div>}
        <button className="btn" type="submit" style={{ width: '100%' }}>Sign in</button>
      </form>
      </div>
    </div>
  );
}
