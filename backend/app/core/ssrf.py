import ipaddress
import socket
from urllib.parse import urlparse
from app.config import settings

BLOCKED_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),        # Loopback
    ipaddress.ip_network("10.0.0.0/8"),         # RFC 1918 Private
    ipaddress.ip_network("172.16.0.0/12"),      # RFC 1918 Private
    ipaddress.ip_network("192.168.0.0/16"),     # RFC 1918 Private
    ipaddress.ip_network("169.254.0.0/16"),     # Link-local & Cloud Metadata (169.254.169.254)
    ipaddress.ip_network("224.0.0.0/4"),       # Multicast
    ipaddress.ip_network("240.0.0.0/4"),       # Reserved
    ipaddress.ip_network("::1/128"),            # IPv6 loopback
    ipaddress.ip_network("fc00::/7"),           # IPv6 ULA
    ipaddress.ip_network("fe80::/10"),          # IPv6 link-local
]


def is_ip_allowed(ip_str: str) -> bool:
    if settings.ALLOW_LOCAL_NETWORK:
        return True

    try:
        ip = ipaddress.ip_address(ip_str)
        for net in BLOCKED_NETWORKS:
            if ip in net:
                return False
        return True
    except ValueError:
        return False


def validate_url_safety(url: str) -> None:
    """
    Validates URL to protect against Server-Side Request Forgery (SSRF).
    Blocks private networks, loopbacks, and cloud instance metadata services.
    """
    parsed = urlparse(url)

    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError(f"Disallowed scheme '{parsed.scheme}'. Only http and https are permitted.")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL must contain a valid hostname.")

    # Check for direct IP literal in hostname
    try:
        ip = ipaddress.ip_address(hostname)
        if not is_ip_allowed(str(ip)):
            raise ValueError(f"Access to IP address '{hostname}' is blocked by anti-SSRF policy.")
        return
    except ValueError:
        pass  # Hostname is a domain name, proceed to DNS resolution

    # Resolve domain to all IPs
    try:
        addr_info = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise ValueError(f"Could not resolve hostname '{hostname}': {e}")

    for item in addr_info:
        ip_str = item[4][0]
        if not is_ip_allowed(ip_str):
            raise ValueError(
                f"Resolved IP '{ip_str}' for hostname '{hostname}' is blocked by anti-SSRF policy."
            )
