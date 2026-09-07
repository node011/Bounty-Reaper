"""Scope is the security boundary — if it says yes wrongly, we attack a stranger."""

import pytest

from bb_recon import scope


@pytest.fixture
def s():
    return {"include": ["example.com", "*.target.com", "203.0.113.0/24"], "exclude": [], "allow_private": False}


# ---------------------------------------------------------------- host parsing


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("example.com", "example.com"),
        ("EXAMPLE.COM", "example.com"),
        ("https://example.com/a/b?c=d", "example.com"),
        ("http://example.com:8443/", "example.com"),
        ("example.com:443", "example.com"),
        ("user:pass@example.com", "example.com"),
        ("https://user@example.com/x", "example.com"),
        ("example.com.", "example.com"),
        ("[2001:db8::1]:8080", "2001:db8::1"),
    ],
)
def test_host_normalisation(raw, expected):
    assert scope.host(raw) == expected


# ---------------------------------------------------------------- matching


def test_exact_match(s):
    assert scope.check("example.com", s)["in_scope"]
    assert scope.check("https://example.com/admin", s)["in_scope"]


def test_wildcard_covers_subdomains_and_apex(s):
    assert scope.check("api.target.com", s)["in_scope"]
    assert scope.check("deep.nested.target.com", s)["in_scope"]
    assert scope.check("target.com", s)["in_scope"]


def test_wildcard_does_not_leak_to_sibling_domains(s):
    # The classic bug: endswith("target.com") also matches eviltarget.com.
    assert not scope.check("eviltarget.com", s)["in_scope"]
    assert not scope.check("nottarget.com", s)["in_scope"]
    assert not scope.check("target.com.evil.com", s)["in_scope"]


def test_subdomain_of_exact_rule_is_out_of_scope(s):
    # "example.com" is exact, not a wildcard — api.example.com is NOT covered.
    assert not scope.check("api.example.com", s)["in_scope"]


def test_cidr_boundaries(s):
    assert scope.check("203.0.113.1", s)["in_scope"]
    assert scope.check("203.0.113.255", s)["in_scope"]
    assert not scope.check("203.0.114.1", s)["in_scope"]


def test_private_cidr_in_scope_still_needs_allow_private():
    # Putting 10.0.0.0/24 in scope is not enough on its own — an external
    # engagement that resolves to RFC1918 is a misconfiguration, not a target.
    s = {"include": ["10.0.0.0/24"], "exclude": [], "allow_private": False}
    v = scope.check("10.0.0.5", s)
    assert not v["in_scope"]
    assert "allow_private" in v["reason"]


def test_exclude_beats_include():
    s = {"include": ["*.target.com"], "exclude": ["prod.target.com"], "allow_private": False}
    assert scope.check("dev.target.com", s)["in_scope"]
    assert not scope.check("prod.target.com", s)["in_scope"]


def test_wildcard_exclude():
    s = {"include": ["*.target.com"], "exclude": ["*.prod.target.com"], "allow_private": False}
    assert not scope.check("db.prod.target.com", s)["in_scope"]
    assert scope.check("db.dev.target.com", s)["in_scope"]


# ---------------------------------------------------------------- deny by default


def test_empty_scope_denies_everything():
    s = {"include": [], "exclude": [], "allow_private": False}
    v = scope.check("example.com", s)
    assert not v["in_scope"]
    assert "no scope configured" in v["reason"]


def test_unmatched_host_denied(s):
    assert not scope.check("google.com", s)["in_scope"]


# ---------------------------------------------------------------- reserved ranges


@pytest.mark.parametrize(
    "ip", ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "::1"]
)
def test_private_and_metadata_blocked_by_default(ip):
    s = {"include": ["0.0.0.0/0", "::/0"], "exclude": [], "allow_private": False}
    v = scope.check(ip, s)
    assert not v["in_scope"], f"{ip} must be blocked without allow_private"
    assert "reserved range" in v["reason"]


def test_metadata_endpoint_blocked_even_when_explicitly_included():
    # Someone pasting the metadata IP into scope is a mistake, not an intent.
    s = {"include": ["169.254.169.254"], "exclude": [], "allow_private": False}
    assert not scope.check("169.254.169.254", s)["in_scope"]


def test_allow_private_unlocks_internal_engagement():
    s = {"include": ["10.0.0.0/8"], "exclude": [], "allow_private": True}
    assert scope.check("10.1.2.3", s)["in_scope"]


# ---------------------------------------------------------------- require()


def test_require_filters_rather_than_failing(s):
    allowed = scope.require(["example.com", "google.com", "api.target.com"], s)
    assert allowed == ["example.com", "api.target.com"]


def test_require_raises_when_nothing_survives(s):
    with pytest.raises(scope.ScopeError) as e:
        scope.require(["google.com", "facebook.com"], s)
    assert "No in-scope targets" in str(e.value)


def test_require_accepts_single_string(s):
    assert scope.require("example.com", s) == ["example.com"]


# ---------------------------------------------------------------- persistence


def test_save_and_load_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("BB_RECON_OUTPUT_DIR", str(tmp_path))
    saved = scope.save(["*.Example.COM ", "", "  api.x.com"], ["old.example.com"], allow_private=True)
    assert saved["include"] == ["*.example.com", "api.x.com"]
    assert saved["allow_private"] is True
    assert scope.load()["include"] == saved["include"]


def test_env_scope_used_when_no_file(tmp_path, monkeypatch):
    monkeypatch.setenv("BB_RECON_OUTPUT_DIR", str(tmp_path))
    monkeypatch.setenv("BB_RECON_SCOPE", "*.a.com, b.com")
    loaded = scope.load()
    assert loaded["include"] == ["*.a.com", "b.com"]
    assert loaded["source"] == "BB_RECON_SCOPE"


def test_audit_appends_jsonl(tmp_path, monkeypatch):
    import json

    monkeypatch.setenv("BB_RECON_OUTPUT_DIR", str(tmp_path))
    scope.audit("takeover_scan", ["a.example.com"], {"note": "x"})
    scope.audit("js_intel", ["b.example.com"])
    lines = (tmp_path / "audit.jsonl").read_text().strip().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["action"] == "takeover_scan"
    assert json.loads(lines[1])["count"] == 1
