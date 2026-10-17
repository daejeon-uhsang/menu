"""menu.json + seo/store.json → 검색엔진·AI가 읽을 수 있는 정적 텍스트 생성.

- index.html 의 <!--SEO-HEAD-->, <!--SEO-MENU--> 표시 구간을 다시 씀
  (SEO-MENU 는 #scon 안에 있어서, 화면은 JS가 menu.json으로 그릴 때 그대로 교체됨)
- llms.txt, sitemap.xml 생성
사용: python3 seo/build_seo.py [menu.json 경로]   (pre-commit 훅이 자동 실행)
"""
import datetime, html, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
menu = json.loads(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'menu.json').read_text(encoding='utf-8'))
store = json.loads((ROOT / 'seo' / 'store.json').read_text(encoding='utf-8'))
sections = [s for s in menu['sections'] if s.get('items')]
e = lambda s: html.escape(str(s or ''), quote=True)
oneline = lambda s: re.sub(r'\s+', ' ', str(s or '')).strip()


def price_text(it):
    return ' / '.join(x for x in [it.get('priceBottle'), it.get('priceGlass')] if x)


def offers(it):
    out = []
    for label, raw in (('병', it.get('priceBottle')), ('잔', it.get('priceGlass'))):
        for m in re.finditer(r'([가-힣A-Za-z]*)\s*([\d,]{4,})', raw or ''):
            o = {'@type': 'Offer', 'price': m.group(2).replace(',', ''), 'priceCurrency': 'KRW'}
            name = m.group(1) or (label if it.get('priceBottle') and it.get('priceGlass') else '')
            if name: o['name'] = name
            out.append(o)
    return out


def jsonld():
    a = store['address']
    menu_ld = {'@type': 'Menu', 'name': store['name'] + ' 메뉴', 'url': store['url'], 'inLanguage': 'ko', 'hasMenuSection': []}
    for s in sections:
        items = []
        for it in s['items']:
            mi = {'@type': 'MenuItem', 'name': it['name']}
            desc = oneline(' · '.join(x for x in [it.get('spec'), it.get('desc')] if x))
            if desc: mi['description'] = desc
            of = offers(it)
            if of: mi['offers'] = of if len(of) > 1 else of[0]
            items.append(mi)
        sec = {'@type': 'MenuSection', 'name': s['title'], 'hasMenuItem': items}
        if s.get('note'): sec['description'] = oneline(s['note'])
        menu_ld['hasMenuSection'].append(sec)
    return {
        '@context': 'https://schema.org', '@type': ['Restaurant', 'BarOrPub'],
        'name': store['name'], 'alternateName': store['alternateName'], 'url': store['url'],
        'description': store['description'], 'telephone': store['telephone'],
        'address': {'@type': 'PostalAddress', **a},
        'geo': {'@type': 'GeoCoordinates', **store['geo']},
        'openingHoursSpecification': [{'@type': 'OpeningHoursSpecification', 'dayOfWeek': h['days'], 'opens': h['opens'], 'closes': h['closes']} for h in store['hours']],
        'servesCuisine': store['servesCuisine'], 'priceRange': store['priceRange'],
        'acceptsReservations': store['acceptsReservations'], 'sameAs': store['sameAs'],
        'hasMenu': menu_ld,
    }


def head_block():
    desc = store['description']
    ld = json.dumps(jsonld(), ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    return '\n'.join([
        f'<meta name="description" content="{e(desc)}">',
        f'<link rel="canonical" href="{e(store["url"])}">',
        '<meta property="og:type" content="restaurant">',
        f'<meta property="og:title" content="{e(store["name"])} 메뉴 · 신대방역 전통주 한식주점">',
        f'<meta property="og:description" content="{e(desc)}">',
        f'<meta property="og:url" content="{e(store["url"])}">',
        '<meta property="og:locale" content="ko_KR">',
        '<style>html.js .seo-static{display:none}</style>',
        '<script>document.documentElement.classList.add("js")</script>',
        f'<script type="application/ld+json">{ld}</script>',
    ])


def menu_block():
    h = store['hours']
    out = ['<div class="seo-static">',
           f'<h1>{e(store["name"])} 메뉴</h1>',
           f'<p>{e(store["description"])}</p>',
           f'<p>주소: {e(store["address"]["addressRegion"])} {e(store["address"]["addressLocality"])} {e(store["address"]["streetAddress"])} · 전화 {e(store["telephoneDisplay"])} · 영업시간 {e(", ".join(x["label"] for x in h))}</p>']
    for s in sections:
        out.append(f'<section><h2>{e(s["title"])}</h2>')
        if s.get('note'): out.append(f'<p>{e(oneline(s["note"]))}</p>')
        out.append('<ul>')
        for it in s['items']:
            parts = [f'<strong>{e(it["name"])}</strong>']
            if it.get('spec'): parts.append(e(it['spec']))
            if price_text(it): parts.append(e(price_text(it)) + '원')
            line = ' · '.join(parts)
            if it.get('desc'): line += f'<br>{e(oneline(it["desc"]))}'
            out.append(f'<li>{line}</li>')
        out.append('</ul></section>')
    out.append('</div>')
    return '\n'.join(out)


def llms_txt():
    a, L = store['address'], []
    L += [f'# {store["name"]} ({store["alternateName"]})', '', f'> {store["description"]}', '',
          f'- 주소: {a["addressRegion"]} {a["addressLocality"]} {a["streetAddress"]}',
          f'- 전화: {store["telephoneDisplay"]}',
          f'- 영업시간: {", ".join(x["label"] for x in store["hours"])}']
    L += [f'- {n}' for n in store['notes']]
    L += ['- 예약: 네이버 예약', f'- 메뉴판: {store["url"]}', '']
    L += ['## 링크'] + [f'- {u}' for u in store['sameAs']] + ['']
    for s in sections:
        L += [f'## {s["title"]}']
        if s.get('note'): L.append(oneline(s['note']))
        for it in s['items']:
            row = f'- {it["name"]}'
            if it.get('spec'): row += f' ({oneline(it["spec"])})'
            if price_text(it): row += f': {price_text(it)}원'
            if it.get('desc'): row += f' — {oneline(it["desc"])}'
            L.append(row)
        L.append('')
    L.append(f'가격 단위 원, 당일 입고 상황에 따라 변동될 수 있습니다. 최종 갱신 {datetime.date.today().isoformat()}')
    return '\n'.join(L) + '\n'


def replace_block(text, tag, body):
    pat = re.compile(rf'<!--{tag}-->.*?<!--/{tag}-->', re.S)
    if not pat.search(text): sys.exit(f'index.html 에 <!--{tag}--> 표시가 없습니다')
    return pat.sub(lambda _: f'<!--{tag}-->\n{body}\n<!--/{tag}-->', text)


idx = ROOT / 'index.html'
t = idx.read_text(encoding='utf-8')
t = replace_block(t, 'SEO-HEAD', head_block())
t = replace_block(t, 'SEO-MENU', menu_block())
idx.write_text(t, encoding='utf-8')
(ROOT / 'llms.txt').write_text(llms_txt(), encoding='utf-8')
today = datetime.date.today().isoformat()
(ROOT / 'sitemap.xml').write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    f'<url><loc>{store["url"]}</loc><lastmod>{today}</lastmod></url>\n'
    f'<url><loc>{store["url"]}llms.txt</loc><lastmod>{today}</lastmod></url>\n</urlset>\n', encoding='utf-8')
print(f'SEO 갱신: 섹션 {len(sections)}개, 메뉴 {sum(len(s["items"]) for s in sections)}개')
