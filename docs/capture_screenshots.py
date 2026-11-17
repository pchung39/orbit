#!/usr/bin/env python3
"""Capture README screenshots from a running ORBIT instance.

python docs/capture_screenshots.py            # server on 127.0.0.1:8000
"""

from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent / "screenshots"
BASE = "http://127.0.0.1:8000/app"
VIEWPORT = {"width": 1440, "height": 900}


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
        page.wait_for_selector("#home-desk", timeout=15000)
        page.wait_for_timeout(500)
        shot(page, "overview-dark.png")

        page.goto(f"{BASE}/incidents", wait_until="networkidle")
        page.wait_for_selector("#inc-list .inc-row", timeout=15000)
        shot(page, "incidents-dark.png")

        # Case walkthrough: the confounder case, investigated, with the replay proof open.
        page.goto(f"{BASE}/incidents/INC-0204", wait_until="networkidle")
        page.wait_for_selector("#case-facts .fact", timeout=15000)
        page.click("#case-run")
        page.wait_for_selector("#hyps .hyp", timeout=30000)
        proof = page.locator('#hyps .hyp.is-open [data-proof-kind="whatif"]')
        if proof.count():
            proof.first.click()
        page.wait_for_timeout(600)
        page.locator("#case-head").scroll_into_view_if_needed()
        shot(page, "case-dark.png")
        page.locator("#sec-explain").scroll_into_view_if_needed()
        shot(page, "case-explanations-dark.png")
        page.locator("#sec-decide").scroll_into_view_if_needed()
        shot(page, "case-decide-dark.png")

        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(400)
        page.click("#theme-toggle")
        page.wait_for_timeout(500)
        shot(page, "overview-light.png")

        browser.close()


if __name__ == "__main__":
    main()
