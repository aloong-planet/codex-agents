import { describe, expect, it } from "vitest";

import { articleKey, canonicalizeArticleUrl } from "../src/news-article-identity.js";

describe("news article identity", () => {
  it("removes tracking and fragments while preserving semantic query parameters", () => {
    expect(canonicalizeArticleUrl(
      "https://EXAMPLE.com/story/?utm_source=hn&b=2&a=1#comments",
    )).toBe("https://example.com/story?a=1&b=2");
    expect(canonicalizeArticleUrl("https://news.ycombinator.com/item?id=123")).toBe(
      "https://news.ycombinator.com/item?id=123",
    );
  });

  it("gives tracking variants the same stable article key", () => {
    expect(articleKey("https://example.com/news?utm_campaign=daily#top")).toBe(
      articleKey("https://example.com/news/"),
    );
  });
});
