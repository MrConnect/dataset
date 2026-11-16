import asyncio
import ipaddress
import socket
from urllib.parse import urlparse

import httpx

from app.config import settings

BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),        # Loopback
    ipaddress.ip_network("10.0.0.0/8"),         # RFC 1918 Private
    ipaddress.ip_network("172.16.0.0/12"),      # RFC 1918 Private
    ipaddress.ip_network("192.168.0.0/16"),     # RFC 1918 Private
    ipaddress.ip_network("100.64.0.0/10"),      # Carrier-grade NAT
    ipaddress.ip_network("169.254.0.0/16"),     # Link-local & Cloud Metadata (169.254.169.254)
    ipaddress.ip_network("224.0.0.0/4"),        # Multicast
    ipaddress.ip_network("240.0.0.0/4"),        # Reserved
    ipaddress.ip_network("::/128"),             # IPv6 unspecified
    ipaddress.ip_network("::1/128"),            # IPv6 loopback
    ipaddress.ip_network("fc00::/7"),           # IPv6 ULA
    ipaddress.ip_network("fe80::/10"),          # IPv6 link-local
    ipaddress.ip_network("ff00::/8"),           # IPv6 multicast
]


class SSRFBlocked(ValueError):
    """The URL is syntactically fine but points somewhere the server must not reach."""


def _embedded_ipv4(ip: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """IPv4 address tunnelled inside an IPv6 literal (mapped, 6to4, NAT64)."""
    if ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    if ip.sixtofour is not None:
        return ip.sixtofour
    if ip in ipaddress.ip_network("64:ff9b::/96"):
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return None


def is_ip_allowed(ip_str: str) -> bool:
    if settings.ALLOW_LOCAL_NETWORK:
        return True

    try:
        # Strip an IPv6 zone identifier ("fe80::1%eth0").
        ip = ipaddress.ip_address(ip_str.split("%", 1)[0])
    except ValueError:
        return False

    candidates = [ip]
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = _embedded_ipv4(ip)
        if embedded is not None:
            candidates.append(embedded)

    for candidate in candidates:
        for net in BLOCKED_NETWORKS:
            if candidate.version == net.version and candidate in net:
                return False
    return True


def validate_url_safety(url: str) -> None:
    """
    Validates URL to protect against Server-Side Request Forgery (SSRF).
    Blocks private networks, loopbacks, and cloud instance metadata services.
    """
    parsed = urlparse(url)

    if parsed.scheme.lower() not in ("http", "https"):
        raise SSRFBlocked(f"Disallowed scheme '{parsed.scheme}'. Only http and https are permitted.")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL must contain a valid hostname.")

    # Direct IP literal in hostname
    try:
        ipaddress.ip_address(hostname.split("%", 1)[0])
        is_literal = True
    except ValueError:
        is_literal = False

    if is_literal:
        if not is_ip_allowed(hostname):
            raise SSRFBlocked(f"Access to IP address '{hostname}' is blocked by anti-SSRF policy.")
        return

    # Resolve domain to all IPs
    try:
        addr_info = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise ValueError(f"Could not resolve hostname '{hostname}': {e}")

    for item in addr_info:
        ip_str = item[4][0]
        if not is_ip_allowed(ip_str):
            raise SSRFBlocked(
                f"Resolved IP '{ip_str}' for hostname '{hostname}' is blocked by anti-SSRF policy."
            )


async def validate_url_safety_async(url: str) -> None:
    """DNS resolution is blocking; keep it off the event loop."""
    await asyncio.to_thread(validate_url_safety, url)


async def _guard_request(request: httpx.Request) -> None:
    await validate_url_safety_async(str(request.url))


def guarded_client(**kwargs) -> httpx.AsyncClient:
    """httpx client that validates every request it sends.

    The request hook also fires for each redirect hop, so a public URL cannot
    bounce the server onto an internal address.
    """
    hooks = kwargs.pop("event_hooks", {}) or {}
    hooks.setdefault("request", []).insert(0, _guard_request)
    return httpx.AsyncClient(event_hooks=hooks, **kwargs)
