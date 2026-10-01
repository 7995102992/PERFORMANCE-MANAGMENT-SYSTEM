// Shared types for company lookup (external data sources)

export interface CompanySuggestion {
  id: string
  label: string
  description: string
  source: 'google' | 'manual'
}

export interface CompanyData {
  name: string
  description: string
  logoUrl: string
  website: string
  country: string
  countryCode: string
  city: string
  state: string
  address: string       // Address Line 1 — street/route/sublocality details
  addressLine2: string  // Address Line 2 — neighborhood / area
  postalCode: string
  phone: string
  industry: string
  foundedYear: string
}
