#!/usr/bin/env python3
"""
Fetch a URL and extract clean main-content text using Trafilatura.
Usage: python3 trafilatura_scraper.py <url>
Exits 0 and prints text to stdout on success.
Exits 1 and prints error to stderr on failure.
"""
import sys
import trafilatura
from trafilatura.settings import use_config

def main():
    if len(sys.argv) < 2:
        print("Usage: trafilatura_scraper.py <url>", file=sys.stderr)
        sys.exit(1)

    url = sys.argv[1]

    # Configure trafilatura
    config = use_config()
    config.set("DEFAULT", "EXTRACTION_TIMEOUT", "20")

    # Fetch the page
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        print(f"Failed to fetch URL: {url}", file=sys.stderr)
        sys.exit(1)

    # Extract clean text
    text = trafilatura.extract(
        downloaded,
        url=url,
        include_comments=False,
        include_tables=True,
        no_fallback=False,
        favor_recall=True,
    )

    if not text or not text.strip():
        print(f"No content extracted from: {url}", file=sys.stderr)
        sys.exit(1)

    # Cap at ~12000 chars (~3000 tokens) — plenty for LLM context
    print(text.strip()[:12000])

if __name__ == "__main__":
    main()
