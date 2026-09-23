// Връзка с базата данни на семейството (Supabase → Project Settings → API).
// Тези два реда са публични по замисъл – данните се пазят от правилата в supabase/schema.sql.
window.APP_CONFIG = {
  SUPABASE_URL: '',       // напр. 'https://abcdefgh.supabase.co'
  SUPABASE_ANON_KEY: '',  // „anon“ / „publishable“ ключ
};
