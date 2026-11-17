import { useState } from 'react';
import { api } from '../api.js';
import { ErrorBox, StatusBadge } from '../components.jsx';
import { STATUS_LABELS, formatDateTime, formatPickup } from '../format.js';
import { useMoney } from '../state.jsx';

const ROLE_LABELS = { buyer: 'покупатель', partner: 'админ кафе', admin: 'главный админ', system: 'система' };

/** Заказ со сменой статуса и историей: общий для кабинета кафе и главного админа. */
export function ManagedOrderCard({ order, title, path, showCode = false, quickReceive = false, onChanged }) {
  const money = useMoney();
  const [status, setStatus] = useState(order.status);
  const [comment, setComment] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function apply(nextStatus) {
    setSaving(true);
    setError(null);
    try {
      await api(path, { method: 'PATCH', body: { status: nextStatus, comment: comment || undefined } });
      setComment('');
      await onChanged();
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="card order-card">
      <div className="between">
        <h3>{title}</h3>
        <StatusBadge status={order.status} />
      </div>
      <div className="small">{order.items.map((i) => `${i.name} × ${i.quantity}`).join(', ')}</div>
      <div className="small muted">
        {showCode && `${order.customerName || 'Покупатель'} · код ${order.code} · `}
        {money(order.total)} · {formatPickup(order.pickupStart, order.pickupEnd)}
      </div>
      {quickReceive && order.status === 'booked' && (
        <button type="button" className="btn btn-primary btn-block" disabled={saving} onClick={() => apply('received')}>
          Отметить как полученный
        </button>
      )}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply(status);
        }}
      >
        <select aria-label="Новый статус" value={status} onChange={(e) => setStatus(e.target.value)}>
          {Object.entries(STATUS_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <input aria-label="Комментарий" placeholder="Комментарий" maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} />
        <button type="submit" className="btn btn-small btn-ghost" disabled={saving || status === order.status}>Изменить статус</button>
      </form>
      <ErrorBox error={error} />
      <details className="history">
        <summary className="small muted">История статусов ({order.history.length})</summary>
        <ul>
          {order.history.map((h, i) => (
            <li key={i} className="small">
              {formatDateTime(h.createdAt)}: {h.from ? `${STATUS_LABELS[h.from]} → ` : ''}{STATUS_LABELS[h.to]}
              <span className="muted"> ({ROLE_LABELS[h.actorRole] ?? h.actorRole}){h.comment ? `, ${h.comment}` : ''}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
