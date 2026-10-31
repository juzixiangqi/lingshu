import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { getToken, login, register } from '../lib/api';

type Mode = 'login' | 'register';

export function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (getToken()) return <Navigate to="/" replace />;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await register(email, password, displayName);
      }
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={(event) => void handleSubmit(event)}>
        <h1>灵枢</h1>
        <p className="muted">{mode === 'login' ? '登录协同办公套件' : '创建灵枢账号'}</p>

        <label>
          邮箱
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label>
          密码
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'register' ? 8 : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {mode === 'register' ? (
          <label>
            显示昵称（可选）
            <input
              type="text"
              maxLength={40}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
        ) : null}

        {error ? <p className="error">{error}</p> : null}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>

        <button
          className="link-button"
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError('');
          }}
        >
          {mode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
        </button>
      </form>
    </div>
  );
}
