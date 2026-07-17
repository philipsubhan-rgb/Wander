// Returns a Clearbit logo URL for known car rental brands.
// Falls back to a generic Clearbit guess for unknown companies.
// The caller should handle onError to show a fallback icon.

const BRAND_DOMAINS: Record<string, string> = {
  hertz:        'hertz.com',
  avis:         'avis.com',
  budget:       'budget.com',
  enterprise:   'enterprise.com',
  sixt:         'sixt.com',
  europcar:     'europcar.com',
  alamo:        'alamo.com',
  national:     'nationalcar.com',
  dollar:       'dollar.com',
  thrifty:      'thrifty.com',
  payless:      'paylesscar.com',
  fox:          'foxrentacar.com',
  advantage:    'advantage.com',
  ace:          'acerentacar.com',
  greenmotion:  'greenmotion.com',
  maggiore:     'maggiore.it',
  goldcar:      'goldcar.es',
  firefly:      'fireflycarrental.com',
  surprice:     'surpricecarrental.com',
  autoeurope:   'autoeurope.com',
  keddy:        'keddy.com',
  nu:           'nucarrental.com',
  routes:       'routescarrental.com',
  interrent:    'interrent.com',
  record:       'record-go.com',
  drivalia:     'drivalia.com',
  localiza:     'localiza.com',
  unidas:       'unidas.com.br',
  movida:       'movida.com.br',
  europrent:    'europrent.rs',
  leasys:       'leasysrent.com',
};

export function carRentalLogoUrl(companyName: string): string {
  // Strip alphanumeric-only key for lookup
  const key = companyName.toLowerCase().replace(/[^a-z]/g, '');

  // 1. Exact key match
  if (BRAND_DOMAINS[key]) return `https://logo.clearbit.com/${BRAND_DOMAINS[key]}`;

  // 2. Partial match (company name contains a known brand)
  for (const [brand, domain] of Object.entries(BRAND_DOMAINS)) {
    if (key.includes(brand)) return `https://logo.clearbit.com/${domain}`;
  }

  // 3. Generic Clearbit guess — strip common suffixes and construct a .com domain
  const slug = companyName
    .toLowerCase()
    .replace(/\b(car|auto|rent(al|als)?|hire|leasing|group|international)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
  return `https://logo.clearbit.com/${slug || key}.com`;
}
