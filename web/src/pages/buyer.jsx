import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, getDevUser, setDevUser, useApi } from '../api.js';
import {
  Async, BackLink, CartBar, Empty, ErrorBox, FavoriteButton, Icon, OfferCard, OfferStateBadge,
  PageHeader, Price, StatusBadge, useDebounced,
} from '../components.jsx';
import { discountPercent, formatPickup, userName } from '../format.js';
import { useCart, useFavorites, useMoney, useSession } from '../state.jsx';
import { confirmDialog, haptic } from '../telegram.js';

function OfferGrid({ offers }) {
  return (
    <div className="grid">
      {offers.map((o) => (
        <OfferCard key={o.id} offer={o} />
      ))}
    </div>
  );
}

const qs = (params) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  return s ? `?${s}` : '';
};

export function Home() {
  const { me } = useSession();
  const [mode, setMode] = useState('offers');
  const [category, setCategory] = useState(null);
  const offers = useApi(mode === 'offers' ? `/offers${qs({ city: me.city, category })}` : null);

  return (
    <div className="page">
      <header className="home-header">
        <div className="logo">
          eda<span>+</span>
        </div>
        <Link to="/profile" className="city row-icon">
          <Icon name="pin" size={16} />
          {me.city}
        </Link>
      </header>

      <Link to="/search" className="search-link">
        <Icon name="search" size={18} />
        Найти набор или заведение
      </Link>

      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'offers'} className={mode === 'offers' ? 'active' : ''} onClick={() => setMode('offers')}>
          Наборы
        </button>
        <button type="button" role="tab" aria-selected={mode === 'venues'} className={mode === 'venues' ? 'active' : ''} onClick={() => setMode('venues')}>
          Заведения
        </button>
      </div>

      {mode === 'offers' ? (
        <>
          <div className="chips">
            <button type="button" className={`chip ${!category ? 'chip-active' : ''}`} onClick={() => setCategory(null)}>
              Все
            </button>
            {me.categories.map((c) => (
              <button type="button" key={c} className={`chip ${category === c ? 'chip-active' : ''}`} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
          <Async state={offers}>
            {(list) =>
              list.length ? (
                <OfferGrid offers={list} />
              ) : (
                <Empty title="Пока нет предложений">Загляните ближе к вечеру: заведения добавляют наборы в течение дня.</Empty>
              )
            }
          </Async>
        </>
      ) : (
        <Venues />
      )}
      <CartBar />
    </div>
  );
}

function Venues() {
  const { me } = useSession();
  const money = useMoney();
  const [view, setView] = useState('list');
  const [coords, setCoords] = useState(null);
  const [geoState, setGeoState] = useState('idle');
  const venues = useApi(`/venues${qs({ city: me.city, lat: coords?.lat, lng: coords?.lng })}`);

  function locate() {
    if (!navigator.geolocation) {
      setGeoState('failed');
      return;
    }
    setGeoState('loading');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setCoords({ lat: p.coords.latitude, lng: p.coords.longitude });
        setGeoState('idle');
      },
      () => setGeoState('failed'),
      { timeout: 10000 },
    );
  }

  return (
    <>
      <div className="toolbar">
        <div className="segmented segmented-small">
          <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            Список
          </button>
          <button type="button" className={view === 'map' ? 'active' : ''} onClick={() => setView('map')}>
            Карта
          </button>
        </div>
        {view === 'list' && (
          <button type="button" className="btn btn-small btn-ghost" onClick={locate} disabled={geoState === 'loading'}>
            <Icon name="pin" size={16} />
            {geoState === 'loading' ? 'Определяем…' : 'Рядом со мной'}
          </button>
        )}
      </div>
      {geoState === 'failed' && <p className="small muted">Не удалось определить местоположение. Разрешите доступ к геолокации или выберите заведение из списка.</p>}

      {view === 'map' ? (
        <Empty title="Карта появится позже">Пока заведения можно посмотреть списком.</Empty>
      ) : (
        <Async state={venues}>
          {(list) =>
            list.length ? (
              <div className="stack">
                {list.map((v) => (
                  <Link key={v.id} to={`/venues/${v.id}`} className="card venue-card">
                    <div className="grow">
                      <h3>{v.name}</h3>
                      <div className="small muted">{v.address}</div>
                      <div className="small venue-meta">
                        {v.offersCount ? `${v.offersCount} предл. · от ${money(v.minPrice)}` : 'Сейчас нет предложений'}
                      </div>
                    </div>
                    {v.distanceKm != null && <span className="badge">{v.distanceKm} км</span>}
                  </Link>
                ))}
              </div>
            ) : (
              <Empty title="В этом городе пока нет заведений" />
            )
          }
        </Async>
      )}
    </>
  );
}

export function VenuePage() {
  const { id } = useParams();
  const venue = useApi(`/venues/${id}`);
  const offers = useApi(`/offers?venueId=${id}`);
  return (
    <div className="page">
      <BackLink />
      <Async state={venue}>
        {(v) => (
          <>
            <PageHeader title={v.name} />
            <p className="row-icon muted">
              <Icon name="pin" size={16} />
              {v.city}, {v.address}
            </p>
            {v.phone && <p><a href={`tel:${v.phone.replace(/\s+/g, '')}`}>{v.phone}</a></p>}
          </>
        )}
      </Async>
      <h2 className="section-title">Предложения</h2>
      <Async state={offers}>
        {(list) => (list.length ? <OfferGrid offers={list} /> : <Empty title="Сейчас нет предложений" />)}
      </Async>
      <CartBar />
    </div>
  );
}

export function SearchPage() {
  const { me } = useSession();
  const [text, setText] = useState('');
  const query = useDebounced(text.trim());
  const results = useApi(query ? `/offers${qs({ q: query, city: me.city })}` : null);
  return (
    <div className="page">
      <BackLink />
      <label className="search-input">
        <Icon name="search" size={18} />
        <input
          type="search"
          autoFocus
          placeholder="Название набора или заведения"
          aria-label="Поиск"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {query ? (
        <Async state={results}>
          {(list) => (list.length ? <OfferGrid offers={list} /> : <Empty title="Ничего не найдено" />)}
        </Async>
      ) : (
        <p className="muted center">Введите название набора или заведения</p>
      )}
      <CartBar />
    </div>
  );
}

export function OfferPage() {
  const { id } = useParams();
  const offer = useApi(`/offers/${id}`);
  return (
    <div className="page page-flush">
      <Async state={offer}>{(o) => <OfferDetails offer={o} />}</Async>
    </div>
  );
}

function OfferDetails({ offer }) {
  const cart = useCart();
  const navigate = useNavigate();
  const inCart = cart.quantityOf(offer.id);
  const available = offer.state === 'available';

  async function book() {
    if (cart.conflictsWith(offer)) {
      const ok = await confirmDialog(`В корзине заказ из «${cart.cart.venueName}». Очистить её и добавить этот набор?`);
      if (!ok) return;
    }
    if (!inCart) cart.add(offer);
    navigate('/cart');
  }

  return (
    <>
      <div className="hero">
        <img src={offer.photo} alt="" />
        <div className="hero-back"><BackLink /></div>
        <FavoriteButton offerId={offer.id} />
      </div>
      <div className="details">
        <div className="between">
          <h1>{offer.name}</h1>
          {!available && <OfferStateBadge state={offer.state} />}
        </div>
        <div className="price-line">
          <Price offer={offer} />
          <span className="discount discount-inline">−{discountPercent(offer.priceOriginal, offer.priceDiscounted)}%</span>
        </div>

        <div className="card info-list">
          <div className="row-icon"><Icon name="clock" size={18} />Получение: {formatPickup(offer.pickupStart, offer.pickupEnd)}</div>
          <Link to={`/venues/${offer.venueId}`} className="row-icon">
            <Icon name="pin" size={18} />
            <span>{offer.venueName}<br /><span className="muted small">{offer.venueAddress}</span></span>
          </Link>
          {available && <div className="muted small">Доступно наборов: {offer.quantity}</div>}
        </div>

        <h2 className="section-title">Описание</h2>
        <p className="prewrap">{offer.description}</p>
        <h2 className="section-title">Состав и аллергены</h2>
        <p className="prewrap">{offer.ingredients}</p>
        <p className="small muted">Оплата при получении в заведении.</p>
      </div>
      <div className="sticky-action">
        {available ? (
          <button type="button" className="btn btn-primary btn-block" onClick={book}>
            {inCart ? `В корзине: ${inCart}. Перейти` : 'Забронировать'}
          </button>
        ) : (
          <button type="button" className="btn btn-block" disabled>
            {offer.state === 'sold_out' ? 'Наборы закончились' : 'Недоступно'}
          </button>
        )}
      </div>
    </>
  );
}

export function CartPage() {
  const cart = useCart();
  const money = useMoney();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);

  // Актуализирует остатки и цены: они могли измениться, пока корзина лежала.
  useEffect(() => {
    let current = true;
    for (const line of cart.cart.items) {
      api(`/offers/${line.offerId}`)
        .then((o) => {
          if (!current) return;
          const max = o.state === 'available' ? o.quantity : 0;
          if (line.max !== max || line.price !== o.priceDiscounted) {
            cart.syncLine(line.offerId, {
              max,
              price: o.priceDiscounted,
              priceOriginal: o.priceOriginal,
              quantity: max === 0 ? line.quantity : Math.min(line.quantity, max),
            });
          }
        })
        .catch(() => {
          // Сервер всё равно проверит наличие при оформлении.
        });
    }
    return () => {
      current = false;
    };
    // Только при открытии экрана: иначе каждая синхронизация запускала бы новую.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!cart.count) {
    return (
      <div className="page">
        <BackLink />
        <Empty title="Корзина пуста">
          <p>Выберите набор на главной.</p>
          <Link to="/" className="btn btn-primary">На главную</Link>
        </Empty>
      </div>
    );
  }

  const hasUnavailable = cart.cart.items.some((i) => i.max === 0);

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const order = await api('/orders', {
        method: 'POST',
        body: {
          idempotencyKey: cart.cart.key,
          items: cart.cart.items.map((i) => ({ offerId: i.offerId, quantity: i.quantity })),
        },
      });
      haptic('success');
      cart.clear();
      navigate(`/orders/${order.id}?new=1`, { replace: true });
    } catch (e) {
      haptic('error');
      if (e.details?.offerId != null && e.details.available != null) {
        cart.syncLine(e.details.offerId, { max: e.details.available });
      }
      setError(e);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="page page-with-action">
      <BackLink />
      <PageHeader title="Корзина" />
      <p className="muted">{cart.cart.venueName}</p>
      <div className="stack">
        {cart.cart.items.map((line) => (
          <div key={line.offerId} className={`card cart-line ${line.max === 0 ? 'offer-card-off' : ''}`}>
            <img src={line.photo} alt="" />
            <div className="grow">
              <h3>{line.name}</h3>
              <div className="small muted">{formatPickup(line.pickupStart, line.pickupEnd)}</div>
              {line.max === 0 ? (
                <div className="small text-danger">Больше недоступно, удалите из корзины</div>
              ) : line.quantity > line.max ? (
                <div className="small text-danger">Доступно только {line.max} шт.</div>
              ) : null}
              <div className="between cart-controls">
                <strong>{money(line.price * line.quantity)}</strong>
                <div className="stepper">
                  {line.quantity > 1 ? (
                    <button type="button" aria-label="Уменьшить количество" onClick={() => cart.setQuantity(line.offerId, line.quantity - 1)}>
                      <Icon name="minus" size={16} />
                    </button>
                  ) : (
                    <button type="button" aria-label="Удалить из корзины" onClick={() => cart.remove(line.offerId)}>
                      <Icon name="trash" size={16} />
                    </button>
                  )}
                  <span aria-live="polite">{line.quantity}</span>
                  <button
                    type="button"
                    aria-label="Увеличить количество"
                    disabled={line.quantity >= line.max}
                    onClick={() => cart.setQuantity(line.offerId, line.quantity + 1)}
                  >
                    <Icon name="plus" size={16} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <Link to={`/venues/${cart.cart.venueId}`} className="btn btn-ghost btn-block add-more">
        Добавить ещё из этого заведения
      </Link>
      <div className="card total-card">
        <div className="between"><span>Итого</span><strong className="total">{money(cart.total)}</strong></div>
        <div className="small muted">Оплата при получении в заведении</div>
      </div>
      <ErrorBox error={error} />
      <div className="sticky-action sticky-action-page">
        <button type="button" className="btn btn-primary btn-block" disabled={submitting || hasUnavailable} onClick={submit}>
          {submitting ? 'Бронируем…' : 'Забронировать'}
        </button>
      </div>
    </div>
  );
}

export function FavoritesPage() {
  const favorites = useApi('/favorites');
  const { ids, loaded } = useFavorites();
  return (
    <div className="page">
      <PageHeader title="Избранное" />
      <Async state={favorites}>
        {(list) => {
          // Снятое сердце убирает карточку сразу, без повторного запроса.
          const shown = loaded ? list.filter((o) => ids.has(o.id)) : list;
          return shown.length ? (
            <OfferGrid offers={shown} />
          ) : (
            <Empty title="Здесь пока пусто">Нажмите на сердце у набора, чтобы сохранить его и узнать, когда он снова появится.</Empty>
          );
        }}
      </Async>
      <CartBar />
    </div>
  );
}

export function OrdersPage() {
  const orders = useApi('/orders');
  const [tab, setTab] = useState('active');
  return (
    <div className="page">
      <PageHeader title="Мои заказы" />
      <div className="segmented">
        <button type="button" className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>Активные</button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>История</button>
      </div>
      <Async state={orders}>
        {(list) => {
          const shown = list.filter((o) => (tab === 'active' ? o.status === 'booked' : o.status !== 'booked'));
          if (!shown.length) return <Empty title={tab === 'active' ? 'Нет активных заказов' : 'История пуста'} />;
          return (
            <div className="stack">
              {shown.map((o) => <OrderCard key={o.id} order={o} />)}
            </div>
          );
        }}
      </Async>
    </div>
  );
}

function OrderCard({ order }) {
  return (
    <Link to={`/orders/${order.id}`} className="card order-card">
      <div className="between">
        <h3>{order.venueName}</h3>
        <StatusBadge status={order.status} />
      </div>
      <div className="small">{order.items.map((i) => `${i.name} × ${i.quantity}`).join(', ')}</div>
      <div className="small muted">{order.venueAddress}</div>
      <div className="between small">
        <span className="muted">{formatPickup(order.pickupStart, order.pickupEnd)}</span>
        {order.status === 'booked' && <code className="code-inline">{order.code}</code>}
      </div>
    </Link>
  );
}

export function OrderPage() {
  const { id } = useParams();
  const { search } = useLocation();
  const money = useMoney();
  const order = useApi(`/orders/${id}`);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState(null);

  async function cancel() {
    if (!(await confirmDialog('Отменить бронирование?'))) return;
    setCancelling(true);
    setError(null);
    try {
      await api(`/orders/${id}/cancel`, { method: 'POST' });
      await order.reload();
    } catch (e) {
      setError(e);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="page">
      <BackLink />
      <Async state={order}>
        {(o) => (
          <>
            {new URLSearchParams(search).has('new') && o.status === 'booked' && (
              <div className="notice notice-success" role="status">
                <strong>Бронирование подтверждено!</strong>
                <p>Покажите код в заведении. Мы также отправили его в чат с ботом.</p>
              </div>
            )}
            <div className="between">
              <PageHeader title={`Заказ №${o.id}`} />
              <StatusBadge status={o.status} />
            </div>
            {o.status === 'booked' && (
              <div className="card code-card">
                <div className="muted small">Код получения</div>
                <div className="code" aria-label={`Код получения ${o.code.split('').join(' ')}`}>{o.code}</div>
              </div>
            )}
            <div className="card info-list">
              <div className="row-icon"><Icon name="clock" size={18} />{formatPickup(o.pickupStart, o.pickupEnd)}</div>
              <Link to={`/venues/${o.venueId}`} className="row-icon">
                <Icon name="pin" size={18} />
                <span>{o.venueName}<br /><span className="muted small">{o.venueAddress}</span></span>
              </Link>
            </div>
            <div className="card">
              {o.items.map((i) => (
                <div key={i.id} className="between item-line">
                  <Link to={`/offers/${i.offerId}`}>{i.name} × {i.quantity}</Link>
                  <span>{money(i.price * i.quantity)}</span>
                </div>
              ))}
              <div className="between total-line">
                <strong>Итого</strong>
                <strong>{money(o.total)}</strong>
              </div>
              {o.status === 'booked' && <div className="small muted">Оплата при получении</div>}
            </div>
            <ErrorBox error={error} />
            {o.status === 'booked' && (
              <button type="button" className="btn btn-danger-ghost btn-block" onClick={cancel} disabled={cancelling}>
                {cancelling ? 'Отменяем…' : 'Отменить бронирование'}
              </button>
            )}
          </>
        )}
      </Async>
    </div>
  );
}

const DEV_USERS = [
  { id: '1001', label: 'Покупатель' },
  { id: '2001', label: 'Партнёр' },
  { id: '9001', label: 'Админ' },
];

export function ProfilePage() {
  const { me, reload } = useSession();
  const [error, setError] = useState(null);

  async function changeCity(city) {
    setError(null);
    try {
      await api('/me', { method: 'PATCH', body: { city } });
      await reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <div className="page">
      <PageHeader title="Профиль" />
      <div className="card profile-card">
        <div className="avatar" aria-hidden="true">{userName(me).charAt(0).toUpperCase()}</div>
        <div>
          <h3>{userName(me)}</h3>
          {me.username && <div className="muted small">@{me.username}</div>}
        </div>
      </div>

      <label className="field">
        <span>Город</span>
        <select value={me.city} onChange={(e) => changeCity(e.target.value)}>
          {[...new Set([me.city, ...me.cities])].map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <ErrorBox error={error} />

      {(me.venues.length > 0 || me.isAdmin) && <h2 className="section-title">Управление</h2>}
      <div className="stack">
        {me.isAdmin && <Link to="/admin" className="card link-card">Главный админ <span>›</span></Link>}
        {me.venues.length > 0 && <Link to="/partner" className="card link-card">Кабинет кафе <span>›</span></Link>}
      </div>

      {me.devAuth && (
        <>
          <h2 className="section-title">Режим разработки</h2>
          <p className="small muted">Вход под тестовым пользователем. В production этого блока нет.</p>
          <div className="chips chips-wrap">
            {DEV_USERS.map((u) => (
              <button
                type="button"
                key={u.id}
                className={`chip ${getDevUser() === u.id ? 'chip-active' : ''}`}
                onClick={() => {
                  setDevUser(u.id);
                  window.location.reload();
                }}
              >
                {u.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
