// Google Places API (New) — Text Search + Details
// Free $200/month credit covers ~11K lookups.

import type { CompanySuggestion, CompanyData } from '@/types/company'

const PLACES_API_KEY = import.meta.env.VITE_GOOGLE_PLACES_API_KEY ?? ''
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

// ─── Country helpers (shared) ─────────────────────────────────────────────────

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  'united states of america': 'US', 'united states': 'US', 'usa': 'US',
  'india': 'IN', 'republic of india': 'IN',
  'united kingdom': 'UK', 'great britain': 'UK', 'england': 'UK',
  'canada': 'CA', 'australia': 'AU',
  'germany': 'DE', 'france': 'FR', 'japan': 'JP',
  'china': 'CN', 'singapore': 'SG', 'ireland': 'IE',
  'netherlands': 'NL', 'switzerland': 'CH', 'sweden': 'SE',
  'south korea': 'KR', 'brazil': 'BR', 'israel': 'IL',
  'spain': 'ES', 'italy': 'IT', 'mexico': 'MX',
}

function countryNameToCode(name: string): string {
  return COUNTRY_NAME_TO_CODE[name.toLowerCase().trim()] ?? ''
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH — Google Places Text Search (New)
// ═══════════════════════════════════════════════════════════════════════════════

export async function searchCompanies(query: string): Promise<CompanySuggestion[]> {
  if (!query || query.length < 2) return []
  if (!PLACES_API_KEY) return manualOnly(query)

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.types',
      },
      body: JSON.stringify({ textQuery: query, pageSize: 6 }),
    })

    if (!res.ok) return manualOnly(query)
    const data = await res.json()

    const places = (data.places ?? []) as { id: string; displayName?: { text: string }; formattedAddress?: string }[]
    if (places.length === 0) return manualOnly(query)

    const results: CompanySuggestion[] = places.map((p) => ({
      id: `google:${p.id}`,
      label: p.displayName?.text ?? '',
      description: p.formattedAddress ?? '',
      source: 'google' as const,
    }))

    // Always add manual option at the end
    results.push({
      id: 'manual',
      label: query,
      description: 'Use this name directly (no lookup)',
      source: 'manual',
    })

    return results
  } catch {
    return manualOnly(query)
  }
}

function manualOnly(query: string): CompanySuggestion[] {
  return [{
    id: 'manual',
    label: query,
    description: 'Use this name directly',
    source: 'manual',
  }]
}

// ═══════════════════════════════════════════════════════════════════════════════
// FETCH DETAILS — Google Places Details (New)
// ═══════════════════════════════════════════════════════════════════════════════

export async function fetchCompanyData(id: string, source: 'google' | 'manual'): Promise<CompanyData | null> {
  if (source === 'manual') return null
  if (!PLACES_API_KEY) return null

  const placeId = id.replace('google:', '')

  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': PLACES_API_KEY,
        'X-Goog-FieldMask': 'displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri,addressComponents,types,iconMaskBaseUri,iconBackgroundColor',
      },
    })

    if (!res.ok) return null
    const place = await res.json()

    const name = place.displayName?.text ?? ''
    const phone = place.nationalPhoneNumber || place.internationalPhoneNumber || ''
    let website = place.websiteUri ?? ''
    if (website && !website.startsWith('http')) website = `https://${website}`

    // Parse address components semantically
    let city = '', state = '', country = '', countryCode = '', postalCode = ''
    let streetNumber = '', route = ''
    let sublocality1 = '', sublocality2 = '', sublocality3 = '', neighborhood = ''
    let premise = ''

    for (const comp of (place.addressComponents ?? [])) {
      const types: string[] = comp.types ?? []
      const long = comp.longText ?? ''
      const short = comp.shortText ?? ''

      if (types.includes('premise')) premise = long
      else if (types.includes('street_number')) streetNumber = long
      else if (types.includes('route')) route = long
      else if (types.includes('sublocality_level_3')) sublocality3 = long
      else if (types.includes('sublocality_level_2')) sublocality2 = long
      else if (types.includes('sublocality_level_1')) sublocality1 = long
      else if (types.includes('neighborhood')) neighborhood = long
      else if (types.includes('locality') || types.includes('postal_town')) city = long
      else if (!city && types.includes('administrative_area_level_2')) city = long
      else if (types.includes('administrative_area_level_1')) state = long
      else if (types.includes('country')) {
        country = long
        countryCode = countryNameToCode(country) || short
      }
      else if (types.includes('postal_code')) postalCode = long
    }

    // Address Line 1: street-level details
    const line1Parts: string[] = []
    if (premise) line1Parts.push(premise)
    if (streetNumber) line1Parts.push(streetNumber)
    if (route) line1Parts.push(route)
    if (sublocality3) line1Parts.push(sublocality3)
    if (sublocality2) line1Parts.push(sublocality2)
    let addressLine1 = line1Parts.join(', ').trim()

    const formattedLead = place.formattedAddress?.split(',')[0]?.trim() ?? ''
    if (formattedLead && !addressLine1.toLowerCase().includes(formattedLead.toLowerCase()) &&
        !formattedLead.toLowerCase().includes(city.toLowerCase() || 'zzzz')) {
      addressLine1 = addressLine1 ? `${formattedLead}, ${addressLine1}` : formattedLead
    }

    // Address Line 2: area/neighborhood
    const line2Parts: string[] = []
    if (sublocality1) line2Parts.push(sublocality1)
    if (neighborhood && neighborhood !== sublocality1) line2Parts.push(neighborhood)
    const addressLine2 = line2Parts.join(', ').trim()

    // Logo: via local proxy based on website domain
    let logoUrl = ''
    if (website) {
      const domain = website.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      logoUrl = `/api/logo?domain=${encodeURIComponent(domain)}`
    }

    const industry = derivePlaceIndustry(place.types ?? [])

    return {
      name,
      description: place.formattedAddress ?? '',
      logoUrl,
      website,
      country, countryCode, city, state,
      address: addressLine1,
      addressLine2,
      postalCode, phone,
      industry, foundedYear: '',
    }
  } catch {
    return null
  }
}

function derivePlaceIndustry(types: string[]): string {
  const map: Record<string, string> = {
    bank: 'Financial Services',
    finance: 'Financial Services',
    insurance_agency: 'Insurance',
    real_estate_agency: 'Real Estate',
    car_dealer: 'Automotive',
    car_repair: 'Automotive',
    school: 'Education',
    university: 'Education',
    hospital: 'Healthcare',
    pharmacy: 'Pharmaceuticals & Healthcare',
    restaurant: 'Food & Beverage',
    cafe: 'Food & Beverage',
    food: 'Food & Beverage',
    store: 'Retail',
    shopping_mall: 'Retail',
    travel_agency: 'Travel & Tourism',
    lodging: 'Hospitality',
    gym: 'Fitness & Wellness',
    lawyer: 'Legal Services',
    accounting: 'Accounting',
  }
  for (const t of types) if (map[t]) return map[t]
  return ''
}

// ─── Image helpers (used by OrganisationPage logo fill) ──────────────────────

export function getLogoProxyUrl(domain: string): string {
  if (!domain) return ''
  const clean = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return `/api/logo?domain=${encodeURIComponent(clean)}`
}

export async function urlToFile(url: string, filename: string): Promise<File | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    if (blob.type === 'image/png' || blob.type === 'image/jpeg' || blob.type === 'image/jpg') {
      return new File([blob], filename, { type: blob.type })
    }
    return await convertToPng(blob, filename)
  } catch { return null }
}

async function convertToPng(blob: Blob, filename: string): Promise<File | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()

    img.onload = () => {
      const canvas = document.createElement('canvas')
      const maxDim = 600
      let w = img.naturalWidth || 600
      let h = img.naturalHeight || 600
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h)
        w = Math.round(w * scale); h = Math.round(h * scale)
      }
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); resolve(null); return }
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      try { ctx.drawImage(img, 0, 0, w, h) }
      catch { URL.revokeObjectURL(url); resolve(null); return }
      canvas.toBlob((pngBlob) => {
        URL.revokeObjectURL(url)
        if (!pngBlob) { resolve(null); return }
        const pngFilename = filename.replace(/\.[^.]+$/, '') + '.png'
        resolve(new File([pngBlob], pngFilename, { type: 'image/png' }))
      }, 'image/png')
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}
