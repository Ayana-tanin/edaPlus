import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBox, Spinner, TabBar, useTelegramBackButton } from './components.jsx';
import { AdminLayout, AdminOffers, AdminOrders, AdminUsers, AdminVenues } from './pages/admin.jsx';
import {
  CartPage, FavoritesPage, Home, OfferPage, OrderPage, OrdersPage, ProfilePage, SearchPage, VenuePage,
} from './pages/buyer.jsx';
import { PartnerLayout, PartnerOfferForm, PartnerOffers, PartnerOrders, PartnerPickup } from './pages/partner.jsx';
import { CartProvider, FavoritesProvider, SessionProvider } from './state.jsx';
import './styles.css';
import { initTelegram } from './telegram.js';

initTelegram();

function BuyerShell() {
  return (
    <>
      <Outlet />
      <TabBar />
    </>
  );
}

function Shell() {
  useTelegramBackButton();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return <Outlet />;
}

function NotFound() {
  return (
    <div className="page center">
      <h1>Страница не найдена</h1>
      <Link to="/" className="btn btn-primary">На главную</Link>
    </div>
  );
}

function SessionFallback({ error, loading, reload }) {
  if (loading) return <div className="page center"><Spinner /></div>;
  return <div className="page"><ErrorBox error={error} onRetry={error?.status === 401 ? undefined : reload} /></div>;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SessionProvider fallback={(props) => <SessionFallback {...props} />}>
      <FavoritesProvider>
        <CartProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<Shell />}>
                <Route element={<BuyerShell />}>
                  <Route index element={<Home />} />
                  <Route path="favorites" element={<FavoritesPage />} />
                  <Route path="orders" element={<OrdersPage />} />
                  <Route path="profile" element={<ProfilePage />} />
                  <Route path="search" element={<SearchPage />} />
                  <Route path="venues/:id" element={<VenuePage />} />
                </Route>
                <Route path="offers/:id" element={<OfferPage />} />
                <Route path="cart" element={<CartPage />} />
                <Route path="orders/:id" element={<OrderPage />} />
                <Route path="partner" element={<PartnerLayout />}>
                  <Route index element={<PartnerOffers />} />
                  <Route path="offers/new" element={<PartnerOfferForm />} />
                  <Route path="offers/:id" element={<PartnerOfferForm />} />
                  <Route path="orders" element={<PartnerOrders />} />
                  <Route path="pickup" element={<PartnerPickup />} />
                </Route>
                <Route path="admin" element={<AdminLayout />}>
                  <Route index element={<AdminVenues />} />
                  <Route path="users" element={<AdminUsers />} />
                  <Route path="offers" element={<AdminOffers />} />
                  <Route path="orders" element={<AdminOrders />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </CartProvider>
      </FavoritesProvider>
    </SessionProvider>
  </StrictMode>,
);
