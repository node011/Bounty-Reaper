"""The triage logic — what gets reported and, more importantly, what gets killed.

A recon tool's value is its false-positive rate. These lock in the kill rules so
a later "improvement" can't quietly start reporting noise again.
"""

from bb_recon import cloud, jsintel, pipeline, urls

# Synthetic, high-entropy, obviously-not-real key material. Assembled at runtime
# rather than written as a literal so GitHub secret scanning does not flag this
# file and raise an AWS alert on a key that never existed.
FAKE_AWS = "AK" + "IA" + "7QF3M2ZWJK5LX8VD"


# ---------------------------------------------------------------- URL classification


def test_juicy_files_detected():
    out = urls.classify([
        "https://a.com/backup.sql",
        "https://a.com/db.sqlite3",
        "https://a.com/.env",
        "https://a.com/app.js",
        "https://a.com/logo.png",
    ])
    juicy = out["juicy_files"]
    assert "https://a.com/backup.sql" in juicy
    assert "https://a.com/db.sqlite3" in juicy
    assert "https://a.com/app.js" not in juicy
    assert "https://a.com/logo.png" not in juicy


def test_bare_json_and_xml_are_not_juicy():
    # Every SPA serves manifest.json and sitemap.xml. Flagging them buries the
    # one real .sql dump in a thousand rows of noise.
    out = urls.classify(["https://a.com/manifest.json", "https://a.com/sitemap.xml"])
    assert out["juicy_files"] == []


def test_parameterized_urls_dedup_by_shape():
    corpus = [f"https://a.com/item?id={i}" for i in range(500)]
    corpus.append("https://a.com/item?id=1&debug=true")
    corpus.append("https://a.com/other?q=x")
    out = urls.classify(corpus)
    # ?id=N collapses to one; the extra param set and the other path are distinct.
    assert len(out["parameterized"]) == 3


def test_ssrf_candidates_by_param_name():
    out = urls.classify(["https://a.com/fetch?url=https://b.com&id=3"])
    assert out["ssrf_candidates"][0]["params"] == ["url"]


def test_ssrf_candidates_by_urlish_value():
    # Param name is meaningless, but the value is a full URL the server may fetch.
    out = urls.classify(["https://a.com/go?wombat=https://evil.com/x"])
    assert out["ssrf_candidates"][0]["params"] == ["wombat"]


def test_non_ssrf_params_ignored():
    out = urls.classify(["https://a.com/search?q=hello&page=2&sort=asc"])
    names = [p for c in out["ssrf_candidates"] for p in c["params"]]
    assert "q" not in names and "sort" not in names


def test_sensitive_paths():
    out = urls.classify(["https://a.com/admin/users", "https://a.com/actuator/env", "https://a.com/blog/post"])
    assert len(out["sensitive_paths"]) == 2


# ---------------------------------------------------------------- secret detection


def test_aws_key_detected():
    hits = jsintel.scan_text(f'const k = "{FAKE_AWS}";' , "app.js")
    assert any(h["type"] == "aws_access_key" and h["severity"] == "critical" for h in hits)


def test_placeholder_secrets_rejected():
    for body in (
        'key = "AKIAXXXXXXXXXXXXXXXX"',
        'key = "sk-your_key_here_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
        'token = "ghp_EXAMPLE00000000000000000000000000000"',
    ):
        assert jsintel.scan_text(body, "x.js") == [], body


def test_low_entropy_rejected():
    # Matches the AKIA shape but is obviously not a real key.
    assert jsintel.scan_text('k = "AKIAAAAAAAAAAAAAAAAA"', "x.js") == []


def test_secret_value_is_masked_not_echoed():
    hits = jsintel.scan_text(f'k = "{FAKE_AWS}"' , "x.js")
    assert hits
    assert FAKE_AWS not in hits[0]["match"]
    assert hits[0]["full_length"] == 20


def test_private_key_header_detected_despite_low_entropy():
    hits = jsintel.scan_text("-----BEGIN RSA PRIVATE KEY-----", "x.js")
    assert any(h["type"] == "private_key" for h in hits)


def test_findings_carry_a_validation_command_not_a_validation_call():
    hits = jsintel.scan_text(f'k = "{FAKE_AWS}"' , "x.js")
    assert "aws sts get-caller-identity" in hits[0]["validate"]


def test_entropy_ordering():
    assert jsintel.entropy("aaaaaaaa") < jsintel.entropy("a8Fk2Lq9Zx")


# ---------------------------------------------------------------- cloud


def test_bucket_candidates_cover_common_shapes():
    names = cloud.candidates("acme.com")
    for expected in ("acme", "acme-dev", "acme-backup", "dev-acme", "acme-com", "acmecom"):
        assert expected in names, expected


def test_bucket_candidates_are_valid_names():
    for n in cloud.candidates("acme.com"):
        assert cloud.BUCKET_OK.match(n), n


# ---------------------------------------------------------------- report assembly


def test_low_confidence_takeover_killed():
    report = pipeline.build_report("a.com", {
        "takeover": {"candidates": [
            {"confidence": "low", "service": "s3", "host": "x.a.com", "reason": "r", "poc": "p"},
            {"confidence": "medium", "service": "s3", "host": "y.a.com", "reason": "r", "poc": "p"},
            {"confidence": "high", "service": "heroku", "host": "z.a.com", "reason": "r", "poc": "p"},
        ]}
    })
    assert report["total"] == 1
    assert report["findings"][0]["target"] == "z.a.com"


def test_cors_without_credentials_killed():
    report = pipeline.build_report("a.com", {
        "exposure": {"exposed": [], "graphql": [], "cors": [
            {"url": "https://a.com/", "findings": [
                {"kind": "reflected", "credentials": False, "note": "n", "poc": "p"},
            ]}
        ]}
    })
    assert report["total"] == 0


def test_cors_with_credentials_reported():
    report = pipeline.build_report("a.com", {
        "exposure": {"exposed": [], "graphql": [], "cors": [
            {"url": "https://a.com/", "findings": [
                {"kind": "reflected", "credentials": True, "note": "n", "poc": "p"},
            ]}
        ]}
    })
    assert report["total"] == 1
    assert report["findings"][0]["severity"] == "high"


def test_private_bucket_never_reaches_report():
    report = pipeline.build_report("a.com", {
        "cloud_buckets": {"exposed": [], "other": [
            {"name": "a-dev", "provider": "s3", "state": "private", "severity": "info", "note": "n"}
        ]}
    })
    assert report["total"] == 0


def test_graphql_without_introspection_killed():
    report = pipeline.build_report("a.com", {
        "exposure": {"exposed": [], "cors": [], "graphql": [
            {"url": "https://a.com/graphql", "introspection_enabled": False, "type_count": 0, "poc": "p"},
        ]}
    })
    assert report["total"] == 0


def test_findings_ranked_critical_first():
    report = pipeline.build_report("a.com", {
        "exposure": {"cors": [], "graphql": [], "exposed": [
            {"severity": "medium", "path": "/x", "url": "u1", "content_type": "t", "length": 1, "preview": "p", "poc": "c"},
            {"severity": "critical", "path": "/.env", "url": "u2", "content_type": "t", "length": 1, "preview": "p", "poc": "c"},
            {"severity": "high", "path": "/y", "url": "u3", "content_type": "t", "length": 1, "preview": "p", "poc": "c"},
        ]}
    })
    assert [f["severity"] for f in report["findings"]] == ["critical", "high", "medium"]
    assert report["count_by_severity"]["critical"] == 1


def test_every_finding_ships_a_poc():
    report = pipeline.build_report("a.com", {
        "takeover": {"candidates": [
            {"confidence": "high", "service": "heroku", "host": "z.a.com", "reason": "r", "poc": "curl z"},
        ]},
        "cloud_buckets": {"exposed": [
            {"name": "b", "provider": "s3", "state": "public", "severity": "high", "note": "n", "poc": "curl b"},
        ]},
    })
    assert all(f["poc"] for f in report["findings"])


# ---------------------------------------------------------------- source robustness


async def test_wayback_rejects_html_error_page(monkeypatch):
    """The Internet Archive serves its outage page as 200 text/html."""

    class FakeResp:
        status_code = 200
        headers = {"content-type": "text/html; charset=utf-8"}
        text = "<html><head><title>Internet Archive: Temporarily Offline</title></head></html>"

    async def fake_get(url, **kw):
        return FakeResp()

    monkeypatch.setattr(urls.net, "get", fake_get)
    assert await urls.wayback("example.com") == set()


async def test_wayback_parses_cdx_lines(monkeypatch):
    class FakeResp:
        status_code = 200
        headers = {"content-type": "text/plain"}
        text = "https://a.example.com/x\nhttps://b.example.com/y\n\n"

    async def fake_get(url, **kw):
        return FakeResp()

    monkeypatch.setattr(urls.net, "get", fake_get)
    assert await urls.wayback("example.com") == {
        "https://a.example.com/x",
        "https://b.example.com/y",
    }


async def test_harvest_attributes_sources_correctly_when_one_fails(monkeypatch):
    """A failing source must not shift the others' counts onto its name."""

    async def boom(domain):
        raise RuntimeError("wayback down")

    async def two(domain):
        return {"https://a.example.com/1", "https://a.example.com/2"}

    async def one(domain):
        return {"https://b.example.com/3"}

    monkeypatch.setattr(urls, "wayback", boom)
    monkeypatch.setattr(urls, "otx", two)
    monkeypatch.setattr(urls, "urlscan", one)

    out = await urls.harvest("example.com")
    assert out["by_source"] == {"wayback": 0, "otx": 2, "urlscan": 1}
    assert "wayback" in out["errors"]
    assert len(out["merged"]) == 3


async def test_harvest_drops_offdomain_urls(monkeypatch):
    async def nothing(domain):
        return set()

    async def mixed(domain):
        return {"https://a.example.com/ok", "https://evil.com/no", "https://notexample.com/no"}

    monkeypatch.setattr(urls, "wayback", nothing)
    monkeypatch.setattr(urls, "otx", mixed)
    monkeypatch.setattr(urls, "urlscan", nothing)

    out = await urls.harvest("example.com")
    assert out["merged"] == ["https://a.example.com/ok"]
    assert out["dropped_offdomain"] == 2
