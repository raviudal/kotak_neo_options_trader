const API_BASE = window.location.origin;

export function getAuthHeaders() {
  const token = localStorage.getItem("token");
  return {
    "Content-Type": "application/json",
    ...(token ? { "Authorization": `Bearer ${token}` } : {})
  };
}

export async function apiRequest(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = { ...getAuthHeaders(), ...(options.headers || {}) };
  
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    const data = await response.json().catch(() => ({}));
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.dispatchEvent(new CustomEvent("session_terminated", { detail: data.detail || "Session terminated" }));
    throw new Error(data.detail || "Session expired. Please log in with Google Authenticator.");
  }
  
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    if (!response.ok) {
      throw new Error(text || `Server error (HTTP ${response.status})`);
    }
    throw new Error(`Invalid response from server: ${text.slice(0, 100)}`);
  }

  if (!response.ok) {
    throw new Error(data.detail || data.message || `Request failed (HTTP ${response.status})`);
  }
  return data;
}

export const api = {
  // Auth
  login: (username, password, totp_code) => apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password, totp_code })
  }),
  get2FASetup: () => apiRequest("/api/auth/setup-2fa"),
  getMe: () => apiRequest("/api/auth/me"),
  
  // Kotak Neo
  getSavedKotakConfig: () => apiRequest("/api/kotak/saved-config"),
  getKotakStatus: () => apiRequest("/api/kotak/status"),
  restoreKotakSession: () => apiRequest("/api/kotak/restore-session", { method: "POST" }),
  loginKotak: (payload) => apiRequest("/api/kotak/login", {
    method: "POST",
    body: JSON.stringify(payload)
  }),
  disconnectKotak: () => apiRequest("/api/kotak/disconnect", { method: "POST" }),
  getKotakLimits: () => apiRequest("/api/kotak/limits"),
  
  // Strategies & SL
  getStrategies: () => apiRequest("/api/strategies"),
  getStrategyBook: () => apiRequest("/api/strategies/book"),
  previewStrategy: (payload) => apiRequest("/api/strategies/preview", {
    method: "POST",
    body: JSON.stringify(payload)
  }),
  createStrategy: (payload) => apiRequest("/api/strategies", {
    method: "POST",
    body: JSON.stringify(payload)
  }),
  closeStrategy: (id) => apiRequest(`/api/strategies/${id}/close`, { method: "POST" }),
  syncStrategy: (id) => apiRequest(`/api/strategies/${id}/sync`, { method: "POST" }),
  updateStrategySL: (id, payload) => apiRequest(`/api/strategies/${id}/sl`, {
    method: "PUT",
    body: JSON.stringify(payload)
  }),
  
  // Orders
  placeSingleOrder: (payload) => apiRequest("/api/orders/place", {
    method: "POST",
    body: JSON.stringify(payload)
  }),
  testItcOrder: () => apiRequest("/api/orders/test-itc", { method: "POST" }),
  getOrderLogs: (limit = 100) => apiRequest(`/api/orders/logs?limit=${limit}`),

  // Market & Master
  getExpiries: () => apiRequest("/api/market/expiries"),
  getStrikes: (expiry) => apiRequest(`/api/market/strikes${expiry ? `?expiry=${expiry}` : ''}`),
  getOptionChain: (expiry) => apiRequest(`/api/market/chain${expiry ? `?expiry=${expiry}` : ''}`),

  // System & Server Health
  getServerHealth: () => apiRequest("/api/system/health"),
  restartService: () => apiRequest("/api/system/restart-service", { method: "POST" }),
  rebootServer: () => apiRequest("/api/system/reboot", { method: "POST" })
};
