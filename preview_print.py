#!/usr/bin/env python3
"""
인쇄 레이아웃 미리보기 스크린샷 생성기
실행: python3 preview_print.py
결과: preview/ 폴더에 page_01.png ~ page_12.png 저장
"""

import subprocess
import time
import sys
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

PROJ = Path(__file__).parent
PORT = 18765
OUT  = PROJ / "preview"


def main():
    OUT.mkdir(exist_ok=True)

    # 로컬 HTTP 서버 시작 (fetch가 file:// 에서 안 되므로)
    server = subprocess.Popen(
        ["python3", "-m", "http.server", str(PORT)],
        cwd=PROJ,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(0.8)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            # A4 가로 기준 (1px ≈ 0.264mm → 210mm = 794px)
            page = browser.new_page(viewport={"width": 840, "height": 1200})

            print("📄 페이지 로딩 중...")
            page.goto(f"http://localhost:{PORT}/index.html", wait_until="networkidle")

            # menu.json 로드 + buildPrintPages() 완료 대기
            page.wait_for_function(
                "window.MD !== null && document.querySelectorAll('.print-page').length >= 12",
                timeout=15000,
            )

            # 인쇄 CSS 활성화 (display:none → display:block 등 적용)
            page.emulate_media(media="print")

            print_pages = page.query_selector_all(".print-page")
            total = len(print_pages)
            print(f"✅ {total}페이지 감지됨\n")

            for i, pg_el in enumerate(print_pages, 1):
                path = OUT / f"page_{i:02d}.png"
                pg_el.screenshot(path=str(path), scale="device")
                label = pg_el.query_selector(".pmh-cat")
                cat = label.inner_text() if label else ""
                print(f"  [{i:2d}/{total}] {cat}  →  preview/page_{i:02d}.png")

            browser.close()

        print(f"\n🎉 완료! {total}장 저장됨 → {OUT}")

        # macOS: Finder에서 preview 폴더 열기
        subprocess.run(["open", str(OUT)], check=False)

    finally:
        server.terminate()


if __name__ == "__main__":
    main()
