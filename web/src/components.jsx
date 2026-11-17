import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { OFFER_STATE_LABELS, STATUS_LABELS, discountPercent, formatPickup } from './format.js';
import { useCart, useFavorites, useMoney } from './state.jsx';
import { tg } from './telegram.js';

export function Icon({ name, size = 22 }) {
  const paths = {
    home: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    heart: 'M12 20.5s-8-4.8-8-11A4.5 4.5 0 0 1 12 6.6 4.5 4.5 0 0 1 20 9.5c0 6.2-8 11-8 11z',
    orders: 'M6 3h12a1 1 0 0 1 1 1v17l-3-2-2 2-2-2-2 2-2-2-3 2V4a1 1 0 0 1 1-1zm3 5h6m-6 4h6',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3-4-4',
    cart: 'M3 4h2l2.4 11.5a1 1 0 0 0 1 .8h8.8a1 1 0 0 0 1-.8L20 8H6m3 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    pin: 'M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21zm0-9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4.5l3 2',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    trash: 'M4 7h16M9 7V4h6v3m3 0-1 13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1L6 7',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Загрузка" />;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="notice notice-error" role="alert">
      <p>{error.message}</p>
      {onRetry && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => onRetry()}>
          Повторить
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

/** Показывает загрузку и ошибки единообразно; children получает готовые данные. */
export function Async({ state, children }) {
  if (state.loading && !state.data) return <Spinner />;
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  return state.data ? children(state.data) : null;
}

export function StatusBadge({ status }) {
  return <span className={`badge status-${status}`}>{STATUS_LABELS[status]}</span>;
}

export function OfferStateBadge({ state }) {
  return <span className={`badge offer-${state}`}>{OFFER_STATE_LABELS[state]}</span>;
}

export function Price({ offer }) {
  const money = useMoney();
  return (
    <span className="price">
      <strong>{money(offer.priceDiscounted)}</strong>
      <s>{money(offer.priceOriginal)}</s>
    </span>
  );
}

export function FavoriteButton({ offerId, floating = true }) {
  const { ids, toggle } = useFavorites();
  const active = ids.has(offerId);
  return (
    <button
      type="button"
      className={`fav ${active ? 'fav-active' : ''} ${floating ? 'fav-floating' : ''}`}
      aria-pressed={active}
      aria-label={active ? 'Убрать из избранного' : 'Добавить в избранное'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(offerId);
      }}
    >
      <Icon name="heart" size={20} />
    </button>
  );
}

export function OfferCard({ offer }) {
  const isAvailable = offer.state === 'available';
  return (
    <Link to={`/offers/${offer.id}`} className={`card offer-card ${isAvailable ? '' : 'offer-card-off'}`}>
      <div className="offer-photo">
        <img src={offer.photo} alt="" loading="lazy" />
        {isAvailable ? (
          <span className="discount">−{discountPercent(offer.priceOriginal, offer.priceDiscounted)}%</span>
        ) : (
          <span className="discount discount-off">{OFFER_STATE_LABELS[offer.state]}</span>
        )}
        <FavoriteButton offerId={offer.id} />
      </div>
      <div className="offer-body">
        <div className="muted small ellipsis">{offer.venueName}</div>
        <h3 className="offer-title">{offer.name}</h3>
        <div className="small muted row-icon">
          <Icon name="clock" size={14} />
          {formatPickup(offer.pickupStart, offer.pickupEnd)}
        </div>
        <Price offer={offer} />
      </div>
    </Link>
  );
}

export function CartBar() {
  const { count, total } = useCart();
  const money = useMoney();
  if (!count) return null;
  return (
    <Link to="/cart" className="cart-bar">
      <span className="row-icon">
        <Icon name="cart" size={20} />
        Корзина · {count}
      </span>
      <strong>{money(total)}</strong>
    </Link>
  );
}

export function TabBar() {
  const tabs = [
    { to: '/', label: 'Главная', icon: 'home' },
    { to: '/favorites', label: 'Избранное', icon: 'heart' },
    { to: '/orders', label: 'Заказы', icon: 'orders' },
    { to: '/profile', label: 'Профиль', icon: 'user' },
  ];
  return (
    <nav className="tabbar" aria-label="Основное меню">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.to === '/'} className={({ isActive }) => `tab ${isActive ? 'tab-active' : ''}`}>
          <Icon name={t.icon} />
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function PageHeader({ title, action }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {action}
    </header>
  );
}

export function SubNav({ items }) {
  return (
    <nav className="subnav">
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => `chip ${isActive ? 'chip-active' : ''}`}>
          {i.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Кнопка «Назад» Telegram на внутренних экранах; в обычном браузере её заменяет ссылка в шапке. */
export function useTelegramBackButton() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const back = tg?.BackButton;
    if (!back) return undefined;
    const isRoot = ['/', '/favorites', '/orders', '/profile'].includes(location.pathname);
    const onClick = () => (location.key === 'default' ? navigate('/') : navigate(-1));
    if (isRoot) back.hide();
    else {
      back.show();
      back.onClick(onClick);
    }
    return () => back.offClick(onClick);
  }, [location, navigate]);
}

export function BackLink() {
  const navigate = useNavigate();
  const location = useLocation();
  if (tg?.initData) return null;
  return (
    <button type="button" className="back-link" onClick={() => (location.key === 'default' ? navigate('/') : navigate(-1))}>
      ← Назад
    </button>
  );
}

export function useDebounced(value, ms = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
