// Shared CORS helper for edge functions
// This file is for reference only - each edge function should copy this pattern

export const ALLOWED_ORIGINS = [
  'https://leaseflow.ai',
  'https://www.leaseflow.ai',
  'https://app.leaseflow.ai',
  'https://theleaseio.lovable.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

export function getCorsHeaders(requestOrigin: string | null): Record<string, string> {
  // Check if origin is in allowed list
  const origin = requestOrigin && ALLOWED_ORIGINS.some(allowed => 
    requestOrigin === allowed || requestOrigin.endsWith('.lovable.app')
  )
    ? requestOrigin 
    : ALLOWED_ORIGINS[0];
    
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}
