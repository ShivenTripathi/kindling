import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  screenUrl,
  dedupe,
  DEFAULT_EXCLUSIONS,
} from "../src/filter.js";

describe("normalizeUrl", () => {
  test("already-normalized URL is unchanged", () => {
    assert.equal(
      normalizeUrl("https://example.com/path"),
      "https://example.com/path",
    );
  });

  test("lowercases the host", () => {
    assert.equal(
      normalizeUrl("https://EXAMPLE.com/Path"),
      "https://example.com/Path",
    );
  });

  test("drops the fragment", () => {
    assert.equal(
      normalizeUrl("https://example.com/path#section-2"),
      "https://example.com/path",
    );
  });

  test("strips trailing slash on non-root paths", () => {
    assert.equal(
      normalizeUrl("https://example.com/path/"),
      "https://example.com/path",
    );
  });

  test("keeps a single trailing slash on the root path", () => {
    assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
  });

  test("strips utm_* tracking params", () => {
    assert.equal(
      normalizeUrl(
        "https://example.com/article?utm_source=newsletter&utm_medium=email",
      ),
      "https://example.com/article",
    );
  });

  test("strips fbclid, gclid, mc_eid, ref, ref_src", () => {
    assert.equal(
      normalizeUrl(
        "https://example.com/a?fbclid=abc&gclid=def&mc_eid=ghi&ref=jkl&ref_src=mno",
      ),
      "https://example.com/a",
    );
  });

  test("keeps meaningful query params alongside stripped tracking params", () => {
    assert.equal(
      normalizeUrl("https://example.com/a?id=123&utm_source=x"),
      "https://example.com/a?id=123",
    );
  });

  test("is idempotent (normalizing twice gives the same result)", () => {
    const once = normalizeUrl("https://EXAMPLE.com/Path/?utm_source=x#frag");
    const twice = normalizeUrl(once);
    assert.equal(once, twice);
  });

  test("returns the original string when it cannot be parsed as a URL", () => {
    assert.equal(normalizeUrl("not a url at all"), "not a url at all");
    assert.equal(normalizeUrl(""), "");
    assert.equal(normalizeUrl("/relative/path"), "/relative/path");
  });

  test("handles unicode hostnames", () => {
    // IDNs get punycode-encoded by the URL parser; normalizeUrl should not
    // throw and should still lowercase / drop tracking params consistently.
    const result = normalizeUrl("https://exämple.com/path?utm_source=x");
    assert.ok(result.startsWith("https://"));
    assert.ok(!result.includes("utm_source"));
  });

  test("two differently-tracked URLs normalize to the same key", () => {
    const a = normalizeUrl("https://example.com/article?utm_source=twitter");
    const b = normalizeUrl(
      "https://example.com/article?utm_source=newsletter&utm_campaign=july",
    );
    assert.equal(a, b);
  });
});

describe("DEFAULT_EXCLUSIONS", () => {
  test("includes the required app-like domains", () => {
    const required = [
      "linkedin.com",
      "github.com",
      "facebook.com",
      "instagram.com",
      "x.com",
      "twitter.com",
      "netflix.com",
      "youtube.com",
      "mail.google.com",
      "docs.google.com",
      "drive.google.com",
      "calendar.google.com",
      "slack.com",
      "web.whatsapp.com",
      "messenger.com",
      "checkout.stripe.com",
    ];
    for (const domain of required) {
      assert.ok(
        DEFAULT_EXCLUSIONS.includes(domain),
        `expected ${domain} in DEFAULT_EXCLUSIONS`,
      );
    }
  });
});

describe("screenUrl", () => {
  test("excludes non-http(s) protocols", () => {
    const result = screenUrl("chrome://settings");
    assert.equal(result.include, false);
    assert.equal(result.reason, "not a web page");
  });

  test("excludes ftp protocol", () => {
    const result = screenUrl("ftp://example.com/file");
    assert.equal(result.include, false);
    assert.equal(result.reason, "not a web page");
  });

  test("excludes unparseable input", () => {
    const result = screenUrl("not a url");
    assert.equal(result.include, false);
    assert.equal(result.reason, "not a web page");
  });

  test("excludes localhost", () => {
    const result = screenUrl("http://localhost:3000/app");
    assert.equal(result.include, false);
    assert.equal(result.reason, "local/private address");
  });

  test("excludes 127.0.0.1", () => {
    const result = screenUrl("http://127.0.0.1:8080/");
    assert.equal(result.include, false);
    assert.equal(result.reason, "local/private address");
  });

  test("excludes *.local hosts", () => {
    const result = screenUrl("http://mymachine.local/");
    assert.equal(result.include, false);
    assert.equal(result.reason, "local/private address");
  });

  test("excludes private IPv4 ranges", () => {
    for (const host of [
      "10.0.0.5",
      "172.16.4.1",
      "192.168.1.1",
      "169.254.1.1",
    ]) {
      const result = screenUrl(`http://${host}/`);
      assert.equal(result.include, false, `expected ${host} to be excluded`);
      assert.equal(result.reason, "local/private address");
    }
  });

  test("does not treat a public IP as private", () => {
    const result = screenUrl("http://8.8.8.8/");
    assert.equal(result.include, true);
  });

  test("excludes default-blocked domains with a reason naming the domain", () => {
    const result = screenUrl("https://www.linkedin.com/in/someone");
    assert.equal(result.include, false);
    assert.equal(result.reason, "excluded domain: linkedin.com");
  });

  test("excludes youtube.com", () => {
    const result = screenUrl("https://www.youtube.com/watch?v=abc123");
    assert.equal(result.include, false);
    assert.match(result.reason, /excluded domain/);
  });

  test("excludes banking-pattern hosts even when not in the explicit list", () => {
    const result = screenUrl("https://onlinebanking.somecreditunion.com/login");
    assert.equal(result.include, false);
    assert.match(result.reason, /bank/i);
  });

  test("subdomain matching: news.ycombinator.com only matches if ycombinator.com is listed", () => {
    // ycombinator.com is not in DEFAULT_EXCLUSIONS, so it should be allowed
    // by default; with a user block rule for ycombinator.com, the subdomain
    // should be excluded too.
    const allowed = screenUrl("https://news.ycombinator.com/item?id=1");
    assert.equal(allowed.include, true);

    const blocked = screenUrl("https://news.ycombinator.com/item?id=1", {
      block: ["ycombinator.com"],
    });
    assert.equal(blocked.include, false);
    assert.equal(blocked.reason, "excluded domain: ycombinator.com");
  });

  test("subdomain matching does not false-positive on suffix-similar domains", () => {
    // "notgithub.com" should NOT match the "github.com" block entry.
    const result = screenUrl("https://notgithub.com/whatever");
    assert.equal(result.include, true);
  });

  test("user block rule excludes an additional domain", () => {
    const result = screenUrl("https://example.com/spam", {
      block: ["example.com"],
    });
    assert.equal(result.include, false);
    assert.equal(result.reason, "excluded domain: example.com");
  });

  test("allow overrides both default exclusions and user block rules", () => {
    const result = screenUrl("https://github.com/octocat/readme", {
      allow: ["github.com"],
    });
    assert.equal(result.include, true);
  });

  test("allow overrides a user block rule for the same domain", () => {
    const result = screenUrl("https://example.com/ok", {
      block: ["example.com"],
      allow: ["example.com"],
    });
    assert.equal(result.include, true);
  });

  test("plain article-like URL is included", () => {
    const result = screenUrl("https://blog.example.com/2026/07/some-article");
    assert.equal(result.include, true);
  });
});

describe("dedupe", () => {
  test("dedupes by normalized form, preserving first occurrence order", () => {
    const urls = [
      "https://example.com/a",
      "https://example.com/b",
      "https://EXAMPLE.com/a/", // same as first, different case + trailing slash
      "https://example.com/a?utm_source=x", // same as first once tracking stripped
      "https://example.com/c",
    ];
    const result = dedupe(urls);
    assert.deepEqual(result, [
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  test("empty input yields empty output", () => {
    assert.deepEqual(dedupe([]), []);
  });

  test("no duplicates yields the same list", () => {
    const urls = ["https://a.com/", "https://b.com/"];
    assert.deepEqual(dedupe(urls), urls);
  });
});

// Regression tests for SSRF/screen-bypass vectors found in review. Each of
// these previously returned {include:true} and would have let a request reach
// a loopback/internal target or bypass the exclusion list.
describe("screenUrl — SSRF & bypass regressions", () => {
  test("IPv6 loopback [::1] is blocked", () => {
    assert.equal(screenUrl("http://[::1]/").include, false);
  });

  test("IPv4-mapped IPv6 loopback [::ffff:127.0.0.1] is blocked", () => {
    assert.equal(screenUrl("http://[::ffff:127.0.0.1]/").include, false);
  });

  test("IPv4-mapped IPv6 in canonical hex form is blocked", () => {
    // The URL parser canonicalizes ::ffff:127.0.0.1 to ::ffff:7f00:1.
    assert.equal(
      new URL("http://[::ffff:127.0.0.1]/").hostname,
      "[::ffff:7f00:1]",
    );
    assert.equal(screenUrl("http://[::ffff:7f00:1]/").include, false);
  });

  test("0.0.0.0 is blocked", () => {
    assert.equal(screenUrl("http://0.0.0.0/").include, false);
  });

  test("trailing-dot FQDN does not bypass the exclusion list", () => {
    const r = screenUrl("https://facebook.com./feed");
    assert.equal(r.include, false);
  });

  test("trailing-dot FQDN does not bypass a user block rule", () => {
    const r = screenUrl("https://example.com./x", { block: ["example.com"] });
    assert.equal(r.include, false);
  });

  test("fe80 link-local and fc00 unique-local IPv6 are blocked", () => {
    assert.equal(screenUrl("http://[fe80::1]/").include, false);
    assert.equal(screenUrl("http://[fd00::1]/").include, false);
  });

  test("a genuinely public IPv6 host is still allowed", () => {
    assert.equal(
      screenUrl("http://[2606:4700:4700::1111]/article").include,
      true,
    );
  });
});
