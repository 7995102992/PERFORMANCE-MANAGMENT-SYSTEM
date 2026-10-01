import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const VITE_API_BASE_URL = env['VITE_API_BASE_URL'] ?? 'http://localhost:8000'
  return {
  base: '/admin',
  plugins: [
    react(),
    tailwindcss(),
    // Logo proxy: scrapes homepage for real logo, falls back to favicons
    {
      name: 'logo-proxy',
      configureServer(server) {
        server.middlewares.use('/api/logo', async (req, res) => {
          try {
            const url = new URL(req.url ?? '', VITE_API_BASE_URL)
            const directUrl = url.searchParams.get('url')
            const domain = url.searchParams.get('domain')
            const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

            const tryFetchImage = async (u: string) => {
              try {
                const r = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'follow' })
                if (!r.ok) return null
                const ct = r.headers.get('content-type') ?? ''
                if (!ct.startsWith('image/')) return null
                return { buf: Buffer.from(await r.arrayBuffer()), contentType: ct }
              } catch { return null }
            }

            // Scrape homepage HTML to find logo URLs from <meta og:image>, <link rel="icon">, <img> with "logo"
            const scrapeLogosFromHomepage = async (domain: string): Promise<string[]> => {
              try {
                const homeUrl = `https://${domain}`
                const r = await fetch(homeUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' })
                if (!r.ok) return []
                const html = await r.text()
                const candidates: string[] = []

                // 1. Open Graph image (usually high quality)
                const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                  || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
                if (ogMatch) candidates.push(ogMatch[1])

                // 2. Apple touch icon (usually 180x180 or higher)
                const appleMatches = [...html.matchAll(/<link[^>]+rel=["'](?:apple-touch-icon|apple-touch-icon-precomposed)["'][^>]+href=["']([^"']+)["']/gi)]
                for (const m of appleMatches) candidates.push(m[1])

                // 3. <link rel="icon"> with larger sizes
                const iconMatches = [...html.matchAll(/<link[^>]+rel=["'](?:icon|shortcut icon)["'][^>]+href=["']([^"']+)["']/gi)]
                for (const m of iconMatches) candidates.push(m[1])

                // 4. <img> tags with "logo" in class/id/src/alt
                const imgMatches = [...html.matchAll(/<img[^>]+(?:class|id|src|alt)=["'][^"']*logo[^"']*["'][^>]*>/gi)]
                for (const imgTag of imgMatches.slice(0, 5)) {
                  const srcMatch = imgTag[0].match(/src=["']([^"']+)["']/i)
                  if (srcMatch) candidates.push(srcMatch[1])
                }

                // Resolve relative URLs to absolute
                return candidates.map((src) => {
                  if (src.startsWith('//')) return `https:${src}`
                  if (src.startsWith('http')) return src
                  if (src.startsWith('/')) return `https://${domain}${src}`
                  return `https://${domain}/${src}`
                }).filter((u, i, arr) => arr.indexOf(u) === i) // dedupe
              } catch {
                return []
              }
            }

            let result = null

            // Strategy 1: Direct URL from caller
            if (directUrl) result = await tryFetchImage(directUrl)

            // Strategy 2: Scrape homepage for high-quality logos
            if (!result && domain) {
              const scraped = await scrapeLogosFromHomepage(domain)
              for (const src of scraped) {
                result = await tryFetchImage(src)
                if (result) break
              }
            }

            // Strategy 3: Favicon fallbacks (small, but always works)
            if (!result && domain) {
              const sources = [
                `https://www.google.com/s2/favicons?domain=${domain}&sz=256`,
                `https://icons.duckduckgo.com/ip3/${domain}.ico`,
                `https://${domain}/favicon.ico`,
              ]
              for (const src of sources) {
                result = await tryFetchImage(src)
                if (result) break
              }
            }

            if (!result) {
              res.statusCode = 404
              res.end('Logo not found')
              return
            }

            res.setHeader('Content-Type', result.contentType)
            res.setHeader('Cache-Control', 'public, max-age=86400')
            res.end(result.buf)
          } catch (e: any) {
            res.statusCode = 500
            res.end(e.message)
          }
        })
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  }
})
