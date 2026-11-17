import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, useApi } from '../api.js';
import { Async, BackLink, Empty, ErrorBox, Icon, OfferStateBadge, PageHeader, StatusBadge, SubNav } from '../components.jsx';
import { ManagedOrderCard } from './orderCard.jsx';
import { STATUS_LABELS, formatPickup } from '../format.js';
import { useMoney, useSession } from '../state.jsx';
import { haptic } from '../telegram.js';

const VENUE_KEY = 'eda.partnerVenue';

function savedVenue() {
  try {
    return Number(localStorage.getItem(VENUE_KEY));
  } catch {
    return 0;
  }
}

export function PartnerLayout() {
  const { me } = useSession();
  const [selected, setSelected] = useState(savedVenue);
  if (!me.venues.length) return <Navigate to="/profile" replace />;
  const venue = me.venues.find((v) => v.id === selected) ?? me.venues[0];

  function choose(id) {
    setSelected(id);
    try {
      localStorage.setItem(VENUE_KEY, String(id));
    } catch {
      // Выбор продержится до закрытия приложения.
    }
  }

  return (
    <div className="page cabinet">
      <div className="cabinet-top">
        <Link to="/profile" className="back-link">← В приложение</Link>
        {me.venues.length > 1 ? (
          <select aria-label="Заведение" value={venue.id} onChange={(e) => choose(Number(e.target.value))}>
            {me.venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        ) : (
          <strong>{venue.name}</strong>
        )}
      </div>
      <SubNav
        items={[
          { to: '/partner', label: 'Блюда', end: true },
          { to: '/partner/orders', label: 'Заказы' },
          { to: '/partner/pickup', label: 'Выдача' },
        ]}
      />
      <Outlet context={{ venue }} />
    </div>
  );
}

// Блюдо с прошедшим периодом гостям уже не показывается, поэтому его место тоже в архиве.
const isArchived = (o) => !o.isPublished || (o.state === 'unavailable' && !o.isHidden);

function offerBadge(o) {
  if (o.isHidden) return <span className="badge offer-unavailable">Скрыто главным админом</span>;
  if (!o.isPublished) return <span className="badge">В архиве</span>;
  if (o.state === 'unavailable') return <span className="badge">Период прошёл</span>;
  return <OfferStateBadge state={o.state} />;
}

export function PartnerOffers() {
  const { venue } = useOutletContext();
  const money = useMoney();
  const offers = useApi(`/partner/venues/${venue.id}/offers`);
  const [tab, setTab] = useState('active');
  const [error, setError] = useState(null);

  async function setPublished(offer, publish) {
    setError(null);
    try {
      await api(`/partner/offers/${offer.id}/${publish ? 'publish' : 'unpublish'}`, { method: 'POST' });
      await offers.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <PageHeader
        title="Блюда"
        action={<Link to="/partner/offers/new" className="btn btn-primary btn-small"><Icon name="plus" size={16} />Добавить</Link>}
      />
      <div className="segmented">
        <button type="button" className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>В каталоге</button>
        <button type="button" className={tab === 'archive' ? 'active' : ''} onClick={() => setTab('archive')}>Архив</button>
      </div>
      <ErrorBox error={error} />
      <Async state={offers}>
        {(all) => {
          const list = all.filter((o) => (tab === 'archive' ? isArchived(o) : !isArchived(o)));
          if (!list.length) {
            return tab === 'archive'
              ? <Empty title="Архив пуст">Блюда из архива не видны гостям. Их можно вернуть в каталог в любой момент.</Empty>
              : <Empty title="В каталоге пусто">Добавьте блюдо или верните его из архива.</Empty>;
          }
          return (
            <div className="stack">
              {list.map((o) => (
                <div key={o.id} className="card cabinet-offer">
                  <img src={o.photo} alt="" />
                  <div className="grow">
                    <div className="between">
                      <h3>{o.name}</h3>
                      {offerBadge(o)}
                    </div>
                    <div className="small muted">{formatPickup(o.pickupStart, o.pickupEnd)}</div>
                    <div className="small">{money(o.priceDiscounted)} · Осталось: {o.quantity} · Забронировано: {o.booked}</div>
                    <div className="actions">
                      <Link to={`/partner/offers/${o.id}`} className="btn btn-small btn-ghost">Изменить</Link>
                      {tab === 'active' && (
                        <button type="button" className="btn btn-small btn-ghost" onClick={() => setPublished(o, false)}>В архив</button>
                      )}
                      {tab === 'archive' && !o.isPublished && (
                        <button type="button" className="btn btn-small btn-ghost" onClick={() => setPublished(o, true)}>Вернуть в каталог</button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          );
        }}
      </Async>
    </>
  );
}

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const emptyForm = (category) => ({
  name: '', photo: '', description: '', ingredients: '', category,
  priceOriginal: '', priceDiscounted: '', quantity: '',
  date: todayLocal(), start: '', end: '',
});

function toForm(o) {
  return {
    name: o.name, photo: o.photo, description: o.description, ingredients: o.ingredients, category: o.category,
    priceOriginal: String(o.priceOriginal), priceDiscounted: String(o.priceDiscounted), quantity: String(o.quantity),
    date: o.pickupStart.slice(0, 10), start: o.pickupStart.slice(11), end: o.pickupEnd.slice(11),
  };
}

export function PartnerOfferForm() {
  const { id } = useParams();
  const { me } = useSession();
  const { venue } = useOutletContext();
  const navigate = useNavigate();
  const isNew = !id;
  const existing = useApi(isNew ? null : `/partner/offers/${id}`);
  const [form, setForm] = useState(() => emptyForm(me.categories[0]));
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const isInArchive = !isNew && existing.data && !existing.data.isPublished;

  useEffect(() => {
    if (existing.data) setForm(toForm(existing.data));
  }, [existing.data]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function uploadPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const data = new FormData();
      data.append('photo', file);
      const { url } = await api('/uploads', { method: 'POST', form: data });
      setForm((f) => ({ ...f, photo: url }));
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  // publish: true в каталог, false в архив, undefined оставить как есть.
  async function save(e, publish) {
    if (!e.currentTarget.form.reportValidity()) return;
    if (!form.photo) {
      setError(new Error('Добавьте фото'));
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      photo: form.photo,
      description: form.description,
      ingredients: form.ingredients,
      category: form.category,
      priceOriginal: Number(form.priceOriginal),
      priceDiscounted: Number(form.priceDiscounted),
      quantity: Number(form.quantity),
      pickupStart: `${form.date}T${form.start}`,
      pickupEnd: `${form.date}T${form.end}`,
      publish,
    };
    try {
      if (isNew) await api(`/partner/venues/${venue.id}/offers`, { method: 'POST', body });
      else await api(`/partner/offers/${id}`, { method: 'PATCH', body });
      haptic('success');
      navigate('/partner', { replace: true });
    } catch (err) {
      haptic('error');
      setError(err);
      setSaving(false);
    }
  }

  if (!isNew && existing.loading) return <Async state={existing}>{() => null}</Async>;
  if (!isNew && existing.error) return <ErrorBox error={existing.error} onRetry={existing.reload} />;

  return (
    <form onSubmit={(e) => e.preventDefault()} className="form">
      <BackLink />
      <PageHeader title={isNew ? 'Новое блюдо' : 'Редактирование'} />

      <div className="field">
        <span>Фото</span>
        <label className={`photo-picker ${form.photo ? 'has-photo' : ''}`}>
          {form.photo ? <img src={form.photo} alt="Фото предложения" /> : <span className="muted">{uploading ? 'Загружаем…' : 'Выбрать фото: JPG, PNG или WebP, до 5 МБ'}</span>}
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={uploadPhoto} disabled={uploading} />
        </label>
      </div>

      <label className="field"><span>Название</span><input required maxLength={120} value={form.name} onChange={set('name')} /></label>
      <label className="field">
        <span>Категория</span>
        <select value={form.category} onChange={set('category')}>
          {me.categories.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <label className="field"><span>Описание</span><textarea required rows={3} maxLength={2000} value={form.description} onChange={set('description')} /></label>
      <label className="field">
        <span>Состав и аллергены</span>
        <textarea required rows={3} maxLength={2000} value={form.ingredients} onChange={set('ingredients')} />
      </label>

      <div className="field-row">
        <label className="field"><span>Первоначальная цена, {me.currency}</span><input required type="number" inputMode="numeric" min="1" step="1" value={form.priceOriginal} onChange={set('priceOriginal')} /></label>
        <label className="field"><span>Цена со скидкой, {me.currency}</span><input required type="number" inputMode="numeric" min="1" step="1" value={form.priceDiscounted} onChange={set('priceDiscounted')} /></label>
      </div>

      <label className="field">
        <span>{isNew ? 'Количество' : 'Доступное количество'}</span>
        <input required type="number" inputMode="numeric" min="0" step="1" value={form.quantity} onChange={set('quantity')} />
        {!isNew && <small className="muted">Сделанные брони не изменятся.</small>}
      </label>

      <label className="field"><span>Дата получения</span><input required type="date" value={form.date} onChange={set('date')} /></label>
      <div className="field-row">
        <label className="field"><span>Начало</span><input required type="time" value={form.start} onChange={set('start')} /></label>
        <label className="field"><span>Конец</span><input required type="time" value={form.end} onChange={set('end')} /></label>
      </div>

      <ErrorBox error={error} />
      <div className="stack">
        {isNew || isInArchive ? (
          <>
            <button type="button" className="btn btn-primary btn-block" disabled={saving || uploading} onClick={(e) => save(e, true)}>
              {isNew ? 'Опубликовать' : 'Сохранить и вернуть в каталог'}
            </button>
            <button type="button" className="btn btn-ghost btn-block" disabled={saving || uploading} onClick={(e) => save(e, false)}>
              Сохранить в архив
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary btn-block" disabled={saving || uploading} onClick={(e) => save(e)}>
            Сохранить
          </button>
        )}
      </div>
    </form>
  );
}

export function PartnerOrders() {
  const { venue } = useOutletContext();
  const [status, setStatus] = useState('booked');
  const orders = useApi(`/partner/venues/${venue.id}/orders?status=${status}`);

  return (
    <>
      <PageHeader title="Заказы" />
      <div className="chips">
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
                  title={`№${o.id} · ${o.customerName || 'Покупатель'}`}
                  path={`/partner/orders/${o.id}`}
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

export function PartnerPickup() {
  const { venue } = useOutletContext();
  const money = useMoney();
  const [code, setCode] = useState('');
  const [order, setOrder] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function lookup(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOrder(null);
    setDone(false);
    try {
      setOrder(await api(`/partner/venues/${venue.id}/orders/lookup`, { method: 'POST', body: { code } }));
    } catch (err) {
      haptic('error');
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      setOrder(await api(`/partner/orders/${order.id}/complete`, { method: 'POST' }));
      setDone(true);
      setCode('');
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Выдача заказа" />
      <form onSubmit={lookup} className="pickup-form">
        <input
          className="code-input"
          aria-label="Код получения"
          placeholder="КОД"
          autoCapitalize="characters"
          autoComplete="off"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !code.trim()}>Проверить</button>
      </form>
      <ErrorBox error={error} />
      {done && <div className="notice notice-success" role="status"><strong>Заказ выдан</strong></div>}
      {order && (
        <div className="card order-card">
          <div className="between">
            <h3>№{order.id} · {order.customerName || 'Покупатель'}</h3>
            <StatusBadge status={order.status} />
          </div>
          {order.items.map((i) => (
            <div key={i.id} className="between item-line">
              <span>{i.name} × {i.quantity}</span>
              <span>{money(i.price * i.quantity)}</span>
            </div>
          ))}
          <div className="between total-line">
            <strong>К оплате</strong>
            <strong>{money(order.total)}</strong>
          </div>
          <div className="small muted">{formatPickup(order.pickupStart, order.pickupEnd)}</div>
          {order.status === 'booked' ? (
            <button type="button" className="btn btn-primary btn-block" onClick={complete} disabled={busy}>
              Подтвердить выдачу
            </button>
          ) : !done && (
            <p className="small text-danger">
              {order.status === 'received' ? 'Этот код уже использован.' : 'Заказ не активен, выдача невозможна.'}
            </p>
          )}
        </div>
      )}
    </>
  );
}
