import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, useApi } from './api.js';
import { haptic } from './telegram.js';

const SessionContext = createContext(null);
const FavoritesContext = createContext(null);
const CartContext = createContext(null);

export const useSession = () => useContext(SessionContext);
export const useFavorites = () => useContext(FavoritesContext);
export const useCart = () => useContext(CartContext);

export function useMoney() {
  const { me } = useSession();
  return useCallback((n) => `${n.toLocaleString('ru-RU')} ${me.currency}`, [me.currency]);
}

export function SessionProvider({ children, fallback }) {
  const { data: me, error, loading, reload } = useApi('/me');
  // Роли могут выдать, пока приложение открыто: обновляем их при каждом возвращении в него.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [reload]);

  const value = useMemo(() => ({ me, reload }), [me, reload]);
  if (!me) return fallback({ error, loading, reload });
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** Один список на всё приложение: каталог, карточка и избранное всегда согласованы. */
export function FavoritesProvider({ children }) {
  const { me } = useSession();
  const [ids, setIds] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/favorites')
      .then((offers) => {
        setIds(new Set(offers.map((o) => o.id)));
        setLoaded(true);
      })
      .catch(setError);
  }, [me.id]);

  const toggle = useCallback(
    async (offerId) => {
      const wasFavorite = ids.has(offerId);
      const apply = (add) =>
        setIds((prev) => {
          const next = new Set(prev);
          if (add) next.add(offerId);
          else next.delete(offerId);
          return next;
        });
      apply(!wasFavorite);
      haptic();
      setError(null);
      try {
        await api(`/favorites/${offerId}`, { method: wasFavorite ? 'DELETE' : 'PUT' });
      } catch (e) {
        apply(wasFavorite);
        setError(e);
      }
    },
    [ids],
  );

  const value = useMemo(() => ({ ids, loaded, toggle, error }), [ids, loaded, toggle, error]);
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

const emptyCart = () => ({ venueId: null, venueName: '', items: [], key: crypto.randomUUID() });

function loadCart(storageKey) {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && Array.isArray(saved.items) && saved.key) return saved;
  } catch {
    // Повреждённая или недоступная корзина: начинаем с пустой.
  }
  return emptyCart();
}

export function CartProvider({ children }) {
  const { me } = useSession();
  const storageKey = `eda.cart.${me.id}`;
  const [cart, setCart] = useState(() => loadCart(storageKey));

  useEffect(() => {
    setCart(loadCart(storageKey));
  }, [storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(cart));
    } catch {
      // Корзина останется только в памяти.
    }
  }, [cart, storageKey]);

  // Изменение состава даёт новый ключ; повтор неизменной корзины не создаст второй заказ.
  const value = useMemo(() => {
    const change = (items) => setCart((c) => (items.length ? { ...c, items, key: crypto.randomUUID() } : emptyCart()));
    return {
      cart,
      count: cart.items.reduce((sum, i) => sum + i.quantity, 0),
      total: cart.items.reduce((sum, i) => sum + i.quantity * i.price, 0),
      quantityOf: (offerId) => cart.items.find((i) => i.offerId === offerId)?.quantity ?? 0,
      conflictsWith: (offer) => cart.venueId != null && cart.venueId !== offer.venueId,
      add(offer, quantity = 1) {
        const existing = cart.items.find((i) => i.offerId === offer.id);
        const nextQty = Math.min((existing?.quantity ?? 0) + quantity, offer.quantity);
        const line = {
          offerId: offer.id,
          name: offer.name,
          photo: offer.photo,
          price: offer.priceDiscounted,
          priceOriginal: offer.priceOriginal,
          quantity: nextQty,
          max: offer.quantity,
          pickupStart: offer.pickupStart,
          pickupEnd: offer.pickupEnd,
        };
        const base = cart.venueId === offer.venueId ? cart.items : [];
        const items = existing && base.length ? base.map((i) => (i.offerId === offer.id ? line : i)) : [...base, line];
        setCart({ venueId: offer.venueId, venueName: offer.venueName, items, key: crypto.randomUUID() });
        haptic();
      },
      setQuantity(offerId, quantity) {
        change(cart.items.map((i) => (i.offerId === offerId ? { ...i, quantity } : i)).filter((i) => i.quantity > 0));
      },
      // Обновление с сервера: ключ меняется, только если изменился сам заказ. Иначе повтор
      // после потерянного ответа (остаток уже уменьшен этим же заказом) создал бы дубль.
      syncLine(offerId, patch) {
        setCart((c) => {
          const before = c.items.find((i) => i.offerId === offerId);
          if (!before) return c;
          const items = c.items.map((i) => (i.offerId === offerId ? { ...i, ...patch } : i));
          const quantityChanged = patch.quantity != null && patch.quantity !== before.quantity;
          return { ...c, items, key: quantityChanged ? crypto.randomUUID() : c.key };
        });
      },
      remove(offerId) {
        change(cart.items.filter((i) => i.offerId !== offerId));
      },
      clear() {
        setCart(emptyCart());
      },
    };
  }, [cart]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
