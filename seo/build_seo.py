"""menu.json + seo/store.json → 검색엔진·AI가 읽을 수 있는 정적 텍스트 생성.

- index.html 의 <!--SEO-HEAD-->, <!--SEO-MENU--> 표시 구간을 다시 씀
  (SEO-MENU 는 #scon 안에 있어서, 화면은 JS가 menu.json으로 그릴 때 그대로 교체됨)
- llms.txt, sitemap.xml, faq.html(자주 묻는 질문, 원본 seo/faq.json) 생성
사용: python3 seo/build_seo.py [menu.json 경로]   (pre-commit 훅이 자동 실행)
"""
import datetime, html, json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
menu = json.loads(pathlib.Path(sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != '--preview' else ROOT / 'menu.json').read_text(encoding='utf-8'))
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


PRICES = {}
for _s in sections:
    for _it in _s['items']:
        PRICES[_it['name']] = price_text(_it)
        PRICES['병:' + _it['name']] = _it.get('priceBottle') or ''
        PRICES['잔:' + _it['name']] = _it.get('priceGlass') or ''


def fill(text, src):
    """{메뉴이름} / {병:메뉴이름} / {잔:메뉴이름} → menu.json 가격"""
    def one(m):
        if not PRICES.get(m.group(1)): sys.exit(f'{src}: 메뉴 "{m.group(1)}" 가격을 menu.json에서 찾지 못했습니다')
        return PRICES[m.group(1)]
    return re.sub(r'\{([^{}]+)\}', one, text)


def load_faq():
    return [{'q': f['q'], 'a': fill(f['a'], 'faq.json')}
            for f in json.loads((ROOT / 'seo' / 'faq.json').read_text(encoding='utf-8'))['items']]


def load_guides():
    out = []
    for g in json.loads((ROOT / 'seo' / 'guides.json').read_text(encoding='utf-8'))['items']:
        g = dict(g, answer=fill(g['answer'], 'guides.json'),
                 sections=[{'h': s['h'], 'p': [fill(x, 'guides.json') for x in s['p']]} for s in g['sections']])
        out.append(g)
    return out


def page(title, desc, url, ld, h1, body, back='./'):
    ptype = 'guide' if back == '../' else 'faq'
    tel, teld = store.get('telephone', ''), store.get('telephoneDisplay', '')
    ld = json.dumps(ld, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    return f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-5HZ7QFKDK9"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){{dataLayer.push(arguments);}}
  gtag('js', new Date());
  /* 사장님·직원 기기: 주소에 ?staff=1 로 한 번 열면 이후 방문은 내부 트래픽으로 표시(GA 데이터 필터로 제외) */
  window.uhStaff=false;var uhStaff=false;try{{if(/[?&]staff=1/.test(location.search))localStorage.setItem('uh_staff','1');if(/[?&]staff=0/.test(location.search))localStorage.removeItem('uh_staff');uhStaff=window.uhStaff=localStorage.getItem('uh_staff')==='1'||location.hostname!=='daejeon-uhsang.github.io';}}catch(e){{}}
  gtag('config', 'G-5HZ7QFKDK9', uhStaff?{{traffic_type:'internal'}}:{{}});
</script>
<!-- Microsoft Clarity -->
<script>
  (function(c,l,a,r,i,t,y){{c[a]=c[a]||function(){{(c[a].q=c[a].q||[]).push(arguments)}};
  t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
  y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);}})(window,document,"clarity","script","vw42wutjmo");
</script>
<script>
/* 고객 여정 측정: 페이지 종류·유입 경로 태그, 바깥 링크·전화·검색 이벤트 (GA4 + Clarity 공통) */
(function(){{
  var ptype={ptype!r};
  function ev(n,p){{try{{gtag('event',n,p||{{}});}}catch(e){{}} try{{clarity('event',n);}}catch(e){{}}}}
  window.uhEv=ev;
  var ref='';try{{ref=document.referrer?new URL(document.referrer).hostname:'';}}catch(e){{}}
  var entry=!ref?'direct_or_qr':(ref===location.hostname?'internal':ref.replace(/^www\\./,''));
  try{{clarity('set','page_type',ptype);clarity('set','entry',entry);if(window.uhStaff)clarity('set','internal','1');}}catch(e){{}}
  document.addEventListener('click',function(e){{
    var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href');
    var k=h.indexOf('tel:')===0?'call_click':/naver\\.me|booking\\.naver|map\\.naver/.test(h)?'naver_click':/instagram\\.com/.test(h)?'instagram_click':/pf\\.kakao|kakao\\.com/.test(h)?'kakao_click':/faq\\.html/.test(h)?'faq_click':/guide\\//.test(h)?'guide_click':(/^https?:/.test(h)&&h.indexOf(location.hostname)<0)?'outbound_click':'';
    if(k)ev(k,{{link_url:h,page_type:ptype}});
  }},true);
}})();
</script>
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(url)}">
<meta property="og:type" content="website">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{e(url)}">
<meta property="og:locale" content="ko_KR">
<script type="application/ld+json">{ld}</script>
<style>
:root{{--ink:#180e00;--paper:#f8f0de;--muted:#6b5535;--div:#c4a878;--crimson:#7a1414}}
@media (prefers-color-scheme:dark){{:root{{--ink:#f1e6cf;--paper:#1c150c;--muted:#bba783;--div:#5a4a30;--crimson:#e08a7a}}}}
body{{margin:0;background:var(--paper);color:var(--ink);font:16px/1.75 'Noto Serif KR','Apple SD Gothic Neo',serif}}
main{{max-width:40rem;margin:0 auto;padding:32px max(16px,env(safe-area-inset-right)) 48px max(16px,env(safe-area-inset-left))}}
h1{{font-size:1.5rem;margin:0 0 4px;letter-spacing:.03em;text-wrap:balance}}
.sub{{color:var(--muted);margin:0 0 24px;font-size:.9rem}}
.lead{{font-size:1.05rem;margin:0 0 8px}}
section{{border-top:1px solid var(--div);padding:16px 0}}
h2{{font-size:1.05rem;margin:0 0 6px;color:var(--crimson)}}
p{{margin:0}} section p+p{{margin-top:6px}}
footer{{border-top:2px solid var(--ink);margin-top:16px;padding-top:12px;font-size:.85rem;color:var(--muted)}}
.cta{{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px}}
.cta a{{flex:1 1 30%;min-width:96px;text-align:center;text-decoration:none;padding:11px 8px;border:1px solid var(--crimson);border-radius:10px;color:var(--crimson);font-weight:700;font-size:.92rem}}
.cta a.main{{background:var(--crimson);color:var(--paper)}}
a{{color:inherit}}
</style>
</head>
<body>
<main>
<h1>{e(h1)}</h1>
<div class="cta"><a class="main" href="https://m.booking.naver.com/booking/6/bizes/1058283">네이버 예약</a><a href="tel:{tel}">전화 {teld}</a><a href="https://map.naver.com/p/entry/place/1646646595">지도·길찾기</a></div>
<p class="sub">{e(store["name"])} {e(store["alternateName"])} · {e(store["address"]["addressLocality"])} {e(store["address"]["streetAddress"])} · {e(store["telephoneDisplay"])}</p>
{body}
<div class="cta"><a class="main" href="https://m.booking.naver.com/booking/6/bizes/1058283">네이버 예약</a><a href="tel:{tel}">전화 {teld}</a><a href="https://map.naver.com/p/entry/place/1646646595">지도·길찾기</a></div>
<footer><a href="{back}">메뉴판 보기</a> · <a href="{back}faq.html">자주 묻는 질문</a> · 최종 갱신 {datetime.date.today().isoformat()}<br>방문 통계를 위해 Google Analytics와 Microsoft Clarity를 사용합니다.</footer>
</main>
</body>
</html>
"""


def biz():
    return {'@type': 'Restaurant', 'name': store['name'], 'url': store['url'], 'telephone': store['telephone'],
            'address': {'@type': 'PostalAddress', **store['address']}}


def faq_html(faq):
    url = store['url'] + 'faq.html'
    ld = {'@context': 'https://schema.org', '@type': 'FAQPage', 'url': url, 'inLanguage': 'ko', 'about': biz(),
          'mainEntity': [{'@type': 'Question', 'name': f['q'], 'acceptedAnswer': {'@type': 'Answer', 'text': f['a']}} for f in faq]}
    body = '\n'.join(f'<section><h2>{e(f["q"])}</h2><p>{e(f["a"])}</p></section>' for f in faq)
    if GUIDES:
        body += '\n<section><h2>더 자세한 안내</h2>' + ''.join(f'<p><a href="guide/{g["slug"]}.html">{e(g["title"])}</a></p>' for g in GUIDES) + '</section>'
    return page(f'{store["name"]} 자주 묻는 질문 · 신대방역 전통주 한식주점',
                f'{store["name"]} 영업시간, 오시는 길, 주차, 단체·대관, 예약, 포장, 콜키지, 어복쟁반·뭉티기·육회, 전통주 추천에 대한 답.',
                url, ld, f'{store["name"]} 자주 묻는 질문', body)


def guide_html(g):
    url = f'{store["url"]}guide/{g["slug"]}.html'
    text = ' '.join([g['answer']] + [x for s in g['sections'] for x in s['p']])
    ld = {'@context': 'https://schema.org', '@type': 'Article', 'headline': g['title'], 'url': url, 'inLanguage': 'ko',
          'dateModified': datetime.date.today().isoformat(), 'author': {'@type': 'Organization', 'name': store['name'], 'url': store['url']},
          'about': biz(), 'mainEntity': {'@type': 'Question', 'name': g['question'],
                                         'acceptedAnswer': {'@type': 'Answer', 'text': g['answer']}}}
    body = [f'<p class="lead"><strong>{e(g["question"])}</strong></p>', f'<p class="lead">{e(g["answer"])}</p>']
    for s in g['sections']:
        body.append(f'<section><h2>{e(s["h"])}</h2>' + ''.join(f'<p>{e(x)}</p>' for x in s['p']) + '</section>')
    return page(g['title'], g['answer'][:150], url, ld, g['title'], '\n'.join(body), back='../')


def llms_txt():
    a, L = store['address'], []
    L += [f'# {store["name"]} ({store["alternateName"]})', '', f'> {store["description"]}', '',
          f'- 주소: {a["addressRegion"]} {a["addressLocality"]} {a["streetAddress"]}',
          f'- 전화: {store["telephoneDisplay"]}',
          f'- 영업시간: {", ".join(x["label"] for x in store["hours"])}']
    L += [f'- {n}' for n in store['notes']]
    L += ['- 예약: 네이버 예약', f'- 메뉴판: {store["url"]}', '']
    L += ['## 링크'] + [f'- {u}' for u in store['sameAs']] + ['']
    if GUIDES: L += ['## 질문별 안내'] + [f'- [{g["title"]}]({store["url"]}guide/{g["slug"]}.html): {g["answer"]}' for g in GUIDES] + ['']
    L += ['## 자주 묻는 질문', f'전체: {store["url"]}faq.html'] + [f'- Q. {f["q"]}\n  A. {f["a"]}' for f in FAQ] + ['']
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


FAQ = load_faq()
ALL_GUIDES = load_guides()
if len(sys.argv) > 2 and sys.argv[1] == '--preview':
    # 승인 전 초안 미리보기: 모든 글을 지정 폴더에만 씀 (저장소 파일은 건드리지 않음)
    out = pathlib.Path(sys.argv[2]); (out / 'guide').mkdir(parents=True, exist_ok=True)
    for g in ALL_GUIDES: (out / 'guide' / f'{g["slug"]}.html').write_text(guide_html(g), encoding='utf-8')
    print(f'미리보기 {len(ALL_GUIDES)}개 → {out}/guide/'); sys.exit()
GUIDES = [g for g in ALL_GUIDES if g.get('approved')]
idx = ROOT / 'index.html'
t = idx.read_text(encoding='utf-8')
t = replace_block(t, 'SEO-HEAD', head_block())
t = replace_block(t, 'SEO-MENU', menu_block())
idx.write_text(t, encoding='utf-8')
(ROOT / 'llms.txt').write_text(llms_txt(), encoding='utf-8')
(ROOT / 'faq.html').write_text(faq_html(FAQ), encoding='utf-8')
gdir = ROOT / 'guide'; gdir.mkdir(exist_ok=True)
keep = {f'{g["slug"]}.html' for g in GUIDES}
for f in gdir.glob('*.html'):
    if f.name not in keep: f.unlink()
for g in GUIDES: (gdir / f'{g["slug"]}.html').write_text(guide_html(g), encoding='utf-8')
today = datetime.date.today().isoformat()
urls = ['', 'faq.html'] + [f'guide/{g["slug"]}.html' for g in GUIDES] + ['llms.txt']
(ROOT / 'sitemap.xml').write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + ''.join(f'<url><loc>{store["url"]}{u}</loc><lastmod>{today}</lastmod></url>\n' for u in urls) + '</urlset>\n', encoding='utf-8')
print(f'SEO 갱신: 섹션 {len(sections)}개, 메뉴 {sum(len(s["items"]) for s in sections)}개, FAQ {len(FAQ)}개, 안내글 {len(GUIDES)}/{len(ALL_GUIDES)}개')
