/**
 * Doppler's mark, taken from the favicon doppler.com serves (cdn.sanity.io,
 * read 2026-10): the base layer and its main gradient overlay, with gradient ids
 * namespaced so they cannot collide with another logo on the same page.
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="iw-doppler-a" x1="7.23327" y1="62.3326" x2="48.1235" y2="30.169" gradientUnits="userSpaceOnUse"> <stop stop-color="#FF9EFA"/> <stop offset="0.422647" stop-color="#F55C15" stop-opacity="0.84"/> <stop offset="1" stop-color="#6B13F5"/> </linearGradient>
    <linearGradient id="iw-doppler-b" x1="84.0271" y1="87.0164" x2="39.3969" y2="54.6034" gradientUnits="userSpaceOnUse"> <stop offset="0.385417" stop-color="#6B13F5"/> <stop offset="1" stop-color="#E2606E" stop-opacity="0"/> </linearGradient>
  </defs>
  <rect width="100" height="100" rx="12" fill="#FFFFFF"/>
  <g transform="translate(17,17) scale(0.7)">
    <path d="M64.3092 0.259394C60.1163 -0.864113 55.8423 1.77302 54.9657 6.02449L50.9884 25.3158C48.3904 37.9168 38.5465 47.7653 25.9467 50.3692L7.02287 54.2801C2.77187 55.1586 0.13598 59.4329 1.25947 63.6258C2.38309 67.8192 6.8038 70.2029 10.9248 68.8373L29.3407 62.7351C41.5851 58.6779 55.0695 62.291 63.6448 71.9269L76.5434 86.4207C79.4289 89.6631 84.4482 89.8092 87.5174 86.74C90.5871 83.6703 90.4404 78.6501 87.1969 75.7648L72.609 62.7885C62.9468 54.1936 59.3239 40.6746 63.3932 28.3998L69.5188 9.92278C70.8847 5.80285 68.5018 1.38278 64.3092 0.259394Z" fill="url(#iw-doppler-a)"/>
    <path d="M64.3092 0.259394C60.1163 -0.864113 55.8423 1.77302 54.9657 6.02449L50.9884 25.3158C48.3904 37.9168 38.5465 47.7653 25.9467 50.3692L7.02287 54.2801C2.77187 55.1586 0.13598 59.4329 1.25947 63.6258C2.38309 67.8192 6.8038 70.2029 10.9248 68.8373L29.3407 62.7351C41.5851 58.6779 55.0695 62.291 63.6448 71.9269L76.5434 86.4207C79.4289 89.6631 84.4482 89.8092 87.5174 86.74C90.5871 83.6703 90.4404 78.6501 87.1969 75.7648L72.609 62.7885C62.9468 54.1936 59.3239 40.6746 63.3932 28.3998L69.5188 9.92278C70.8847 5.80285 68.5018 1.38278 64.3092 0.259394Z" fill="url(#iw-doppler-b)" fill-opacity="0.66"/>
  </g>
</svg>`;
