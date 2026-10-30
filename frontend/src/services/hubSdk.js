// DWS Hub SDK (analytics, JS errors, bug reports, Sentinel). The script tag is
// injected at build time by vite.config.js only when VITE_HUB_SDK_KEY is set, so
// every call here is a no-op in builds without the SDK (dev, desktop).

function sdkOnPage() {
  return typeof document !== 'undefined' && Boolean(document.querySelector('script[data-app-key]'));
}

function callSdk(method, ...args) {
  if (typeof window === 'undefined') return;
  const sdk = window.DwsHub;
  try {
    if (sdk && typeof sdk[method] === 'function' && !Array.isArray(sdk)) {
      sdk[method](...args);
      return;
    }
    // The SDK script is deferred; queue the call until it has loaded.
    if (!sdkOnPage()) return;
    window.DwsHub = sdk || [];
    window.DwsHub.push([method, ...args]);
  } catch {
    // Analytics must never break the ERP.
  }
}

// `id` must be the DWS Hub user id (OIDC `sub`); users without a Hub link are
// reported by email only and show as "Not a Hub account" in the Hub.
export function identifyHubUser(user) {
  if (!user) return;
  const identity = {};
  if (user.hub_sub) identity.id = user.hub_sub;
  if (user.email) identity.email = user.email;
  if (identity.id || identity.email) callSdk('identify', identity);
}

export function resetHubUser() {
  callSdk('reset');
}

// Business actions shown under "Tracked actions" in the Hub. Names: letters,
// numbers and _ . : / - (max 80); properties: small JSON object, no personal data.
export function trackHubAction(name, properties) {
  callSdk('track', name, properties);
}
