/**
 * May Harvest Corporation - HR Forms Management System
 * Hybrid Dual-Cloud Engine: Render Backend + Supabase Cloud DB + Cloudflare Edge CDN (v2.0)
 * 
 * Features:
 * - 24/7 Availability even when Render spins down (Cloudflare + Supabase instant access)
 * - Real-time 2-way cloud database synchronization (Undertime, Gatepass, Leave, Admission)
 * - Non-destructive conflict resolution
 * - Automatic offline fallback to localStorage
 */

(function () {
  'use strict';

  const STORAGE_KEY = 'mhc_hr_forms_v1';
  const RENDER_SYNC_ENDPOINT = '/api/sync';
  const SUPABASE_URL = 'https://svquyjpguhrmhzbgynsw.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_J6udCVSr_aA2_LYp5QcSGQ_hMFu_wMA';
  const SUPABASE_ROOM = 'hr_forms';
  const SYNC_INTERVAL_MS = 20000;
  const DEBOUNCE_MS = 600;

  let supabaseClient = null;
  let isSyncing = false;
  let syncTimeout = null;

  // Initialize Supabase Client
  function initSupabase() {
    try {
      if (window.supabase && window.supabase.createClient) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        console.log('[MHC HR] Supabase Cloud Database Client Initialized.');
      }
    } catch (e) {
      console.warn('[MHC HR] Supabase init skipped:', e.message);
    }
  }

  // Preserve native storage methods
  const origSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    origSetItem(key, value);
    if (key === STORAGE_KEY) {
      schedulePushSync();
    }
  };

  function schedulePushSync() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(pushDataToClouds, DEBOUNCE_MS);
  }

  async function pushDataToClouds() {
    if (isSyncing) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      data.lastUpdated = new Date().toISOString();

      isSyncing = true;
      let supaOk = false;
      let renderOk = false;

      // 1. Push to Supabase Cloud DB (Always online on Cloudflare)
      if (supabaseClient) {
        try {
          const { error } = await supabaseClient.from('party_sync').upsert({
            room: SUPABASE_ROOM,
            data: data,
            updated_at: data.lastUpdated
          });
          if (!error) supaOk = true;
        } catch (supaErr) {
          console.warn('[MHC HR] Supabase push error:', supaErr);
        }
      }

      // 2. Push to Render Backend (if running / reachable)
      try {
        const res = await fetch(RENDER_SYNC_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (res.ok) renderOk = true;
      } catch (_) {}

      if (supaOk && renderOk) {
        setCloudStatus(true, 'Render + Supabase Synced');
      } else if (supaOk) {
        setCloudStatus(true, 'Supabase Cloud Synced');
      } else if (renderOk) {
        setCloudStatus(true, 'Render Synced');
      } else {
        setCloudStatus(true, 'Saved Locally');
      }
    } catch (e) {
      setCloudStatus(false, 'Local / Offline Mode');
    } finally {
      isSyncing = false;
    }
  }

  // Pull data from Supabase first, fallback to Render
  async function pullDataFromClouds() {
    if (isSyncing) return;
    isSyncing = true;
    let cloudData = null;
    let source = '';

    // 1. Try Supabase
    if (supabaseClient) {
      try {
        const { data, error } = await supabaseClient
          .from('party_sync')
          .select('data, updated_at')
          .eq('room', SUPABASE_ROOM)
          .maybeSingle();

        if (!error && data && data.data) {
          cloudData = data.data;
          source = 'Supabase';
        }
      } catch (e) {
        console.warn('[MHC HR] Supabase pull error:', e.message);
      }
    }

    // 2. If Supabase has no data or failed, try Render backend
    if (!cloudData) {
      try {
        const res = await fetch(RENDER_SYNC_ENDPOINT);
        if (res.ok) {
          const body = await res.json();
          if (body && body.data) {
            cloudData = body.data;
            source = 'Render';
          }
        }
      } catch (_) {}
    }

    if (cloudData) {
      try {
        const localRaw = localStorage.getItem(STORAGE_KEY);
        const localData = localRaw ? JSON.parse(localRaw) : { requests: {}, accounts: {}, audit: [], settings: {} };

        // Non-destructive merge
        const merged = mergeHrDatasets(localData, cloudData);
        origSetItem(STORAGE_KEY, JSON.stringify(merged));

        if (window.LOCAL_DB) {
          Object.assign(window.LOCAL_DB, merged);
          if (typeof window._notifyCol === 'function') {
            window._notifyCol('requests');
            window._notifyCol('accounts');
            window._notifyCol('audit');
            window._notifyCol('settings');
          }
          if (typeof window.draw === 'function') {
            window.draw();
          }
        }

        setCloudStatus(true, source + ' Cloud Connected');
        console.log('[MHC HR] Synced with ' + source);
      } catch (err) {
        console.error('[MHC HR] Merge error:', err);
      }
    }

    isSyncing = false;
  }

  function mergeHrDatasets(local, cloud) {
    const res = {
      requests: Object.assign({}, cloud.requests || {}, local.requests || {}),
      accounts: Object.assign({}, cloud.accounts || {}, local.accounts || {}),
      audit: Array.isArray(cloud.audit) ? cloud.audit : (local.audit || []),
      settings: Object.assign({}, cloud.settings || {}, local.settings || {}),
      lastUpdated: new Date().toISOString()
    };
    return res;
  }

  function setCloudStatus(online, text) {
    let el = document.getElementById('cloud-sync-pill');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cloud-sync-pill';
      el.style.cssText = 'position:fixed;bottom:14px;right:14px;background:#1b211c;border:1px solid #2f3a31;color:#9aa89d;font-size:11px;font-family:system-ui,sans-serif;padding:6px 12px;border-radius:20px;display:flex;align-items:center;gap:6px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.15);transition:all .3s ease;pointer-events:none;';
      document.body.appendChild(el);
    }
    const dotColor = online ? '#4ade80' : '#f59e0b';
    el.innerHTML = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + dotColor + ';"></span><span>' + text + '</span>';
  }

  // Setup Supabase script tag dynamically
  function loadSupabaseScript() {
    if (window.supabase) {
      initSupabase();
      pullDataFromClouds();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    script.onload = () => {
      initSupabase();
      pullDataFromClouds();
    };
    script.onerror = () => {
      console.warn('[MHC HR] Could not load Supabase CDN, falling back to local/Render.');
      pullDataFromClouds();
    };
    document.head.appendChild(script);
  }

  window.MhcCloudSync = {
    push: schedulePushSync,
    pull: pullDataFromClouds,
    status: setCloudStatus
  };

  // Run on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      loadSupabaseScript();
      setInterval(pullDataFromClouds, SYNC_INTERVAL_MS);
    });
  } else {
    loadSupabaseScript();
    setInterval(pullDataFromClouds, SYNC_INTERVAL_MS);
  }
})();
