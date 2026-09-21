/**
 * src/store/useBranchStore.js
 * P1.3: Branch context store using React useReducer + Context.
 *
 * State shape:
 *   - branches: Array of { shop_id, shop_name, city, is_online, total_sales, ... }
 *   - activeContext: 'all' | shop_id (UUID string)
 *   - statsCache: Map<shop_id, statsObject>
 *
 * Features:
 *   - Instant branch switching (0ms perceived latency from cache)
 *   - Persists activeContext to localStorage('st_active_branch_id')
 *   - Background SWR refresh after switching
 */
import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import { supabase } from '../supabase';

const STORAGE_KEY = 'st_active_branch_id';

const initialState = {
  branches:      [],
  activeContext: localStorage.getItem(STORAGE_KEY) || 'all',
  statsCache:    {},
  loading:       true,
  error:         null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_BRANCHES':
      return { ...state, branches: action.payload, loading: false };
    case 'SET_ACTIVE': {
      const id = action.payload;
      localStorage.setItem(STORAGE_KEY, id);
      return { ...state, activeContext: id };
    }
    case 'CACHE_STATS':
      return {
        ...state,
        statsCache: { ...state.statsCache, [action.shopId]: action.payload }
      };
    case 'SET_ERROR':
      return { ...state, error: action.payload, loading: false };
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    default:
      return state;
  }
}

const BranchContext = createContext(null);

export function BranchProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const fetchBranches = useCallback(async () => {
    try {
      // Try new shop_memberships first (P0.1 flow)
      const { data: memberships, error } = await supabase
        .from('shop_memberships')
        .select('shop_id, shops(id, shop_name, city, last_seen_at, is_active)');

      if (!error && memberships && memberships.length > 0) {
        const branches = memberships
          .filter(m => m.shops)
          .map(m => ({
            shop_id:   m.shops.id,
            shop_name: m.shops.shop_name,
            city:      m.shops.city,
            is_online: m.shops.last_seen_at
              ? (new Date() - new Date(m.shops.last_seen_at)) < 15 * 60 * 1000
              : false,
          }));
        dispatch({ type: 'SET_BRANCHES', payload: branches });
        return;
      }

      // Fallback: legacy owner_licenses
      const { data: licenses, error: licErr } = await supabase
        .from('owner_licenses')
        .select('shop_id, shop_name')
        .is('revoked_at', null);

      if (!licErr && licenses) {
        const branches = licenses.map(l => ({
          shop_id:   l.shop_id,
          shop_name: l.shop_name,
          city:      '',
          is_online: false,
        }));
        dispatch({ type: 'SET_BRANCHES', payload: branches });
      } else {
        dispatch({ type: 'SET_ERROR', payload: licErr?.message || 'فشل تحميل الفروع' });
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', payload: err.message });
    }
  }, []);

  useEffect(() => {
    fetchBranches();
  }, [fetchBranches]);

  const switchBranch = useCallback((shopId) => {
    dispatch({ type: 'SET_ACTIVE', payload: shopId });
  }, []);

  const cacheStats = useCallback((shopId, stats) => {
    dispatch({ type: 'CACHE_STATS', shopId, payload: stats });
  }, []);

  const value = {
    ...state,
    switchBranch,
    cacheStats,
    refreshBranches: fetchBranches,
    activeBranch: state.branches.find(b => b.shop_id === state.activeContext) || null,
    isAllBranches: state.activeContext === 'all',
  };

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export function useBranchStore() {
  const ctx = useContext(BranchContext);
  if (!ctx) throw new Error('useBranchStore must be used within BranchProvider');
  return ctx;
}
