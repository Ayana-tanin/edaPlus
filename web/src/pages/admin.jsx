import { useState } from 'react';
import { Link, Navigate, Outlet } from 'react-router-dom';
import { api, useApi } from '../api.js';
import { Async, Empty, ErrorBox, Icon, OfferStateBadge, PageHeader, SubNav, useDebounced } from '../components.jsx';
import { ManagedOrderCard } from './orderCard.jsx';
import { STATUS_LABELS, formatPickup, userName } from '../format.js';
import { useMoney, useSession } from '../state.jsx';

export function AdminLayout() {
  const { me } = useSession();
  if (!me.isAdmin) return <Navigate to="/profile" replace />;
  return (
    <div className="page cabinet">
      <div className="cabinet-top">
        <Link to="/profile" className="back-link">← В приложение</Link>
        <strong>Главный админ</strong>
      </div>
      <SubNav
        items={[
          { to: '/admin', label: 'Заведения', end: true },
          { to: '/admin/users', label: 'Пользователи' },
          { to: '/admin/offers', label: 'Предложения' },
          { to: '/admin/orders', label: 'Заказы' },
        ]}
      />
      <Outlet />
    </div>
  );
}

const emptyVenue = { name: '', city: '', address: '', phone: '', lat: '', lng: '', isActive: true };

function VenueForm({ initial, onSave, onCancel }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: form.name,
        city: form.city,
        address: form.address,
        phone: form.phone || null,
        lat: form.lat === '' ? null : Number(form.lat),
        lng: form.lng === '' ? null : Number(form.lng),
        isActive: form.isActive,
      });
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="card form">
      <label className="field"><span>Название</span><input required value={form.name} onChange={set('name')} /></label>
      <div className="field-row">
        <label className="field"><span>Город</span><input required value={form.city} onChange={set('city')} /></label>
        <label className="field"><span>Телефон</span><input type="tel" value={form.phone ?? ''} onChange={set('phone')} /></label>
      </div>
      <label className="field"><span>Адрес</span><input required value={form.address} onChange={set('address')} /></label>
      <div className="field-row">
        <label className="field"><span>Широта</span><input type="number" step="any" min="-90" max="90" value={form.lat ?? ''} onChange={set('lat')} /></label>
        <label className="field"><span>Долгота</span><input type="number" step="any" min="-180" max="180" value={form.lng ?? ''} onChange={set('lng')} /></label>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
        Заведение активно
      </label>
      <ErrorBox error={error} />
      <div className="actions">
        <button type="submit" className="btn btn-primary btn-small" disabled={saving}>Сохранить</button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>Отмена</button>
      </div>
    </form>
  );
}

function PartnerAccess({ venue, onChange }) {
  const [user, setUser] = useState('');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function run(call) {
    setError(null);
    setNotice(null);
    try {
      await call();
      await onChange();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="partners">
      <div className="small muted">Админы кафе</div>
      {venue.partners.map((p) => (
        <div key={p.id} className="between small">
          <span>{userName(p)} <span className="muted">· {p.id}</span></span>
          <button type="button" className="btn-link text-danger" onClick={() => run(() => api(`/admin/venues/${venue.id}/partners/${p.id}`, { method: 'DELETE' }))}>
            Убрать
          </button>
        </div>
      ))}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const result = await api(`/admin/venues/${venue.id}/partners`, { method: 'POST', body: { user } });
            setUser('');
            setNotice(result.notice);
          });
        }}
      >
        <input aria-label="Telegram ID или @username" placeholder="Telegram ID или @username" value={user} onChange={(e) => setUser(e.target.value)} />
        <button type="submit" className="btn btn-small btn-ghost" disabled={!user.trim()}>Добавить админа</button>
      </form>
      <ErrorBox error={error} />
      {notice && <div className="notice notice-success small" role="status">{notice}</div>}
    </div>
  );
}

export function AdminVenues() {
  const venues = useApi('/admin/venues');
  const [editing, setEditing] = useState(null);

  return (
    <>
      <PageHeader
        title="Заведения"
        action={
          <button type="button" className="btn btn-primary btn-small" onClick={() => setEditing('new')}>
            <Icon name="plus" size={16} />Добавить
          </button>
        }
      />
      {editing === 'new' && (
        <VenueForm
          initial={emptyVenue}
          onCancel={() => setEditing(null)}
          onSave={async (body) => {
            await api('/admin/venues', { method: 'POST', body });
            setEditing(null);
            await venues.reload();
          }}
        />
      )}
      <Async state={venues}>
        {(list) =>
          list.length ? (
            <div className="stack">
              {list.map((v) =>
                editing === v.id ? (
                  <VenueForm
                    key={v.id}
                    initial={v}
                    onCancel={() => setEditing(null)}
                    onSave={async (body) => {
                      await api(`/admin/venues/${v.id}`, { method: 'PATCH', body });
                      setEditing(null);
                      await venues.reload();
                    }}
                  />
                ) : (
                  <div key={v.id} className="card">
                    <div className="between">
                      <h3>{v.name}</h3>
                      {!v.isActive && <span className="badge offer-unavailable">Неактивно</span>}
                    </div>
                    <div className="small muted">{v.city}, {v.address}{v.phone ? ` · ${v.phone}` : ''}</div>
                    <div className="actions">
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(v.id)}>Изменить</button>
                    </div>
                    <PartnerAccess venue={v} onChange={venues.reload} />
                  </div>
                ),
              )}
            </div>
          ) : (
            <Empty title="Заведений пока нет" />
          )
        }
      </Async>
    </>
  );
}

export function AdminUsers() {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const users = useApi(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  return (
    <>
      <PageHeader title="Пользователи" />
      <label className="search-input">
        <Icon name="search" size={18} />
        <input type="search" placeholder="Имя, @username или ID" aria-label="Поиск пользователей" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <Async state={users}>
        {(list) =>
          list.length ? (
            <div className="stack">
              {list.map((u) => (
                <div key={u.id} className="card">
                  <div className="between">
                    <h3>{userName(u)}</h3>
                    {u.isAdmin && <span className="badge">Главный админ</span>}
                  </div>
                  <div className="small muted">
                    ID {u.id}{u.username ? ` · @${u.username}` : ''} · заказов: {u.ordersCount}
                  </div>
                  {u.venues && <div className="small">Админ кафе: {u.venues}</div>}
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Никого не нашли" />
          )
        }
      </Async>
    </>
  );
}

export function AdminOffers() {
  const money = useMoney();
  const offers = useApi('/admin/offers');
  const [error, setError] = useState(null);

  async function toggle(o) {
    setError(null);
    try {
      await api(`/admin/offers/${o.id}`, { method: 'PATCH', body: { isHidden: !o.isHidden } });
      await offers.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <PageHeader title="Предложения" />
      <ErrorBox error={error} />
      <Async state={offers}>
        {(list) =>
          list.length ? (
            <div className="stack">
              {list.map((o) => (
                <div key={o.id} className="card cabinet-offer">
                  <img src={o.photo} alt="" />
                  <div className="grow">
                    <div className="between">
                      <h3>{o.name}</h3>
                      {o.isHidden ? <span className="badge offer-unavailable">Скрыто</span> : !o.isPublished ? <span className="badge">В архиве</span> : <OfferStateBadge state={o.state} />}
                    </div>
                    <div className="small muted">{o.venueName} · {formatPickup(o.pickupStart, o.pickupEnd)}</div>
                    <div className="small">{money(o.priceDiscounted)} · Осталось: {o.quantity}</div>
                    <div className="actions">
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => toggle(o)}>
                        {o.isHidden ? 'Показать' : 'Скрыть'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Предложений нет" />
          )
        }
      </Async>
    </>
  );
}

export function AdminOrders() {
  const [status, setStatus] = useState('');
  const orders = useApi(`/admin/orders${status ? `?status=${status}` : ''}`);
  return (
    <>
      <PageHeader title="Заказы" />
      <div className="chips">
        <button type="button" className={`chip ${!status ? 'chip-active' : ''}`} onClick={() => setStatus('')}>Все</button>
        {Object.entries(STATUS_LABELS).map(([key, label]) => (
          <button type="button" key={key} className={`chip ${status === key ? 'chip-active' : ''}`} onClick={() => setStatus(key)}>
            {label}
          </button>
        ))}
      </div>
      <Async state={orders}>
        {(list) =>
          list.length ? (
            <div className="stack">
              {list.map((o) => (
                <ManagedOrderCard
                  key={`${o.id}-${o.status}`}
                  order={o}
                  title={`№${o.id} · ${o.venueName}`}
                  path={`/admin/orders/${o.id}`}
                  showCode
                  quickReceive
                  onChanged={orders.reload}
                />
              ))}
            </div>
          ) : (
            <Empty title="Заказов нет" />
          )
        }
      </Async>
    </>
  );
}
