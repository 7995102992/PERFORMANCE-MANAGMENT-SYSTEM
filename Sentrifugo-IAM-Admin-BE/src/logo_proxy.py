"""Logo proxy — fetches company logos by domain.

Strategies (in order):
1. Direct URL if provided
2. Scrape homepage for og:image, apple-touch-icon, favicon links, <img> with "logo"
3. Favicon fallbacks (Google, DuckDuckGo, direct)

SSRF hardening (F-03): the proxy fetches attacker-influenced URLs server-side, so
every outbound request — the initial one AND every redirect hop — is validated
before the socket opens: scheme must be http/https, the host is resolved to its
IP(s), and any private/loopback/link-local/reserved address is refused. Redirects
are followed manually (bounded) so each hop is re-validated; httpx auto-redirects
are disabled. The route also requires authentication.
"""

import ipaddress
import re
import socket
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from src.auth.schemas import UserBase
from src.auth.utils.dependencies import get_current_user

router = APIRouter(prefix="/api", tags=["logo-proxy"])

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)

# Bounds for outbound fetches.
MAX_REDIRECTS = 3
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MB
# A conservative hostname/domain shape (labels + TLD, optional :port). Rejects
# I, userinfo, paths and other smuggling in the ``domain`` param.
_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+"
    r"[a-zA-Z]{2,63}(?::\d{1,5})?$"
)


class BlockedTarget(Exception):
    """Raised when a fetch target resolves to a disallowed address/scheme."""


def _is_public_ip(ip_str: str) -> bool:
    """True only for globally-routable addresses.

    Rejects loopback, private (RFC1918), link-local (incl. 169.254.169.254),
    unique-local, multicast, reserved and unspecified ranges — for both IPv4 and
    IPv6 (including IPv4-mapped IPv6, which ``ipaddress`` normalises).
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _resolve_and_pin(url: str) -> tuple[str, str, str]:
    """Reject non-HTTP(S) schemes and any host that resolves to a private IP, and
    return ``(pinned_ip, host, host_header)`` for a connection pinned to that IP.

    Resolution happens once, here (post-DNS), so hostnames that map to internal
    addresses — including ``nip.io``-style names and decimal/hex IP encodings —
    are caught, not just literal private IPs. Every resolved address must be
    public; the first one is pinned so the socket connects to exactly the IP we
    validated. This closes the DNS-rebinding TOCTOU (NEW-1): httpx no longer does
    a second lookup that could rebind to an internal address between validation
    and connect. Raises ``BlockedTarget`` on refusal.
    """
    try:
        parsed = httpx.URL(url)
    except Exception as exc:  # malformed URL
        raise BlockedTarget(f"malformed url: {url}") from exc

    if parsed.scheme not in ("http", "https"):
        raise BlockedTarget(f"scheme not allowed: {parsed.scheme}")

    host = parsed.host
    if not host:
        raise BlockedTarget("missing host")

    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise BlockedTarget(f"dns resolution failed: {host}") from exc

    pinned_ip: str | None = None
    for info in infos:
        ip_str = info[4][0]
        if not _is_public_ip(ip_str):
            raise BlockedTarget(f"host resolves to non-public address: {host} -> {ip_str}")
        if pinned_ip is None:
            pinned_ip = ip_str
    if pinned_ip is None:
        raise BlockedTarget(f"no addresses for host: {host}")

    # Preserve a correct Host header (include the port only when non-default).
    host_header = host if parsed.port is None else f"{host}:{parsed.port}"
    return pinned_ip, host, host_header


async def _safe_get(client: httpx.AsyncClient, url: str) -> httpx.Response | None:
    """GET with per-hop SSRF validation and manual, bounded redirect following.

    Returns the final response, or None if any hop is blocked or errors. httpx
    auto-redirects are OFF; each hop's absolute target is re-resolved, validated,
    and pinned to the validated IP before the request so a public host cannot
    redirect us onto an internal one — nor rebind via a second DNS lookup.
    """
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        try:
            pinned_ip, host, host_header = _resolve_and_pin(current)
        except BlockedTarget:
            return None
        # Connect to the exact validated IP (no re-resolution), while keeping the
        # original hostname for the Host header and TLS SNI / certificate check.
        pinned_url = httpx.URL(current).copy_with(host=pinned_ip)
        try:
            r = await client.get(
                pinned_url,
                headers={"User-Agent": UA, "Host": host_header},
                extensions={"sni_hostname": host},
                follow_redirects=False,
            )
        except Exception:
            return None
        if r.is_redirect:
            location = r.headers.get("location")
            if not location:
                return None
            # Resolve relative redirects against the current URL before re-checking.
            current = str(httpx.URL(current).join(location))
            continue
        return r
    return None  # redirect limit exceeded


async def _try_fetch_image(client: httpx.AsyncClient, url: str) -> tuple[bytes, str] | None:
    r = await _safe_get(client, url)
    if r is None or r.status_code != 200:
        return None
    ct = r.headers.get("content-type", "")
    if not ct.startswith("image/"):
        return None
    content = r.content
    if len(content) > MAX_IMAGE_BYTES:
        return None
    return content, ct


async def _scrape_logos(client: httpx.AsyncClient, domain: str) -> list[str]:
    r = await _safe_get(client, f"https://{domain}")
    if r is None or r.status_code != 200:
        return []
    html = r.text
    candidates: list[str] = []

    og = re.search(
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        html, re.IGNORECASE,
    ) or re.search(
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        html, re.IGNORECASE,
    )
    if og:
        candidates.append(og.group(1))

    for m in re.finditer(
        r'<link[^>]+rel=["\'](?:apple-touch-icon|apple-touch-icon-precomposed)["\'][^>]+href=["\']([^"\']+)["\']',
        html, re.IGNORECASE,
    ):
        candidates.append(m.group(1))

    for m in re.finditer(
        r'<link[^>]+rel=["\'](?:icon|shortcut icon)["\'][^>]+href=["\']([^"\']+)["\']',
        html, re.IGNORECASE,
    ):
        candidates.append(m.group(1))

    for img_tag in re.finditer(
        r'<img[^>]+(?:class|id|src|alt)=["\'][^"\']*logo[^"\']*["\'][^>]*>',
        html, re.IGNORECASE,
    ):
        src = re.search(r'src=["\']([^"\']+)["\']', img_tag.group(0), re.IGNORECASE)
        if src:
            candidates.append(src.group(1))

    resolved: list[str] = []
    for src in candidates:
        if src.startswith("//"):
            resolved.append(f"https:{src}")
        elif src.startswith("http"):
            resolved.append(src)
        elif src.startswith("/"):
            resolved.append(f"https://{domain}{src}")
        else:
            resolved.append(f"https://{domain}/{src}")

    seen: set[str] = set()
    return [u for u in resolved if not (u in seen or seen.add(u))]  # type: ignore[func-returns-value]


@router.get("/logo")
async def get_logo(
    current_user: Annotated[UserBase, Depends(get_current_user)],
    domain: str | None = Query(None),
    url: str | None = Query(None),
) -> Response:
    # Constrain ``domain`` to a bare hostname; reject anything with a scheme,
    # path, userinfo or raw IP before it reaches an outbound fetch.
    if domain is not None and not _DOMAIN_RE.match(domain):
        raise HTTPException(status_code=400, detail="Invalid domain")

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        result = None

        if url:
            result = await _try_fetch_image(client, url)

        if not result and domain:
            for src in await _scrape_logos(client, domain):
                result = await _try_fetch_image(client, src)
                if result:
                    break

        if not result and domain:
            fallbacks = [
                f"https://www.google.com/s2/favicons?domain={domain}&sz=256",
                f"https://icons.duckduckgo.com/ip3/{domain}.ico",
                f"https://{domain}/favicon.ico",
            ]
            for src in fallbacks:
                result = await _try_fetch_image(client, src)
                if result:
                    break

        if not result:
            return Response(status_code=404, content="Logo not found")

        img_bytes, content_type = result
        return Response(
            content=img_bytes,
            media_type=content_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
