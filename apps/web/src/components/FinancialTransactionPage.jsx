import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { ApiError } from '../lib/api.js';
import { fetchAccountBalance, fetchAccounts, formatPaiseAsINR } from '../lib/accounts.js';
import {
  clearPendingTransaction,
  createSubmissionGuard,
  createTransactionAttempt,
  formatPaiseForInput,
  parseInrToPaise,
  readPendingTransaction,
  savePendingTransaction,
} from '../lib/transactions.js';

const transactionDetails = {
  deposit: { type: 'DEPOSIT', title: 'Deposit', verb: 'deposit', endpoint: '/api/deposits', intro: 'Add funds to an eligible account.' },
  withdrawal: { type: 'WITHDRAWAL', title: 'Withdrawal', verb: 'withdraw', endpoint: '/api/withdrawals', intro: 'Move funds from an eligible account.' },
  transfer: { type: 'TRANSFER', title: 'Transfer', verb: 'transfer', endpoint: '/api/transfers', intro: 'Move funds between two of your accessible accounts.' },
};

function initialAttempt(userId, type) {
  return readPendingTransaction(userId, type);
}

function getReason(error) {
  const reason = error?.payload?.reason;
  const messages = {
    insufficient_funds: 'The account does not have enough available funds for this withdrawal or transfer.',
    not_authorized: 'You do not have permission to perform this operation on the selected account.',
    role_forbidden: 'Your current role cannot initiate money movement.',
    account_unavailable: 'One of the selected accounts is unavailable for transactions.',
    account_inactive: 'Your user account is inactive. Sign in again or contact an administrator.',
    invalid_accounts: 'The selected account combination is not valid for this transaction.',
    clearing_account_unavailable: 'The transaction service is temporarily unavailable. No funds were moved.',
  };
  return messages[reason] ?? error?.message ?? 'The transaction could not be completed.';
}

export default function FinancialTransactionPage({ type, onNavigate }) {
  const details = transactionDetails[type];
  const { user, request, refreshAccounts, accountRefreshVersion, selectedAccountId, setSelectedAccountId } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState({});
  const restoredAttempt = useMemo(() => initialAttempt(user.id, details.type), [user.id, details.type]);
  const [sourceAccountId, setSourceAccountId] = useState(
    restoredAttempt?.payload?.sourceAccountId ?? restoredAttempt?.payload?.accountId ?? selectedAccountId ?? '',
  );
  const [destinationAccountId, setDestinationAccountId] = useState(restoredAttempt?.payload?.destinationAccountId ?? '');
  const [amount, setAmount] = useState(restoredAttempt?.payload?.amountPaise ? formatPaiseForInput(restoredAttempt.payload.amountPaise) : '');
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountError, setAccountError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [attempt, setAttempt] = useState(restoredAttempt);
  const [stage, setStage] = useState(restoredAttempt?.state === 'uncertain' || restoredAttempt?.state === 'conflict' ? 'result' : restoredAttempt ? 'review' : 'form');
  const [outcome, setOutcome] = useState(restoredAttempt?.state === 'uncertain'
    ? { kind: 'uncertain', message: 'This earlier request has no confirmed response. Retry the same request to check its original idempotent result.' }
    : restoredAttempt?.state === 'conflict'
      ? { kind: 'conflict', message: 'The server reported that this key was already used with a different request payload.' }
      : null);
  const [submitting, setSubmitting] = useState(false);
  const submissionGuard = useRef(createSubmissionGuard());

  useEffect(() => {
    const controller = new AbortController();
    setAccountsLoading(true);
    setAccountError('');
    fetchAccounts(request, { signal: controller.signal }).then(async (items) => {
      if (controller.signal.aborted) return;
      setAccounts(items);
      const savedAccount = restoredAttempt?.payload?.sourceAccountId ?? restoredAttempt?.payload?.accountId;
      const nextSource = savedAccount ?? (items.some((item) => item.id === selectedAccountId) ? selectedAccountId : items[0]?.id ?? '');
      if (!savedAccount && nextSource) setSourceAccountId(nextSource);
      if (!items.some((item) => item.id === selectedAccountId)) setSelectedAccountId(nextSource || null);

      const accountBalances = await Promise.all(items.map(async (account) => {
        try {
          const balance = await fetchAccountBalance(request, account.id, { signal: controller.signal });
          return [account.id, { balancePaise: String(balance.balancePaise), currencyCode: balance.currencyCode }];
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          return [account.id, { error }];
        }
      }));
      if (!controller.signal.aborted) setBalances(Object.fromEntries(accountBalances));
      if (type === 'transfer' && !restoredAttempt?.payload?.destinationAccountId) {
        setDestinationAccountId(items.find((item) => item.id !== nextSource)?.id ?? '');
      }
    }).catch((error) => {
      if (error.name !== 'AbortError') {
        setAccountError(error.status === 403
          ? 'Your role does not permit this account operation.'
          : error.status === 401
            ? 'Your session has expired. Sign in again to continue.'
            : error.message || 'Accounts could not be loaded.');
      }
    }).finally(() => { if (!controller.signal.aborted) setAccountsLoading(false); });
    return () => controller.abort();
  }, [accountRefreshVersion, request, restoredAttempt, setSelectedAccountId, type]);

  const sourceAccount = accounts.find((account) => account.id === sourceAccountId);
  const destinationAccount = accounts.find((account) => account.id === destinationAccountId);
  const sourceBalance = balances[sourceAccountId];
  const destinationBalance = balances[destinationAccountId];
  const isTransfer = type === 'transfer';
  const isDeposit = type === 'deposit';

  function resetForNewTransaction() {
    clearPendingTransaction(user.id, details.type);
    setAttempt(null);
    setOutcome(null);
    setAmount('');
    setAmountError('');
    setStage('form');
  }

  function reviewTransaction(event) {
    event.preventDefault();
    setAmountError('');
    let amountPaise;
    try {
      amountPaise = parseInrToPaise(amount);
    } catch (error) {
      setAmountError(error.message);
      return;
    }
    if (!sourceAccountId || !sourceAccount) {
      setAmountError('Choose an account returned by your account list.');
      return;
    }
    if (isTransfer && accounts.length < 2) {
      setAmountError('Transfer requires at least two accounts. You currently have 1 account available.');
      return;
    }
    if (isTransfer && (!destinationAccountId || !destinationAccount)) {
      setAmountError('Choose a destination account number.');
      return;
    }
    if (isTransfer && sourceAccountId === destinationAccountId) {
      setAmountError('Source and destination accounts must be different.');
      return;
    }

    const payload = {
      type: details.type,
      ...(isDeposit ? { accountId: sourceAccountId } : {}),
      ...(type === 'withdrawal' ? { accountId: sourceAccountId } : {}),
      ...(isTransfer ? { sourceAccountId, destinationAccountId } : {}),
      sourceAccountNumber: sourceAccount?.accountNumber,
      destinationAccountNumber: destinationAccount?.accountNumber,
      amountPaise,
    };

    if (attempt?.state === 'uncertain' && attempt.payloadKey !== undefined) {
      setOutcome({ kind: 'uncertain', message: 'This request has an uncertain result. Retry the exact same details with its existing key before starting any other transaction.' });
      setStage('result');
      return;
    }

    try {
      const prepared = createTransactionAttempt(attempt, payload);
      savePendingTransaction(user.id, details.type, prepared);
      setAttempt(prepared);
      setOutcome(null);
      setStage('review');
    } catch {
      setAmountError('A secure transaction key could not be prepared. Check browser storage and use a supported secure browser.');
    }
  }

  async function submitPrepared(prepared = attempt) {
    if (!prepared || !submissionGuard.current.tryBegin()) return;
    setSubmitting(true);
    setOutcome(null);
    const inFlightAttempt = { ...prepared, state: 'uncertain' };
    try {
      savePendingTransaction(user.id, details.type, inFlightAttempt);
      setAttempt(inFlightAttempt);
    } catch {
      setOutcome({ kind: 'error', message: 'The request was not sent because its idempotency key could not be saved safely.' });
      setStage('result');
      submissionGuard.current.finish();
      setSubmitting(false);
      return;
    }
    try {
      const body = isTransfer
        ? {
            sourceAccountId: inFlightAttempt.payload.sourceAccountId,
            destinationAccountId: inFlightAttempt.payload.destinationAccountId,
            amountPaise: inFlightAttempt.payload.amountPaise,
          }
        : {
            accountId: inFlightAttempt.payload.accountId,
            amountPaise: inFlightAttempt.payload.amountPaise,
          };
      const result = await request(details.endpoint, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': inFlightAttempt.idempotencyKey },
      });
      if (result.status !== 'POSTED' || !result.journalTransactionId) {
        const unexpected = new ApiError('The server response did not confirm a posted transaction.', 502, result);
        throw unexpected;
      }

      const sourceNum = inFlightAttempt.payload.sourceAccountNumber || sourceAccount?.accountNumber;
      const destNum = inFlightAttempt.payload.destinationAccountNumber || destinationAccount?.accountNumber;
      const formattedAmount = formatPaiseAsINR(inFlightAttempt.payload.amountPaise);
      const successMessage = isDeposit
        ? `Successfully deposited ${formattedAmount} into Account ${sourceNum || ''}. Funds have been credited.`
        : type === 'withdrawal'
          ? `Successfully withdrew ${formattedAmount} from Account ${sourceNum || ''}. Funds have been debited.`
          : `Successfully transferred ${formattedAmount} from Account ${sourceNum || ''} to Account ${destNum || ''}. Account ${sourceNum} was debited and Account ${destNum} was credited.`;

      clearPendingTransaction(user.id, details.type);
      setAttempt(null);
      setOutcome({
        kind: 'posted',
        result,
        message: successMessage,
        payload: {
          ...inFlightAttempt.payload,
          sourceAccountNumber: sourceNum,
          destinationAccountNumber: destNum,
        },
      });
      setStage('result');
      refreshAccounts();
    } catch (error) {
      if (error?.payload?.status === 'REFUSED') {
        clearPendingTransaction(user.id, details.type);
        setAttempt(null);
        setOutcome({
          kind: 'refused',
          reason: error.payload.reason,
          message: getReason(error),
          payload: inFlightAttempt.payload,
          httpStatus: error.status,
        });
        setStage('result');
        refreshAccounts();
      } else if (error?.payload?.error === 'idempotency_key_conflict') {
        const conflictAttempt = { ...inFlightAttempt, state: 'conflict' };
        try { savePendingTransaction(user.id, details.type, conflictAttempt); } catch { /* the conflict is still shown for this page */ }
        setAttempt(conflictAttempt);
        setOutcome({ kind: 'conflict', message: 'This idempotency key belongs to a different request. No new key was generated automatically.' });
        setStage('result');
      } else if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) {
        const uncertainAttempt = { ...inFlightAttempt, state: 'uncertain' };
        try { savePendingTransaction(user.id, details.type, uncertainAttempt); } catch { /* keep the in-memory key available for same-page retry */ }
        setAttempt(uncertainAttempt);
        setOutcome({ kind: 'uncertain', message: 'The server did not confirm the result. The transaction may have completed. Retry this exact request with the same key; do not start a new transaction.' });
        setStage('result');
      } else {
        const retryableAttempt = { ...inFlightAttempt, state: 'review' };
        try { savePendingTransaction(user.id, details.type, retryableAttempt); } catch { /* in-memory retry uses the original key */ }
        setAttempt(retryableAttempt);
        setOutcome({ kind: 'error', message: error instanceof ApiError ? getReason(error) : 'The request could not be completed.', payload: inFlightAttempt.payload });
        setStage('result');
      }
    } finally {
      submissionGuard.current.finish();
      setSubmitting(false);
    }
  }

  const displayAmount = (paise) => formatPaiseAsINR(paise, 'INR');
  const sourceBalancePaise = sourceBalance && !sourceBalance.error ? BigInt(sourceBalance.balancePaise) : null;
  let exceedsBalance = false;
  try {
    exceedsBalance = (type === 'withdrawal' || isTransfer) && sourceBalancePaise !== null
      && amount.trim() !== '' && BigInt(parseInrToPaise(amount)) > sourceBalancePaise;
  } catch {
    // The field-level validation below describes malformed or out-of-range values.
  }

  return (
    <section className="transaction-page">
      <button className="back-link" onClick={() => onNavigate('/dashboard')}>← <span>Back to overview</span></button>
      <div className="transaction-page-heading"><span className="section-kicker">SECURE MONEY MOVEMENT</span><h1>{details.title}</h1><p>{details.intro}</p></div>

      {stage === 'result' ? (
        <TransactionResult
          outcome={outcome}
          attempt={attempt}
          submitting={submitting}
          onRetry={() => submitPrepared(attempt)}
          onEdit={() => setStage('form')}
          onNew={resetForNewTransaction}
          accounts={accounts}
          onNavigate={onNavigate}
        />
      ) : accountsLoading ? (
        <div className="loading-row"><span className="spinner spinner-dark" />Loading permitted accounts</div>
      ) : accountError ? (
        <div className="account-error-panel" role="alert"><span className="error-mark">!</span><div><strong>Accounts could not be loaded</strong><p>{accountError}</p></div><button className="button button-outline" onClick={() => refreshAccounts()}>Retry</button></div>
      ) : accounts.length === 0 ? (
        <div className="empty-state transaction-empty"><strong>No accounts available</strong><p>Money movement requires an account returned by your account access list.</p></div>
      ) : stage === 'form' ? (
        <form className="transaction-form-card" onSubmit={reviewTransaction}>
          <div className="transaction-form-top">
            <span className="transaction-type-mark">{isDeposit ? '↓' : isTransfer ? '↗' : '↑'}</span>
            <div><strong>{details.title} details</strong><small>Amounts are entered in Indian rupees (INR).</small></div>
          </div>
          <div className={`transaction-fields ${isTransfer ? 'transaction-fields-transfer' : ''}`}>
            <label className="field-label">
              <span>{isDeposit ? 'Deposit to account number (Credit)' : isTransfer ? 'From account number (Debit)' : 'Withdraw from account number (Debit)'}</span>
              <select
                value={sourceAccountId}
                onChange={(event) => {
                  setSourceAccountId(event.target.value);
                  setSelectedAccountId(event.target.value);
                  if (isTransfer && event.target.value === destinationAccountId) {
                    setDestinationAccountId(accounts.find((account) => account.id !== event.target.value)?.id ?? '');
                  }
                }}
                required
              >
                <option value="" disabled>Select account number</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    Account {account.accountNumber} ({account.type})
                  </option>
                ))}
              </select>
            </label>
            {isTransfer && (
              <label className="field-label">
                <span>To account number (Credit)</span>
                <select
                  value={destinationAccountId}
                  onChange={(event) => setDestinationAccountId(event.target.value)}
                  required
                >
                  <option value="" disabled>Select destination account number</option>
                  {accounts.filter((account) => account.id !== sourceAccountId).map((account) => (
                    <option key={account.id} value={account.id}>
                      Account {account.accountNumber} ({account.type})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field-label amount-field">
              <span>Amount</span>
              <span className="amount-input-wrap">
                <span aria-hidden="true">₹</span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={24}
                  value={amount}
                  onChange={(event) => { setAmount(event.target.value); setAmountError(''); }}
                  placeholder="0.00"
                  aria-describedby="amount-help"
                  required
                />
              </span>
              <small id="amount-help" className="field-hint">Up to two decimal places. The server rechecks available funds before posting.</small>
            </label>
          </div>
          {isTransfer && accounts.length < 2 && (
            <div className="transfer-help-banner">
              Transfer moves money between accounts. You currently have 1 account available. Please open an additional account or ensure destination accounts are assigned to your profile.
            </div>
          )}
          {sourceAccount && (
            <div className="selected-account-summary">
              <span className="account-summary-icon">{sourceAccount.type === 'BUSINESS' ? 'B' : 'P'}</span>
              <div>
                <strong>Account Number: {sourceAccount.accountNumber}</strong>
                <small>{isTransfer ? 'Debit account (Funds deducted)' : isDeposit ? 'Deposit account (Funds credited)' : 'Withdrawal account (Funds deducted)'} · {sourceAccount.type} · {sourceAccount.currencyCode}</small>
              </div>
              {sourceBalance && !sourceBalance.error && (
                <span className="summary-balance">{formatPaiseAsINR(sourceBalance.balancePaise, sourceBalance.currencyCode)}</span>
              )}
            </div>
          )}
          {isTransfer && destinationAccount && (
            <div className="selected-account-summary destination-summary">
              <span className="account-summary-icon">{destinationAccount.type === 'BUSINESS' ? 'B' : 'P'}</span>
              <div>
                <strong>Account Number: {destinationAccount.accountNumber}</strong>
                <small>Credit account (Funds credited) · {destinationAccount.type} · {destinationAccount.currencyCode}</small>
              </div>
              {destinationBalance && !destinationBalance.error && (
                <span className="summary-balance">{formatPaiseAsINR(destinationBalance.balancePaise, destinationBalance.currencyCode)}</span>
              )}
            </div>
          )}
          {sourceBalance?.error && <p className="balance-unavailable-note">The current balance could not be loaded. The server will validate the transaction.</p>}
          {exceedsBalance && <div className="balance-warning" role="status">The amount exceeds the displayed balance. The backend is authoritative and will refuse an overdraft.</div>}
          {amountError && <div className="form-error" role="alert"><span>!</span>{amountError}</div>}
          <div className="transaction-form-footer">
            <span><i /> All postings are confirmed by the secure ledger.</span>
            <button className="button button-primary" type="submit">
              Review {details.verb}<span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      ) : stage === 'review' ? (
        <div className="transaction-review-card" role="region" aria-labelledby="transaction-review-title">
          <div className="review-topline"><span className="section-kicker">FINAL CHECK</span><span className="review-step">STEP 2 OF 2</span></div>
          <h2 id="transaction-review-title">Review your {details.verb}</h2>
          <p className="review-description">Check the details carefully before sending this request to the ledger.</p>
          <div className="review-route">
            <ReviewParty
              label={isDeposit ? 'DEPOSIT TO (CREDITED)' : isTransfer ? 'DEBIT FROM ACCOUNT' : 'WITHDRAW FROM (DEBITED)'}
              account={sourceAccount ?? accountFromPayload(accounts, attempt?.payload, 'source')}
            />
            {isTransfer ? (
              <>
                <span className="review-route-arrow">→</span>
                <ReviewParty
                  label="CREDIT TO ACCOUNT"
                  account={destinationAccount ?? accountFromPayload(accounts, attempt?.payload, 'destination')}
                />
              </>
            ) : null}
          </div>
          <div className="review-amount">
            <span>AMOUNT</span>
            <strong>{attempt?.payload?.amountPaise ? displayAmount(attempt.payload.amountPaise) : '—'}</strong>
          </div>
          <div className="idempotency-note">
            <span className="idempotency-lock">✓</span>
            <p>A unique request key is saved for this transaction. If the connection is interrupted, retrying uses the same key and payload.</p>
          </div>
          <div className="review-actions">
            <button className="button button-outline" onClick={() => setStage('form')} disabled={submitting}>Back to edit</button>
            <button className="button button-primary" onClick={() => submitPrepared()} disabled={submitting}>
              {submitting ? <><span className="spinner" />Submitting…</> : <>Confirm and submit <span aria-hidden="true">→</span></>}
            </button>
          </div>
        </div>
      ) : null}

      <p className="transaction-security-note">No balance is changed in the browser. The backend authorizes each request, enforces idempotency, and confirms ledger postings.</p>
    </section>
  );
}

function ReviewParty({ label, account }) {
  return (
    <div className="review-party">
      <span>{label}</span>
      <strong>Account {account?.accountNumber ?? 'Selected account'}</strong>
      <small>{account ? `${account.type === 'BUSINESS' ? 'Business Account' : 'Personal Account'} · ${account.currencyCode}` : 'Account details unavailable'}</small>
    </div>
  );
}

function accountFromPayload(accounts, payload, side) {
  const id = side === 'destination' ? payload?.destinationAccountId : payload?.sourceAccountId ?? payload?.accountId;
  return accounts.find((account) => account.id === id);
}

function TransactionResult({ outcome, attempt, submitting, onRetry, onEdit, onNew, accounts = [], onNavigate }) {
  if (!outcome) return <div className="transaction-result-card"><div className="loading-row"><span className="spinner spinner-dark" />Preparing transaction result</div></div>;
  const posted = outcome.kind === 'posted';
  const refused = outcome.kind === 'refused';
  const uncertain = outcome.kind === 'uncertain';
  const conflict = outcome.kind === 'conflict';
  const payload = outcome.payload ?? attempt?.payload;
  const amountPaise = outcome.result?.amountPaise ?? payload?.amountPaise;
  const reference = outcome.result?.journalTransactionId;
  const typeName = payload?.type === 'DEPOSIT' ? 'Deposit' : payload?.type === 'WITHDRAWAL' ? 'Withdrawal' : 'Transfer';
  const isTransfer = payload?.type === 'TRANSFER';
  const isDeposit = payload?.type === 'DEPOSIT';

  const sourceId = payload?.sourceAccountId ?? payload?.accountId;
  const destinationId = payload?.destinationAccountId;
  const sourceNum = payload?.sourceAccountNumber ?? accounts.find((a) => a.id === sourceId)?.accountNumber ?? 'Account';
  const destinationNum = payload?.destinationAccountNumber ?? accounts.find((a) => a.id === destinationId)?.accountNumber ?? 'Account';

  return (
    <section className={`transaction-result-card result-${outcome.kind}`} aria-live="polite" aria-labelledby="transaction-result-title">
      <span className={`result-mark ${posted ? 'result-mark-success' : refused ? 'result-mark-refused' : 'result-mark-pending'}`}>
        {posted ? '✓' : refused ? '!' : uncertain ? '…' : conflict ? '!' : '×'}
      </span>
      <span className="section-kicker">
        {posted ? 'LEDGER CONFIRMATION' : refused ? 'REQUEST REFUSED' : uncertain ? 'CONFIRMATION PENDING' : conflict ? 'IDEMPOTENCY CONFLICT' : 'REQUEST ERROR'}
      </span>
      <h2 id="transaction-result-title">
        {posted ? `${typeName} successful` : refused ? 'Transaction was not posted' : uncertain ? 'Result not confirmed' : conflict ? 'Request key conflict' : 'Transaction could not be completed'}
      </h2>
      <p className="result-message">
        {outcome.message ?? outcome.reason}
      </p>

      {(posted || refused) && (
        <div className="result-receipt">
          <div>
            <span>Transaction Type</span>
            <strong>{typeName}</strong>
          </div>
          {isTransfer ? (
            <>
              <div>
                <span>From Account (Debited)</span>
                <strong>Account Number {sourceNum}</strong>
              </div>
              <div>
                <span>To Account (Credited)</span>
                <strong>Account Number {destinationNum}</strong>
              </div>
            </>
          ) : isDeposit ? (
            <div>
              <span>Deposited To (Credited)</span>
              <strong>Account Number {sourceNum}</strong>
            </div>
          ) : (
            <div>
              <span>Withdrawn From (Debited)</span>
              <strong>Account Number {sourceNum}</strong>
            </div>
          )}
          <div>
            <span>Amount</span>
            <strong>{amountPaise ? formatPaiseAsINR(amountPaise) : '—'}</strong>
          </div>
          <div>
            <span>Status</span>
            <strong className={posted ? 'posted-text' : 'refused-text'}>
              {posted ? 'POSTED · SUCCESSFUL' : 'REFUSED'}
            </strong>
          </div>
          {reference && (
            <div>
              <span>Journal Reference</span>
              <strong className="receipt-reference">{reference}</strong>
            </div>
          )}
          {outcome.reason && (
            <div>
              <span>Reason</span>
              <strong>{outcome.reason.replaceAll('_', ' ')}</strong>
            </div>
          )}
        </div>
      )}

      {uncertain && (
        <div className="uncertain-warning">
          <strong>Do not create another request.</strong>
          <span>Use “Retry same request” to check the original result. The original key and exact payload are retained.</span>
        </div>
      )}
      {conflict && (
        <div className="uncertain-warning">
          <strong>No replacement key was created.</strong>
          <span>Starting a new transaction is a separate money movement request. Continue only if that is intentional.</span>
        </div>
      )}

      <div className="result-actions">
        {uncertain && (
          <button className="button button-primary" onClick={onRetry} disabled={submitting}>
            {submitting ? <><span className="spinner" />Checking…</> : 'Retry same request'}
          </button>
        )}
        {outcome.kind === 'error' && (
          <button className="button button-outline" onClick={onEdit}>
            Edit details
          </button>
        )}
        {(posted || refused || conflict || outcome.kind === 'error') && (
          <button className="button button-outline" onClick={onNew}>
            Start another transaction
          </button>
        )}
        {posted && (
          <button className="button button-primary" onClick={() => onNavigate?.('/dashboard')}>
            Back to Overview
          </button>
        )}
        {posted && isTransfer && reference && (
          <button className="button button-outline" onClick={() => onNavigate?.(`/transfers/${encodeURIComponent(reference)}`)}>
            View transfer details
          </button>
        )}
        {(posted || refused) && (
          <span className="result-confirmed-note">
            {posted ? 'Confirmed and posted to the secure ledger.' : 'Refusal recorded by the backend.'}
          </span>
        )}
      </div>
    </section>
  );
}
