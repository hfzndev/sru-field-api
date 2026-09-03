'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '../_lib/api';
import { Alert, Field } from '../_components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.post('/api/admin/login', { username, password });
      // replace, not push: the back button should not return to a login form
      // that is now signed in.
      router.replace('/admin');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>SRU Field</h1>
        <div className="sub">Masuk sebagai admin</div>

        <Alert error={error} />

        <Field label="Username">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            required
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <button type="submit" className="btn-primary btn-block" disabled={busy}>
          {busy ? 'Memeriksa…' : 'Masuk'}
        </button>
      </form>
    </div>
  );
}
