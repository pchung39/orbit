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
    page.wait_for_timeout(500)


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

        # Ensure demo path is expanded if present.
        expand = page.locator("[data-demo-expand]")
        if expand.count() and expand.first.is_visible():
            expand.first.click()
            page.wait_for_timeout(300)

        shot(page, "overview-dark.png", full_page=True)

        page.click("#tab-incidents")
        page.wait_for_timeout(800)
        shot(page, "incidents-dark.png")

        page.click("#tab-trust")
        page.wait_for_timeout(800)
        shot(page, "trust-dark.png", full_page=True)

        # Case walkthrough — heater-only demo beat + knowledge.
        page.click("#tab-home")
        page.wait_for_timeout(400)
        cta = page.locator('[data-demo-cta="heater"]')
        if cta.count() and cta.first.is_visible():
            cta.first.click()
        else:
            page.click("#tab-incidents")
            page.wait_for_timeout(600)
            page.locator('[data-open-listed="INC-0205"], [data-open-case="INC-0205"]').first.click()
        page.wait_for_selector("#case-desk:not([hidden]), #alarm", timeout=15000)
        page.wait_for_timeout(1000)
        run_btn = page.locator("#assemble, #case-head-cta, .investigation-empty-cta")
        if run_btn.count():
            run_btn.first.click()
            page.wait_for_function(
                "() => document.body.classList.contains('has-investigation')",
                timeout=20000,
            )
            page.wait_for_timeout(500)
        # Contextual knowledge — open grounded procedure.
        knowledge = page.locator("#knowledge-toggle")
        if knowledge.count():
            if page.locator("#knowledge.is-collapsed").count():
                knowledge.first.click()
                page.wait_for_timeout(300)
        doc = page.locator('#knowledge-list [data-doc="EPS-17"]')
        if doc.count():
            doc.first.click()
            page.wait_for_function(
                "() => document.getElementById('reader-title')?.textContent",
                timeout=10000,
            )
            page.wait_for_timeout(400)
            shot(page, "library-dark.png")
        shot(page, "case-dark.png")

        page.click("#tab-home")
        page.wait_for_timeout(400)
        page.click("#theme-toggle")
        page.wait_for_timeout(500)
        shot(page, "overview-light.png", full_page=True)

        browser.close()


if __name__ == "__main__":
    main()
