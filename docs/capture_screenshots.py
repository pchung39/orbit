#!/usr/bin/env python3
"""Capture README screenshots from a running ORBIT instance."""

from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent / "screenshots"
BASE = "http://127.0.0.1:8000/"
VIEWPORT = {"width": 1440, "height": 900}


def wait_ready(page) -> None:
    page.wait_for_function(
        "() => document.getElementById('home-clock')?.textContent !== '--:--:--'",
        timeout=15000,
    )
    page.wait_for_timeout(400)


def shot(page, name: str, *, full_page: bool = False) -> None:
    path = OUT / name
    page.screenshot(path=str(path), full_page=full_page)
    print(f"wrote {path}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport=VIEWPORT)
        page.goto(BASE, wait_until="networkidle")
        wait_ready(page)

        shot(page, "overview-dark.png", full_page=True)

        page.click("#tab-incidents")
        page.wait_for_timeout(800)
        shot(page, "incidents-dark.png")

        page.click("#tab-library")
        page.wait_for_timeout(600)
        page.click('[data-doc="EPS-17"]')
        page.wait_for_function(
            "() => document.getElementById('reader-title')?.textContent",
            timeout=10000,
        )
        page.wait_for_timeout(400)
        shot(page, "library-dark.png")

        page.click("#tab-home")
        page.click("#theme-toggle")
        page.wait_for_timeout(400)
        shot(page, "overview-light.png", full_page=True)

        browser.close()


if __name__ == "__main__":
    main()
