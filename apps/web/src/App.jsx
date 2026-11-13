import { lazy, Suspense, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { ApiError, getBackendStatus } from './lib/api.js';
import { createCustomerAccount, fetchAccount, fetchAccountBalance, fetchAccounts, formatAccountDate, formatPaiseAsINR } from './lib/accounts.js';
import { fetchAccountStatement, navigationForRole } from './lib/ledger.js';

const FinancialTransactionPage = lazy(() => import('./components/FinancialTransactionPage.jsx'));
const StatementEvent = lazy(() => import('./components/LedgerPages.jsx').then((module) => ({ default: module.StatementEvent })));
const StatementPage = lazy(() => import('./components/LedgerPages.jsx').then((module) => ({ default: module.StatementPage })));
const TransferDetailsPage = lazy(() => import('./components/LedgerPages.jsx').then((module) => ({ default: module.TransferDetailsPage })));
const AuditPage = lazy(() => import('./components/LedgerPages.jsx').then((module) => ({ default: module.AuditPage })));

function navigate(path, replace = false) {
  if (window.location.pathname !== path) {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
}

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return pathname;
}

function Icon({ name, size = 20 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  const shapes = {
    grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
    cards: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 10h18M7 15h3" /></>,
    activity: <><path d="M3 12h4l2.3-6 4.4 12 2.3-6H21" /></>,
    shield: <><path d="M12 3 20 6v5c0 5-3.3 8.2-8 10-4.7-1.8-8-5-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></>,
    eye: <><path d="M2.5 12s3.3-6 9.5-6 9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>,
    eyeOff: <><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" /><path d="M9.9 5.2A10.9 10.9 0 0 1 12 5c6.2 0 9.5 7 9.5 7a15 15 0 0 1-2.6 3.4M6.2 6.2C3.8 7.8 2.5 12 2.5 12s3.3 7 9.5 7c1.2 0 2.2-.2 3.1-.6" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    building: <><path d="M4 21V5l8-3 8 3v16M2 21h20M8 8h1m6 0h1M8 12h1m6 0h1M10 21v-5h4v5" /></>,
  };
  return <svg {...common}>{shapes[name] ?? shapes.grid}</svg>;
}

function Brand({ inverse = false }) {
  return (
    <a href="/dashboard" onClick={(event) => { event.preventDefault(); navigate('/dashboard'); }} className={`brand ${inverse ? 'brand-inverse' : ''}`} aria-label="BalanceVault dashboard">
      <span className="brand-mark">b<span>.</span></span>
      <span className="brand-word">balancevault</span>
    </a>
  );
}

function PasswordField({ label = 'Password', value, onChange, autoComplete = 'current-password', hint }) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="field-label">
      <span>{label}</span>
      <span className="password-input-wrap">
        <input
          required
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          minLength={autoComplete === 'new-password' ? 12 : 1}
          maxLength={72}
          placeholder={autoComplete === 'new-password' ? 'At least 12 characters' : 'Enter your password'}
        />
        <button className="password-toggle" type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? 'Hide password' : 'Show password'}>
          <Icon name={visible ? 'eyeOff' : 'eye'} size={18} />
        </button>
      </span>
      {hint && <small className="field-hint">{hint}</small>}
    </label>
  );
}

function AuthPage({ mode }) {
  const isRegister = mode === 'register';
  const isInvitation = mode === 'invitation';
  const { login, register, acceptInvitation } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    if ((isRegister || isInvitation) && password.length < 12) {
      setError('Use a password with at least 12 characters.');
      return;
    }
    if ((isRegister || isInvitation) && password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      if (isRegister) await register({ name, email, password });
      else if (isInvitation) {
        const token = window.location.hash.slice(1);
        if (!token) throw new Error('Invitation token is missing. Open the complete invitation link.');
        await acceptInvitation({ token, password });
      }
      else await login({ email, password });
      setPassword('');
      setConfirmation('');
      navigate('/dashboard', true);
    } catch (requestError) {
      setError(requestError instanceof ApiError ? requestError.message : 'We could not sign you in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="BalanceVault introduction">
        <div className="auth-story-top"><Brand inverse /><span className="story-status"><i /> Secure ledger platform</span></div>
        <div className="story-copy">
          <p className="eyebrow">Money, accounted for.</p>
          <h1>Confidence in every<br /><em>transaction.</em></h1>
          <p className="story-description">A clearer view of your accounts, built on a ledger where every entry has its place.</p>
        </div>
        <div className="ledger-art" aria-hidden="true">
          <div className="ledger-orbit orbit-one" /><div className="ledger-orbit orbit-two" />
          <div className="ledger-card"><div className="ledger-card-top"><span>BV / PRIVATE LEDGER</span><span className="ledger-dot" /></div><div className="ledger-lines"><i /><i /><i /></div><div className="ledger-card-foot"><span>SECURE BY DESIGN</span><Icon name="shield" size={20} /></div></div>
          <div className="ledger-chip chip-top">01 <span>Verified access</span></div>
          <div className="ledger-chip chip-bottom"><span className="chip-check">✓</span> Every entry accountable</div>
        </div>
        <div className="story-footer"><span>Private by design</span><span>Built around financial integrity</span></div>
      </section>

      <section className="auth-form-side">
        <div className="auth-mobile-brand"><Brand /></div>
        <div className="auth-form-card">
          <div className="form-heading">
            <span className="form-kicker">{isRegister ? 'GET STARTED' : isInvitation ? 'SECURE INVITATION' : 'WELCOME BACK'}</span>
            <h2>{isRegister ? 'Create your account' : isInvitation ? 'Set your password' : 'Sign in to your vault'}</h2>
            <p>{isRegister ? 'Set up your secure account in a few steps.' : isInvitation ? 'Choose a password to activate your invited BalanceVault role.' : 'Your accounts, clearly in view.'}</p>
          </div>

          <form className="auth-form" onSubmit={handleSubmit}>
            {isRegister && <label className="field-label"><span>Full name</span><input required type="text" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={100} placeholder="Your name" /></label>}
            {!isInvitation && <label className="field-label"><span>Email address</span><input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" maxLength={254} placeholder="you@example.com" /></label>}
            {!isInvitation && <PasswordField value={password} onChange={setPassword} autoComplete={isRegister ? 'new-password' : 'current-password'} hint={isRegister ? 'Use 12 or more characters.' : null} />}
            {isInvitation && <PasswordField label="New password" value={password} onChange={setPassword} autoComplete="new-password" hint="Use 12 or more characters." />}
            {(isRegister || isInvitation) && <PasswordField label="Confirm password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" hint={null} />}
            {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
            <button className="button button-primary auth-submit" type="submit" disabled={submitting}>
              {submitting ? <><span className="spinner" />{isRegister ? 'Creating account…' : isInvitation ? 'Accepting invitation…' : 'Signing in…'}</> : <>{isRegister ? 'Create account' : isInvitation ? 'Accept invitation' : 'Sign in'}<Icon name="arrow" size={18} /></>}
            </button>
          </form>

          {!isInvitation && <p className="auth-switch">{isRegister ? 'Already have an account?' : 'New to BalanceVault?'} <button type="button" onClick={() => navigate(isRegister ? '/login' : '/register')}>{isRegister ? 'Sign in' : 'Create an account'}</button></p>}
          <div className="secure-note"><Icon name="lock" size={15} /><span>Your connection is protected. We never display or store your password in the browser after signing in.</span></div>
        </div>
        <p className="auth-legal">BalanceVault · Secure financial ledger</p>
      </section>
    </main>
  );
}

function BackendBadge() {
  const [status, setStatus] = useState('checking');
  useEffect(() => {
    const controller = new AbortController();
    getBackendStatus(controller.signal).then((available) => setStatus(available ? 'online' : 'offline')).catch(() => {});
    const interval = window.setInterval(() => {
      getBackendStatus(controller.signal).then((available) => setStatus(available ? 'online' : 'offline')).catch(() => {});
    }, 30_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, []);
  const label = { checking: 'Checking system', online: 'Systems operational', offline: 'Connection unavailable' }[status];
  return <div className={`backend-badge backend-${status}`} title="Database readiness status"><i />{label}</div>;
}

const roleLabels = { ADMIN: 'Administrator', ACCOUNT_HOLDER: 'Account holder', AUDITOR: 'Auditor' };

function AppShell({ pathname, forbidden = false }) {
  const { user, logout, request, updateUser, accountRefreshVersion, refreshAccounts, selectedAccountId, setSelectedAccountId } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => setMobileMenuOpen(false), [pathname]);

  const navItems = navigationForRole(user?.role);

  function signOut() {
    logout();
    navigate('/login', true);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand"><Brand inverse /><button className="mobile-close" onClick={() => setMobileMenuOpen(false)} aria-label="Close navigation">×</button></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map((item) => <a key={item.path} href={item.path} aria-current={pathname === item.path ? 'page' : undefined} className={`nav-link ${pathname === item.path ? 'nav-active' : ''}`} onClick={(event) => { event.preventDefault(); navigate(item.path); }}><Icon name={item.icon} /><span>{item.label}</span>{item.path === '/accounts' && <span className="nav-chevron">›</span>}</a>)}
        </nav>
        <div className="sidebar-bottom"><div className="sidebar-security"><span className="security-icon"><Icon name="shield" size={17} /></span><div><strong>Protected ledger</strong><small>Secure by design</small></div><span className="security-check">✓</span></div><div className="sidebar-version">BALANCEVAULT <span>·</span> PRIVATE</div></div>
      </aside>
      {mobileMenuOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)} />}

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-leading"><button className="mobile-menu-button" onClick={() => setMobileMenuOpen(true)} aria-label="Open navigation"><span /><span /><span /></button><div className="breadcrumb"><span>Workspace</span><b>/</b><strong>{pathname.startsWith('/accounts/') ? 'Account details' : pathname.startsWith('/transactions/') ? pathname.split('/')[2]?.[0]?.toUpperCase() + pathname.split('/')[2]?.slice(1) : pathname.startsWith('/transfers/') ? 'Transfer details' : pathname === '/accounts' ? 'Accounts' : pathname === '/statements' ? 'Statements' : pathname === '/audit' ? 'Audit log' : 'Overview'}</strong></div></div>
          <div className="topbar-actions"><BackendBadge /><span className="topbar-divider" /><ProfileMenu user={user} signOut={signOut} /></div>
        </header>
        <main className="page-content">
          <Suspense fallback={<div className="loading-row" role="status"><span className="spinner spinner-dark" />Loading workspace</div>}>
          {pathname === '/accounts' ? <AccountsPage request={request} isAdmin={isAdmin} userRole={user.role} accountRefreshVersion={accountRefreshVersion} refreshAccounts={refreshAccounts} selectedAccountId={selectedAccountId} setSelectedAccountId={setSelectedAccountId} />
            : forbidden ? <section className="section-block role-dashboard-panel"><span className="section-kicker">ACCESS RESTRICTED</span><h1>Access denied</h1><p>Your current role cannot open this page.</p><button className="button button-outline" onClick={() => navigate('/dashboard')}>Return to overview</button></section>
            : pathname === '/profile' || pathname === '/settings' ? <ProfilePage request={request} user={user} updateUser={updateUser} />
              : pathname === '/settings/security' ? <SecurityPage request={request} onChanged={signOut} />
                : pathname === '/account-requests' ? <AccountRequestPage request={request} />
                  : pathname === '/admin/users' && isAdmin ? <AdminUsersPage request={request} />
                    : pathname === '/admin/onboarding' && isAdmin ? <OnboardingPage request={request} refreshAccounts={refreshAccounts} />
            : pathname === '/statements' ? <StatementPage request={request} selectedAccountId={selectedAccountId} setSelectedAccountId={setSelectedAccountId} />
            : pathname.startsWith('/accounts/') ? <AccountDetailsPage accountId={pathname.split('/')[2]} request={request} selectedAccountId={selectedAccountId} setSelectedAccountId={setSelectedAccountId} />
              : pathname.startsWith('/transactions/') ? <FinancialTransactionPage type={pathname.split('/')[2]} onNavigate={navigate} />
              : pathname.startsWith('/transfers/') ? <TransferDetailsPage request={request} transferId={pathname.split('/')[2]} onNavigate={navigate} />
                : pathname === '/audit' && ['ADMIN', 'AUDITOR'].includes(user.role) ? <AuditPage request={request} /> : <DashboardPage request={request} user={user} accountRefreshVersion={accountRefreshVersion} />}
          </Suspense>
        </main>
        <footer className="app-footer"><span>BalanceVault <i>·</i> Financial clarity, by design.</span><span className="footer-secure"><Icon name="lock" size={13} /> Secure session</span></footer>
      </div>
    </div>
  );
}

function DashboardPage({ request, user, accountRefreshVersion }) {
  const [accounts, setAccounts] = useState(null);
  const [balances, setBalances] = useState({});
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetchAccounts(request, { signal: controller.signal })
      .then(async (items) => {
        setAccounts(items);
        const balanceEntries = await Promise.all(
          items.map(async (account) => {
            try {
              const balance = await fetchAccountBalance(request, account.id, { signal: controller.signal });
              return [account.id, balance];
            } catch (balanceError) {
              return [account.id, { error: balanceError.message }];
            }
          }),
        );
        if (!controller.signal.aborted) {
          setBalances(Object.fromEntries(balanceEntries));
        }
      })
      .catch((requestError) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [accountRefreshVersion, request]);
  const firstName = user.fullName?.split(/\s+/)[0] || user.email.split('@')[0];
  const activeCount = accounts?.filter((account) => account.status === 'ACTIVE').length ?? 0;
  const totalPaise = accounts?.reduce((sum, account) => {
    const bal = balances[account.id];
    if (bal && !bal.error && bal.balancePaise) {
      try { return sum + BigInt(bal.balancePaise); } catch { return sum; }
    }
    return sum;
  }, 0n) ?? 0n;
  const totalBalanceFormatted = accounts === null || Object.keys(balances).length === 0
    ? '—'
    : formatPaiseAsINR(totalPaise);

  return (
    <>
      <section className="welcome-panel">
        <div className="welcome-copy"><div className="welcome-date"><span className="welcome-spark">✳</span> YOUR FINANCIAL OVERVIEW</div><h1>Good to see you, <em>{firstName}</em></h1><p>Everything in its place. Here’s your account overview.</p><div className="welcome-role"><span className="role-dot" />{roleLabels[user.role] ?? 'Member'} <span className="welcome-separator">·</span> Private workspace</div></div>
        <div className="welcome-art" aria-hidden="true"><span className="art-ring ring-a" /><span className="art-ring ring-b" /><span className="art-coin">b<span>.</span></span><span className="art-orbit-dot" /></div>
        <div className="welcome-index">01 <span>/</span> 03</div>
      </section>

      <section className="section-block account-overview-block">
        <div className="section-heading"><div><span className="section-kicker">YOUR SPACE</span><h2>Account overview</h2></div><button className="text-link" onClick={() => navigate('/accounts')}>All accounts <Icon name="arrow" size={16} /></button></div>
        <div className="summary-grid">
          <div className="summary-card account-count-card"><span className="summary-icon"><Icon name="cards" size={19} /></span><span className="summary-label">Total accounts</span><strong>{accounts === null ? '—' : accounts.length.toString().padStart(2, '0')}</strong><small>{accounts === null ? 'Loading account data' : accounts.length === 1 ? 'Account connected' : 'Accounts connected'}</small><div className="summary-decoration" aria-hidden="true" /></div>
          <div className="summary-card"><span className="summary-icon summary-icon-light"><Icon name="shield" size={19} /></span><span className="summary-label">Available balance</span><strong className="summary-status">{totalBalanceFormatted}</strong><small>{accounts === null ? 'Checking your accounts' : `${activeCount} active ${activeCount === 1 ? 'account' : 'accounts'}`}</small><span className="summary-status-line"><i /></span></div>
        </div>
        {error && <div className="inline-error" role="alert"><span>We couldn’t load your accounts.</span><small>{error}</small><button onClick={() => window.location.reload()}>Try again</button></div>}
      </section>

      <div className="dashboard-lower-grid">
        <section className="section-block account-list-block">
          <div className="section-heading compact-heading"><div><span className="section-kicker">CONNECTED</span><h2>Your accounts</h2></div><button className="square-link" onClick={() => navigate('/accounts')} aria-label="View all accounts"><Icon name="arrow" size={17} /></button></div>
          {accounts === null ? <div className="loading-row"><span className="spinner spinner-dark" />Loading accounts</div> : accounts.length === 0 ? <><EmptyState title="No accounts yet" detail="Customer accounts are opened after an administrator reviews your request." />{user.role === 'ACCOUNT_HOLDER' && <button className="button button-outline" onClick={() => navigate('/account-requests')}>Request an account</button>}</> : <div className="account-list">{accounts.slice(0, 4).map((account) => <AccountRow key={account.id} account={account} balance={balances[account.id]} />)}</div>}
          {accounts?.length > 4 && <button className="view-all-link" onClick={() => navigate('/accounts')}>View all {accounts.length} accounts <Icon name="arrow" size={15} /></button>}
        </section>

        {user.role === 'ACCOUNT_HOLDER' && <section className="section-block quick-actions-block">
          <div className="section-heading compact-heading"><div><span className="section-kicker">ON YOUR TERMS</span><h2>Quick actions</h2></div></div>
          <div className="quick-actions">
            <ActionCard title="Deposit" label="Add funds" tone="sage" onClick={() => navigate('/transactions/deposit')} />
            <ActionCard title="Withdraw" label="Move funds out" tone="cream" onClick={() => navigate('/transactions/withdrawal')} />
            <ActionCard title="Transfer" label="Between accounts" tone="lavender" onClick={() => navigate('/transactions/transfer')} />
          </div>
        </section>}
      </div>

      {user.role === 'ADMIN' && <section className="section-block role-dashboard-panel"><span className="section-kicker">ADMINISTRATION</span><h2>Operations workspace</h2><p>Review account opening requests, manage user access, inspect the audit trail, and process customer transactions.</p><div className="role-dashboard-actions"><button className="button button-outline" onClick={() => navigate('/admin/onboarding')}>Review onboarding</button><button className="button button-outline" onClick={() => navigate('/admin/users')}>Manage users</button><button className="button button-outline" onClick={() => navigate('/audit')}>View audit log</button></div><div className="role-dashboard-actions"><button className="button button-outline" onClick={() => navigate('/transactions/deposit')}>Deposit</button><button className="button button-outline" onClick={() => navigate('/transactions/withdrawal')}>Withdrawal</button><button className="button button-outline" onClick={() => navigate('/transactions/transfer')}>Transfer</button></div></section>}
      {user.role === 'AUDITOR' && <section className="section-block role-dashboard-panel"><span className="section-kicker">READ ONLY</span><h2>Audit workspace</h2><p>Review assigned-account statements and the audit events available to your role.</p><button className="button button-outline" onClick={() => navigate('/audit')}>Open audit log</button></section>}
      <DashboardActivity request={request} accounts={accounts} accountRefreshVersion={accountRefreshVersion} />
    </>
  );
}

function DashboardActivity({ request, accounts, accountRefreshVersion }) {
  const [statement, setStatement] = useState(null);
  const [error, setError] = useState('');
  const firstAccount = accounts?.[0];
  useEffect(() => {
    if (!firstAccount) { setStatement(null); return undefined; }
    const controller = new AbortController(); setError(''); setStatement(null);
    fetchAccountStatement(request, firstAccount.id, { limit: 5, signal: controller.signal })
      .then(setStatement).catch((err) => { if (err.name !== 'AbortError') setError(err.status === 403 ? 'You do not have permission to view this account activity.' : err.message || 'Activity could not be loaded.'); });
    return () => controller.abort();
  }, [firstAccount?.id, request, accountRefreshVersion]);
  return <section className="section-block activity-block">
    <div className="section-heading"><div><span className="section-kicker">LEDGER</span><h2>Transaction activity</h2></div>{firstAccount && <button className="text-link" onClick={() => navigate('/statements')}>Full statements <Icon name="arrow" size={16} /></button>}</div>
    {!accounts && <div className="loading-row"><span className="spinner spinner-dark" />Loading account activity</div>}
    {accounts?.length === 0 && <EmptyState title="No accounts available" detail="Account activity will appear when you have access to an account." icon="activity" />}
    {firstAccount && !statement && !error && <div className="loading-row"><span className="spinner spinner-dark" />Loading ledger activity</div>}
    {error && <div className="ledger-error" role="alert"><span>{error}</span><button className="button button-outline" onClick={() => navigate('/statements')}>Open statements</button></div>}
    {statement?.events.length === 0 && <EmptyState title="No transaction activity yet" detail="Posted entries and refused attempts will appear in the account statement." icon="activity" />}
    {statement?.events.length > 0 && <><div className="statement-list dashboard-statement-list">{statement.events.map((event) => <StatementEvent key={`${event.status}:${event.id}`} event={event} currencyCode={statement.account.currencyCode} compact />)}</div><p className="statement-order-note">Entries shown in the order supplied by the account ledger.</p></>}
  </section>;
}

function AccountsPage({ request, isAdmin, userRole, accountRefreshVersion, refreshAccounts, selectedAccountId, setSelectedAccountId }) {
  const [accounts, setAccounts] = useState(null);
  const [balances, setBalances] = useState({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retryVersion, setRetryVersion] = useState(0);
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    fetchAccounts(request, { signal: controller.signal })
      .then(async (items) => {
        setAccounts(items);
        if (selectedAccountId && !items.some((account) => account.id === selectedAccountId)) setSelectedAccountId(null);
        const results = await Promise.all(items.map(async (account) => {
          try {
            const balance = await fetchAccountBalance(request, account.id, { signal: controller.signal });
            return [account.id, { balancePaise: balance.balancePaise, currencyCode: balance.currencyCode }];
          } catch (balanceError) {
            if (balanceError.name === 'AbortError') throw balanceError;
            return [account.id, { error: balanceError }];
          }
        }));
        if (!controller.signal.aborted) setBalances(Object.fromEntries(results));
      })
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') {
          setError(requestError.status === 403
            ? 'Your account role does not permit viewing accounts.'
            : requestError.status === 401
              ? 'Your session has expired. Sign in again to continue.'
              : requestError.message || 'We could not load your accounts.');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accountRefreshVersion, request, retryVersion, setSelectedAccountId]);

  function retry() {
    setAccounts(null);
    setBalances({});
    setRetryVersion((version) => version + 1);
  }

  return (
    <section className="section-block full-page-block">
      <div className="page-title-row">
        <div><span className="section-kicker">YOUR SPACE</span><h1>Accounts</h1><p>Accounts available to your BalanceVault profile.</p></div>
        <div className="account-page-actions">
          {accounts && <span className="count-pill">{accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</span>}
          {isAdmin && <button className="button button-primary create-account-toggle" onClick={() => setShowCreateForm((visible) => !visible)}><Icon name="plus" size={17} />{showCreateForm ? 'Close form' : 'New account'}</button>}
        </div>
      </div>
      {isAdmin && showCreateForm && <CreateAccountForm request={request} onCreated={(account) => { refreshAccounts(); setSelectedAccountId(account.id); setShowCreateForm(false); }} />}
      {error && <ErrorPanel message={error} onRetry={retry} />}
      {loading && accounts === null ? <div className="loading-row"><span className="spinner spinner-dark" />Loading accounts</div>
        : !error && accounts?.length === 0 ? <><EmptyState title="No accounts available" detail="Accounts you are permitted to view will appear here." />{userRole === 'ACCOUNT_HOLDER' && <button className="button button-outline" onClick={() => navigate('/account-requests')}>Request an account for review</button>}</>
          : <div className="accounts-grid">{accounts?.map((account) => <AccountCard key={account.id} account={account} balance={balances[account.id]} selected={selectedAccountId === account.id} onSelect={() => setSelectedAccountId(account.id)} />)}</div>}
      {!loading && !error && accounts?.length > 0 && Object.values(balances).some((item) => item.error) && <p className="balance-access-note" role="status">Some balance details could not be loaded. Retry the page to check again.</p>}
      {accounts?.length > 0 && <p className="selection-help">Select an account to prefill future deposit, withdrawal, and transfer forms. This selection does not grant access; the API checks permissions for every request.</p>}
    </section>
  );
}

function AccountDetailsPage({ accountId, request, selectedAccountId, setSelectedAccountId }) {
  const [account, setAccount] = useState(null);
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      fetchAccount(request, accountId, { signal: controller.signal }),
      fetchAccountBalance(request, accountId, { signal: controller.signal }),
    ]).then(([detail, accountBalance]) => {
      setAccount(detail);
      setBalance(accountBalance);
    }).catch((requestError) => {
      if (requestError.name !== 'AbortError') {
        setError(requestError.status === 401
          ? 'Your session has expired. Sign in again to continue.'
          : requestError.status === 403
            ? 'You do not have permission to view this account.'
            : requestError.status === 404
              ? 'This account is unavailable or you no longer have permission to view it.'
              : requestError.message || 'We could not load this account.');
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accountId, request, retryVersion]);

  return <section className="section-block full-page-block">
    <button className="back-link" onClick={() => navigate('/accounts')}>← <span>Back to accounts</span></button>
    {loading ? <div className="loading-row"><span className="spinner spinner-dark" />Loading account details</div>
      : error ? <ErrorPanel message={error} onRetry={() => setRetryVersion((version) => version + 1)} />
        : account && <>
          <div className="page-title-row detail-title-row"><div><span className="section-kicker">{account.type === 'BUSINESS' ? 'BUSINESS ACCOUNT' : 'PERSONAL ACCOUNT'}</span><h1>{account.accountNumber}</h1><p>Account details and current available balance.</p></div><span className={`status-pill status-${account.status.toLowerCase()}`}><i />{account.status.toLowerCase()}</span></div>
          <div className="account-detail-layout">
            <article className="detail-balance-card"><span className="detail-card-kicker">CURRENT BALANCE</span><strong>{balance ? formatPaiseAsINR(balance.balancePaise, balance.currencyCode) : 'Balance unavailable'}</strong><small>Balance supplied by the BalanceVault account API.</small><div className="detail-balance-watermark" aria-hidden="true">BV</div></article>
            <article className="detail-info-card"><div className="detail-info-heading"><span className="account-symbol account-symbol-large"><Icon name={account.type === 'BUSINESS' ? 'building' : 'cards'} size={20} /></span><div><span className="section-kicker">ACCOUNT INFORMATION</span><h2>Account details</h2></div></div><dl className="detail-list"><div><dt>Account number</dt><dd>{account.accountNumber}</dd></div><div><dt>Account type</dt><dd>{account.type === 'BUSINESS' ? 'Business' : 'Personal'}</dd></div><div><dt>Status</dt><dd><span className={`status-pill status-${account.status.toLowerCase()}`}><i />{account.status.toLowerCase()}</span></dd></div><div><dt>Currency</dt><dd>{account.currencyCode}</dd></div><div><dt>Created</dt><dd>{formatAccountDate(account.createdAt)}</dd></div></dl></article>
          </div>
          <div className="detail-selection-row"><div><strong>Account statement</strong><p>Review posted entries and refused attempts recorded for this account.</p></div><button className="button button-outline" onClick={() => { setSelectedAccountId(account.id); navigate('/statements'); }}>View statements</button><button className={`button ${selectedAccountId === account.id ? 'button-selected' : 'button-outline'}`} onClick={() => setSelectedAccountId(account.id)}>{selectedAccountId === account.id ? 'Selected for future actions' : 'Select this account'}</button></div>
        </>}
  </section>;
}

function CreateAccountForm({ request, onCreated }) {
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType, setAccountType] = useState('PERSONAL');
  const [holderUserId, setHolderUserId] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    const cleanNumber = accountNumber.trim();
    const cleanHolder = holderUserId.trim();
    if (!cleanNumber || cleanNumber.length > 64 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cleanHolder)) {
      setError('Enter an account number up to 64 characters and a valid account holder UUID.');
      return;
    }
    setSubmitting(true);
    try {
      const account = await createCustomerAccount(request, { accountNumber: cleanNumber, accountType, holderUserId: cleanHolder });
      onCreated(account);
    } catch (requestError) {
      setError(requestError.status === 409
        ? 'That account number is already in use.'
        : requestError.status === 403
          ? 'Your current role cannot create accounts.'
          : requestError.status === 422
            ? 'The holder must be an active account holder and the account details must be valid.'
            : requestError.message || 'The account could not be created.');
    } finally {
      setSubmitting(false);
    }
  }

  return <form className="create-account-form" onSubmit={submit}>
    <div className="create-form-heading"><div><span className="section-kicker">ADMINISTRATION</span><h2>Create customer account</h2><p>The backend verifies your administrator role and the holder’s account status.</p></div><span className="admin-only-pill"><Icon name="shield" size={14} /> ADMIN ONLY</span></div>
    <div className="create-form-grid">
      <label className="field-label"><span>Account number</span><input value={accountNumber} onChange={(event) => setAccountNumber(event.target.value)} maxLength={64} required placeholder="e.g. BV-10428" /></label>
      <label className="field-label"><span>Account type</span><select value={accountType} onChange={(event) => setAccountType(event.target.value)}><option value="PERSONAL">Personal</option><option value="BUSINESS">Business</option></select></label>
      <label className="field-label holder-field"><span>Holder user ID</span><input value={holderUserId} onChange={(event) => setHolderUserId(event.target.value)} autoComplete="off" required placeholder="Account holder UUID" /></label>
    </div>
    {error && <div className="form-error" role="alert"><span>!</span>{error}</div>}
    <div className="create-form-footer"><p>Account permissions are created by the server with view access only.</p><button className="button button-primary" disabled={submitting}>{submitting ? <><span className="spinner" />Creating…</> : <><Icon name="plus" size={17} />Create account</>}</button></div>
  </form>;
}

function ErrorPanel({ message, onRetry }) {
  return <div className="account-error-panel" role="alert"><span className="error-mark">!</span><div><strong>We couldn’t load the account information</strong><p>{message}</p></div><button className="button button-outline" onClick={onRetry}>Retry</button></div>;
}

function AccountRow({ account, balance }) {
  const balanceText = balance?.error ? 'Unavailable' : balance ? formatPaiseAsINR(balance.balancePaise, balance.currencyCode) : '—';
  return <article className="account-row"><span className="account-symbol"><Icon name={account.type === 'BUSINESS' ? 'building' : 'cards'} size={18} /></span><span className="account-row-main"><strong>{account.accountNumber}</strong><small>{account.type === 'BUSINESS' ? 'Business account' : 'Personal account'}</small></span><span className={`status-pill status-${account.status.toLowerCase()}`}><i />{account.status.toLowerCase()}</span><strong className="account-balance-cell">{balanceText}</strong></article>;
}

function AccountCard({ account, balance, selected, onSelect }) {
  const balanceText = balance?.error ? 'Unavailable' : balance ? formatPaiseAsINR(balance.balancePaise, balance.currencyCode) : 'Loading…';
  return <article className={`account-card ${selected ? 'account-card-selected' : ''}`}>
    <div className="account-card-top"><span className="account-symbol account-symbol-large"><Icon name={account.type === 'BUSINESS' ? 'building' : 'cards'} size={20} /></span><span className={`status-pill status-${account.status.toLowerCase()}`}><i />{account.status.toLowerCase()}</span></div>
    <button className="account-card-open" onClick={() => navigate(`/accounts/${account.id}`)} aria-label={`View account ${account.accountNumber}`}><span>{account.type === 'BUSINESS' ? 'BUSINESS ACCOUNT' : 'PERSONAL ACCOUNT'}</span><strong>{account.accountNumber}</strong></button>
    <div className="account-card-balance"><span>Available balance</span><strong>{balanceText}</strong></div>
    <div className="account-card-meta"><span>Created {formatAccountDate(account.createdAt)}</span><span>{account.currencyCode}</span></div>
    <button className={`account-select-button ${selected ? 'account-select-active' : ''}`} onClick={onSelect} aria-pressed={selected}>{selected ? '✓ Selected for future actions' : 'Select for future actions'}</button>
  </article>;
}

function ActionCard({ title, label, tone, onClick }) {
  return <button className={`action-card action-${tone}`} type="button" onClick={onClick} aria-label={`${title} transaction`}><span className="action-icon"><Icon name="plus" size={19} /></span><span className="action-title">{title}</span><span className="action-label">{label}</span><span className="action-soon">OPEN</span></button>;
}

function ProfileMenu({ user, signOut }) {
  const [open, setOpen] = useState(false);
  return <div className="profile-menu-wrap">
    <button className="profile-menu-trigger" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
      <span className="avatar">{(user.fullName?.[0] || user.email[0] || '?').toUpperCase()}</span>
      <span className="profile-menu-identity"><strong>{user.fullName || user.email}</strong><small>{roleLabels[user.role] ?? user.role}</small></span>
      <span aria-hidden="true">⌄</span>
    </button>
    {open && <div className="profile-menu" role="menu">
      <button role="menuitem" onClick={() => { setOpen(false); navigate('/profile'); }}>Profile</button>
      <button role="menuitem" onClick={() => { setOpen(false); navigate('/settings'); }}>Settings</button>
      <button role="menuitem" onClick={() => { setOpen(false); navigate('/settings/security'); }}>Security</button>
      <button role="menuitem" onClick={signOut}>Sign out</button>
    </div>}
  </div>;
}

function ProfilePage({ request, user, updateUser }) {
  const [profile, setProfile] = useState(null); const [name, setName] = useState(user.fullName ?? '');
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function load() { setError(''); try { const result = await request('/api/users/me'); setProfile(result.user); setName(result.user.fullName ?? ''); } catch (err) { setError(err.message || 'Profile could not be loaded.'); } }
  useEffect(() => { load(); }, []);
  async function save(event) { event.preventDefault(); setBusy(true); setError(''); setMessage(''); try { const result = await request('/api/users/me', { method: 'PATCH', body: { fullName: name.trim() } }); setProfile(result.user); updateUser(result.user); setMessage('Profile updated.'); } catch (err) { setError(err.message || 'Profile could not be updated.'); } finally { setBusy(false); } }
  return <section className="section-block full-page-block"><div className="page-title-row"><div><span className="section-kicker">YOUR ACCOUNT</span><h1>Profile</h1><p>Review and update your personal details.</p></div></div>
    {!profile && !error && <div className="loading-row"><span className="spinner spinner-dark" />Loading profile</div>}
    {error && <div className="form-error" role="alert">{error}<button type="button" onClick={load}>Retry</button></div>}
    {profile && <form className="settings-card settings-form" onSubmit={save}><label className="field-label"><span>Full name</span><input value={name} onChange={(event) => setName(event.target.value)} minLength={1} maxLength={100} required /></label><label className="field-label"><span>Email</span><input value={profile.email} readOnly /></label><label className="field-label"><span>Role</span><input value={roleLabels[profile.role] ?? profile.role} readOnly /></label><label className="field-label"><span>Account status</span><input value={profile.isActive ? 'Active' : 'Inactive'} readOnly /></label><label className="field-label"><span>Member since</span><input value={formatDate(profile.createdAt)} readOnly /></label>{message && <p className="form-success" role="status">{message}</p>}<button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button><button className="button button-outline" type="button" onClick={() => navigate('/settings/security')}>Security settings</button></form>}
  </section>;
}

function SecurityPage({ request, onChanged }) {
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event) { event.preventDefault(); setError(''); setBusy(true); try { await request('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }); setCurrentPassword(''); setNewPassword(''); onChanged(); } catch (err) { setError(err.message || 'Password could not be changed.'); } finally { setBusy(false); } }
  return <section className="section-block full-page-block"><div className="page-title-row"><div><span className="section-kicker">ACCOUNT SECURITY</span><h1>Security</h1><p>Changing your password signs out existing sessions.</p></div></div><form className="settings-card settings-form" onSubmit={submit}><label className="field-label"><span>Current password</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label><label className="field-label"><span>New password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={72} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="button button-primary" disabled={busy}>{busy ? 'Updating…' : 'Change password'}</button></form></section>;
}

function AccountRequestPage({ request }) {
  const [items, setItems] = useState(null); const [type, setType] = useState('PERSONAL'); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [version, setVersion] = useState(0);
  useEffect(() => { const controller = new AbortController(); request('/api/account-requests', { signal: controller.signal }).then((data) => setItems(data.requests)).catch((err) => { if (err.name !== 'AbortError') setError(err.message); }); return () => controller.abort(); }, [request, version]);
  async function submit(event) { event.preventDefault(); setBusy(true); setError(''); try { await request('/api/account-requests', { method: 'POST', body: { requestedType: type } }); setVersion((value) => value + 1); } catch (err) { setError(err.message || 'Request could not be submitted.'); } finally { setBusy(false); } }
  return <section className="section-block full-page-block"><div className="page-title-row"><div><span className="section-kicker">ONBOARDING</span><h1>Account request</h1><p>Customer accounts are opened after administrator review.</p></div></div><form className="settings-card onboarding-request-form" onSubmit={submit}><label className="field-label"><span>Requested account type</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="PERSONAL">Personal</option><option value="BUSINESS">Business</option></select></label>{error && <div className="form-error" role="alert">{error}</div>}<button className="button button-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit request'}</button></form><h2 className="ledger-subheading">Your requests</h2>{items === null ? <div className="loading-row">Loading requests…</div> : items.length === 0 ? <EmptyState title="No requests yet" detail="Submitted account requests and their decisions appear here." /> : <div className="settings-card">{items.map((item) => <div className="admin-list-row" key={item.id}><strong>{item.requestedType} account</strong><span className={`status-pill status-${item.status.toLowerCase()}`}>{item.status}</span><small>{formatDate(item.createdAt)}</small>{item.reviewNote && <p>{item.reviewNote}</p>}</div>)}</div>}</section>;
}

function AdminUsersPage({ request }) {
  const [data, setData] = useState(null); const [invitations, setInvitations] = useState(null); const [error, setError] = useState(''); const [version, setVersion] = useState(0);
  const [fullName, setFullName] = useState(''); const [email, setEmail] = useState(''); const [role, setRole] = useState('AUDITOR');
  const [search, setSearch] = useState(''); const [roleFilter, setRoleFilter] = useState(''); const [statusFilter, setStatusFilter] = useState('');
  const [busy, setBusy] = useState(false); const [createdInvitation, setCreatedInvitation] = useState(null); const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      request(`/api/admin/users?${new URLSearchParams({ page: '1', perPage: '50', ...(search ? { search } : {}), ...(roleFilter ? { role: roleFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}) })}`, { signal: controller.signal }),
      request('/api/admin/invitations', { signal: controller.signal }),
    ]).then(([users, inviteData]) => { setData(users); setInvitations(inviteData.invitations); setError(''); })
      .catch((err) => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, [request, version, search, roleFilter, statusFilter]);
  async function toggle(user) { setError(''); try { await request(`/api/admin/users/${user.id}/status`, { method: 'PATCH', body: { isActive: !user.isActive } }); setVersion((v) => v + 1); } catch (err) { setError(err.message || 'User status could not be changed.'); } }
  async function createInvitation(event) {
    event.preventDefault(); setBusy(true); setError(''); setNotice(''); setCreatedInvitation(null);
    try {
      const result = await request('/api/admin/invitations', { method: 'POST', body: { fullName, email, role } });
      setCreatedInvitation(result.invitation); setFullName(''); setEmail(''); setVersion((v) => v + 1);
      setNotice('Invitation created. Copy its link now; the token is shown only once.');
    } catch (err) { setError(err.message || 'Invitation could not be created.'); }
    finally { setBusy(false); }
  }
  async function revoke(invitation) {
    setError(''); setNotice('');
    try { await request(`/api/admin/invitations/${invitation.id}/revoke`, { method: 'POST', body: {} }); setVersion((v) => v + 1); setNotice('Invitation revoked.'); }
    catch (err) { setError(err.message || 'Invitation could not be revoked.'); }
  }
  const invitationLink = createdInvitation ? `${window.location.origin}/accept-invitation#${createdInvitation.token}` : '';
  return <section className="section-block full-page-block"><div className="page-title-row"><div><span className="section-kicker">ADMINISTRATION</span><h1>User management</h1><p>Customers register publicly; privileged roles require an administrator invitation.</p></div></div>
    {error && <div className="form-error" role="alert">{error}<button onClick={() => setVersion((v) => v + 1)}>Retry</button></div>}{notice && <p className="form-success" role="status">{notice}</p>}
    <form className="settings-card settings-form" onSubmit={createInvitation}><h2>Invite an administrator or auditor</h2><label className="field-label"><span>Full name</span><input value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={100} required /></label><label className="field-label"><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required /></label><label className="field-label"><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value)}><option value="AUDITOR">Auditor</option><option value="ADMIN">Administrator</option></select></label><button className="button button-primary" disabled={busy}>{busy ? 'Creating invitation…' : 'Create invitation'}</button></form>
    {createdInvitation && <div className="settings-card invitation-link-panel"><strong>Share this invitation link securely</strong><p>This link expires {formatDate(createdInvitation.expiresAt)} and can be accepted once.</p><input aria-label="One-time invitation link" readOnly value={invitationLink} onFocus={(event) => event.target.select()} /><button className="button button-outline" onClick={async () => { try { await navigator.clipboard.writeText(invitationLink); setNotice('Invitation link copied.'); } catch { setNotice('Select and copy the invitation link.'); } }}>Copy link</button></div>}
    <h2 className="ledger-subheading">Users</h2><div className="admin-filter-row"><label className="field-label"><span>Search name or email</span><input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label><label className="field-label"><span>Role</span><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="">All roles</option><option value="ACCOUNT_HOLDER">Account holder</option><option value="ADMIN">Administrator</option><option value="AUDITOR">Auditor</option></select></label><label className="field-label"><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label></div>
    {!data && !error && <div className="loading-row">Loading users…</div>}{data?.users.length === 0 && <EmptyState title="No users found" detail="Try a different search or filter." />}{data?.users.map((person) => <article className="admin-list-row settings-card" key={person.id}><div><strong>{person.fullName || person.email}</strong><small>{person.email} · {roleLabels[person.role]} · Joined {formatDate(person.createdAt)}</small></div><span className={`status-pill status-${person.isActive ? 'active' : 'closed'}`}>{person.isActive ? 'Active' : 'Inactive'}</span>{person.role !== 'ADMIN' && <button className="button button-outline" onClick={() => toggle(person)}>{person.isActive ? 'Deactivate' : 'Reactivate'}</button>}</article>)}
    <h2 className="ledger-subheading">Invitations</h2>{!invitations && !error && <div className="loading-row">Loading invitations…</div>}{invitations?.length === 0 && <EmptyState title="No invitations" detail="Invitations you create will appear here." />}{invitations?.map((invitation) => { const status = invitation.acceptedAt ? 'Accepted' : invitation.revokedAt ? 'Revoked' : new Date(invitation.expiresAt) <= new Date() ? 'Expired' : 'Pending'; return <article className="admin-list-row settings-card" key={invitation.id}><div><strong>{invitation.fullName} · {roleLabels[invitation.role]}</strong><small>{invitation.email} · Expires {formatDate(invitation.expiresAt)}</small></div><span className={`status-pill status-${status.toLowerCase()}`}>{status}</span>{status === 'Pending' && <button className="button button-outline" onClick={() => revoke(invitation)}>Revoke</button>}</article>; })}
  </section>;
}

function OnboardingPage({ request, refreshAccounts }) {
  const [items, setItems] = useState(null); const [error, setError] = useState(''); const [version, setVersion] = useState(0); const [numbers, setNumbers] = useState({});
  useEffect(() => { const controller = new AbortController(); request('/api/account-requests/admin/queue', { signal: controller.signal }).then((data) => setItems(data.requests)).catch((err) => { if (err.name !== 'AbortError') setError(err.message); }); return () => controller.abort(); }, [request, version]);
  async function decide(item, decision) { setError(''); try { if (decision === 'approve') { const accountNumber = numbers[item.id]?.trim(); if (!accountNumber) { setError('Enter an account number before approval.'); return; } await request(`/api/account-requests/admin/${item.id}/approve`, { method: 'POST', body: { accountNumber } }); refreshAccounts(); } else await request(`/api/account-requests/admin/${item.id}/reject`, { method: 'POST', body: { note: 'Reviewed by administrator' } }); setVersion((v) => v + 1); } catch (err) { setError(err.message || 'The request could not be resolved.'); } }
  return <section className="section-block full-page-block"><div className="page-title-row"><div><span className="section-kicker">ADMINISTRATION</span><h1>Account onboarding</h1><p>Approved accounts are created atomically with view permission for the requester.</p></div></div>{error && <div className="form-error" role="alert">{error}</div>}{!items && !error && <div className="loading-row">Loading requests…</div>}{items?.length === 0 && <EmptyState title="No requests awaiting review" detail="Pending customer requests will appear here." />}{items?.map((item) => <article className="settings-card onboarding-row" key={item.id}><div><strong>{item.user.fullName || item.user.email}</strong><small>{item.user.email} · {item.requestedType} · {formatDate(item.createdAt)}</small></div><label className="field-label"><span>Account number</span><input value={numbers[item.id] ?? ''} onChange={(event) => setNumbers((current) => ({ ...current, [item.id]: event.target.value }))} maxLength={64} /></label><div className="role-dashboard-actions"><button className="button button-primary" onClick={() => decide(item, 'approve')}>Approve and open</button><button className="button button-outline" onClick={() => decide(item, 'reject')}>Reject</button></div></article>)}</section>;
}

function EmptyState({ title, detail, icon = 'cards' }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={20} /></span><strong>{title}</strong><p>{detail}</p></div>;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function AppRouter() {
  const pathname = usePathname();
  const { isAuthenticated, user } = useAuth();
  const publicRoute = pathname === '/login' || pathname === '/register' || pathname === '/accept-invitation';
  const accountDetailRoute = /^\/accounts\/[^/]+$/.test(pathname);
  const transactionRoute = /^\/transactions\/(deposit|withdrawal|transfer)$/.test(pathname);
  const transferDetailRoute = /^\/transfers\/[^/]+$/.test(pathname);
  const knownRoute = ['/login', '/register', '/accept-invitation', '/dashboard', '/accounts', '/statements', '/audit', '/profile', '/settings', '/settings/security', '/account-requests', '/admin/users', '/admin/onboarding'].includes(pathname) || accountDetailRoute || transactionRoute || transferDetailRoute;
  const forbidden = Boolean(user) && (
    (pathname === '/account-requests' && user.role !== 'ACCOUNT_HOLDER')
    || (pathname.startsWith('/admin/') && user.role !== 'ADMIN')
    || (pathname === '/audit' && !['ADMIN', 'AUDITOR'].includes(user.role))
    || (transactionRoute && !['ACCOUNT_HOLDER', 'ADMIN'].includes(user.role))
  );

  useEffect(() => {
    if (!isAuthenticated && !publicRoute) navigate('/login', true);
    else if (isAuthenticated && publicRoute) navigate('/dashboard', true);
    else if (!knownRoute) {
      navigate(isAuthenticated ? '/dashboard' : '/login', true);
    }
  }, [isAuthenticated, knownRoute, pathname, publicRoute, user?.role]);

  if (!isAuthenticated) return <AuthPage key={pathname === '/register' ? 'register' : pathname === '/accept-invitation' ? 'invitation' : 'login'} mode={pathname === '/register' ? 'register' : pathname === '/accept-invitation' ? 'invitation' : 'login'} />;
  if (forbidden) return <AppShell pathname={pathname} forbidden />;
  return <AppShell pathname={pathname} />;
}

export default function App() {
  return <AuthProvider><AppRouter /></AuthProvider>;
}
