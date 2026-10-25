"""Teste les flux candidats de « Pour aller plus loin » et écrit le résultat dans flux-test.txt."""
import re, requests, feedparser
from urllib.parse import urljoin
UA = {"User-Agent": "Mozilla/5.0 (compatible; LeCondense/1.0)"}
SITES = {
 "L'Opinion": ["https://www.lopinion.fr/rss", "https://www.lopinion.fr/feed", "https://www.lopinion.fr/"],
 "Le Grand Continent": ["https://legrandcontinent.eu/fr/feed/", "https://legrandcontinent.eu/fr/"],
 "Le Point": ["https://www.lepoint.fr/debats/rss.xml", "https://www.lepoint.fr/rss.xml", "https://www.lepoint.fr/"],
 "Challenges": ["https://www.challenges.fr/rss.xml", "https://www.challenges.fr/"],
 "La Tribune Dimanche": ["https://www.latribune.fr/la-tribune-dimanche/rss", "https://www.latribune.fr/rss/rubriques/la-tribune-dimanche.html", "https://www.latribune.fr/la-tribune-dimanche", "https://www.latribune.fr/"],
 "Telos": ["https://www.telos-eu.com/fr/rss.xml", "https://www.telos-eu.com/fr/"],
 "The Conversation": ["https://theconversation.com/fr/articles.atom", "https://theconversation.com/fr"],
 "Institut Montaigne": ["https://www.institutmontaigne.org/rss.xml", "https://www.institutmontaigne.org/"],
 "Fondation Jean-Jaurès": ["https://www.jean-jaures.org/feed/", "https://www.jean-jaures.org/"],
 "Fondapol": ["https://www.fondapol.org/feed/", "https://www.fondapol.org/"],
 "Ifri": ["https://www.ifri.org/fr/rss.xml", "https://www.ifri.org/fr"],
 "Terra Nova": ["https://tnova.fr/feed/", "https://tnova.fr/"],
 "Les Échos": ["https://services.lesechos.fr/rss/les-echos-idees.xml", "https://www.lesechos.fr/rss/rss_idees_debats.xml", "https://www.lesechos.fr/idees-debats"],
 "L'Express": ["https://www.lexpress.fr/arc/outboundfeeds/rss/idees-et-debats.xml", "https://www.lexpress.fr/idees-et-debats/"],
 "Marianne": ["https://www.marianne.net/rss.xml", "https://www.marianne.net/"],
 "Revue des Deux Mondes": ["https://www.revuedesdeuxmondes.fr/feed/", "https://www.revuedesdeuxmondes.fr/"],
 "Courrier international": ["https://www.courrierinternational.com/feed/all/rss.xml", "https://www.courrierinternational.com/"],
 "AOC": ["https://aoc.media/feed/", "https://aoc.media/"],
 "Esprit": ["https://esprit.presse.fr/rss", "https://esprit.presse.fr/"],
 "Le Rubicon": ["https://lerubicon.org/feed/", "https://lerubicon.org/"],
 "Desk Russie": ["https://desk-russie.eu/feed", "https://desk-russie.eu/"],
 "Diploweb": ["https://www.diploweb.com/spip.php?page=backend", "https://www.diploweb.com/"],
 "Conflits": ["https://www.revueconflits.com/feed/", "https://www.revueconflits.com/"],
 "Atlantico": ["https://atlantico.fr/rss", "https://atlantico.fr/"],
 "Le Figaro Vox": ["https://www.lefigaro.fr/rss/figaro_vox.xml"],
}
out = []
for name, urls in SITES.items():
    found = []
    for u in urls:
        try:
            r = requests.get(u, headers=UA, timeout=20)
        except Exception as e:
            out.append(f"{name} | {u} | ERREUR {e.__class__.__name__}"); continue
        f = feedparser.parse(r.content)
        if f.entries:
            found.append(u)
            out.append(f"{name} | {u} | {r.status_code} | {len(f.entries)} articles | ex: {f.entries[0].get('title','')[:80]}")
            break
        links = re.findall(r'<link[^>]+type="application/(?:rss|atom)\+xml"[^>]*>', r.text or "")
        hrefs = [urljoin(u, h) for l in links for h in re.findall(r'href="([^"]+)"', l)]
        out.append(f"{name} | {u} | {r.status_code} | pas un flux | découverts: {hrefs[:4]}")
        for h in hrefs[:3]:
            try:
                f2 = feedparser.parse(requests.get(h, headers=UA, timeout=20).content)
                out.append(f"{name} | {h} | découvert | {len(f2.entries)} articles | ex: {(f2.entries[0].get('title','')[:80] if f2.entries else '')}")
                if f2.entries:
                    found.append(h); break
            except Exception as e:
                out.append(f"{name} | {h} | ERREUR {e.__class__.__name__}")
        if found:
            break
    out.append(f"=> {name}: {found[0] if found else 'AUCUN FLUX'}")
open("flux-test.txt", "w").write("\n".join(out))
print("\n".join(out))
