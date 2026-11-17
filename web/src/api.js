import { useCallback, useEffect, useState } from 'react';
import { tg } from './telegram.js';

const DEV_USER_KEY = 'eda.devUser';

export function getDevUser() {
  try {
    return localStorage.getItem(DEV_USER_KEY) || '1001';
  } catch {
    return '1001';
  }
}

export function setDevUser(id) {
  try {
    localStorage.setItem(DEV_USER_KEY, String(id));
  } catch {
    // Без хранилища останется пользователь по умолчанию.
  }
}

function authHeaders() {
  if (tg?.initData) return { Authorization: `tma ${tg.initData}` };
  return { 'X-Dev-User': getDevUser() };
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'network', 'Нет соединения. Проверьте интернет и попробуйте ещё раз.');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Ответ не JSON (например, ошибка прокси): ниже он станет общей ошибкой сервера.
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'server_error', e?.message ?? 'Ошибка сервера. Попробуйте ещё раз.', e?.details);
  }
  return data;
}

/** Загружает данные по пути; при path = null ничего не запрашивает. */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });

  const load = useCallback(
    async (isCurrent = () => true) => {
      if (!path) return;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await api(path);
        if (isCurrent()) setState({ data, error: null, loading: false });
      } catch (error) {
        // Прежние данные сохраняются: сбой фонового обновления не должен обрывать работу.
        if (isCurrent()) setState((s) => ({ data: s.data, error, loading: false }));
      }
    },
    [path],
  );

  useEffect(() => {
    let current = true;
    load(() => current);
    return () => {
      current = false;
    };
  }, [load]);

  return { ...state, reload: load };
}
