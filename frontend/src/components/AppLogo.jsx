import React, { useId } from 'react';

// AASTAR Logistic (Export) app icon: an outbound tanker with the export arrow
// (docs/design/app-icon/concept-b-tanker*.svg). Below 48 px the simplified
// drawing is used, as in the browser tab: the full one loses its detail.
export const APP_NAME = 'AASTAR Logistic (Export)';

export default function AppLogo({ size = 40, title = APP_NAME }) {
  const gradientId = `app-logo-bg-${useId().replace(/:/g, '')}`;
  const compact = size < 48;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label={title}
      style={{ display: 'block', flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4b8398" />
          <stop offset="1" stopColor="#22465a" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx={compact ? 104 : 112} fill={`url(#${gradientId})`} />
      {compact ? (
        <>
          <path d="M 262 206 L 400 96" fill="none" stroke="#f08b6c" strokeWidth="56" strokeLinecap="round" />
          <polyline points="314,88 410,88 410,184" fill="none" stroke="#f08b6c" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="88" y="214" width="122" height="104" rx="14" fill="#ffffff" />
          <path d="M 52 306 L 466 306 L 404 412 L 100 412 Z" fill="#ffffff" stroke="#ffffff" strokeWidth="20" strokeLinejoin="round" />
        </>
      ) : (
        <>
          <path d="M 268 196 L 396 104" fill="none" stroke="#f08b6c" strokeWidth="34" strokeLinecap="round" />
          <polyline points="326,96 404,98 400,176" fill="none" stroke="#f08b6c" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="112" y="226" width="86" height="74" rx="10" fill="#ffffff" />
          <rect x="134" y="192" width="30" height="44" rx="6" fill="#e2664b" />
          <path d="M 84 296 L 440 296 L 392 372 L 116 372 Z" fill="#ffffff" stroke="#ffffff" strokeWidth="12" strokeLinejoin="round" />
          <circle cx="258" cy="286" r="14" fill="#ffffff" />
          <circle cx="314" cy="286" r="14" fill="#ffffff" />
          <circle cx="370" cy="286" r="14" fill="#ffffff" />
          <path d="M 92 420 C 132 404, 172 436, 212 420 S 292 404, 332 420 S 400 436, 424 424" fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="18" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
