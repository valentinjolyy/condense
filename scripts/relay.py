#!/usr/bin/env python3
"""
Le Condensé : relais GitHub (toutes les 15 minutes, même quand le Mac est éteint).

Lit les flux publics du Monde, du Figaro et de franceinfo, rédige avec Gemini les phrases
du direct à partir des titres et chapôs, prépare au besoin l'agenda, la revue et les
dossiers du matin, puis fusionne le tout dans data/bundle.json (chiffré).
Claude repasse ensuite depuis le Mac pour enrichir avec les articles complets.

Variables : GEMINI_API_KEY, CONDENSE_PASS, CONDENSE_REPO, CONDENSE_TOKEN (GITHUB_TOKEN).
"""
import json
import os
import sys
from datetime import timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "tools"))

import engine as E  # noqa: E402
import store  # noqa: E402

MAX_NEW = 90  # articles traités au plus par passage


def lien(it):
    return {"source": it["source"], "titre": it["title"], "url": it["url"], "date": it.get("published")}


STOP = set("""avec dans pour sans sous selon après avant contre entre leurs cette celle ceux être avoir fait font
plus moins très tout tous toute toutes depuis encore alors ainsi comme mais donc dont elle elles nous vous ils
samedi dimanche lundi mardi mercredi jeudi vendredi octobre novembre décembre janvier février mars avril mai juin
juillet août septembre direct france français française selon""".split())


def _words(s):
    import re
    return {w for w in re.findall(r"[a-zàâçéèêëîïôûùüœ0-9]{5,}", (s or "").lower()) if w not in STOP}


def consolidate(stories: dict) -> list:
    """Fusionne les sujets qui parlent du même événement. Retourne les ids supprimés."""
    items = sorted(stories.values(), key=lambda s: (bool(s.get("complet")), int(s.get("importance") or 0), s.get("last") or ""), reverse=True)
    removed = []
    kept = []
    for st in items:
        w = _words(st.get("titre", "") + " " + st.get("phrase", ""))
        twin = None
        for k, kw in kept:
            if w and kw and len(w & kw) / min(len(w), len(kw)) >= 0.5 and len(w & kw) >= 3:
                twin = k
                break
        if twin is None:
            kept.append((st, w))
            continue
        urls = {l.get("url") for l in twin.get("liens", [])}
        twin["liens"] = twin.get("liens", []) + [l for l in st.get("liens", []) if l.get("url") not in urls]
        twin["last"] = max(twin.get("last") or "", st.get("last") or "")
        stories.pop(st["id"], None)
        removed.append(st["id"])
    return removed


# ---- Pour aller plus loin : revues, think tanks, presse d'idées
PLUSLOIN = [
    # (source, flux, accès)
    ("Le Grand Continent", "https://legrandcontinent.eu/fr/feed/", "gratuit"),
    ("Telos", "https://www.telos-eu.com/fr/rss.xml", "gratuit"),
    ("The Conversation", "https://theconversation.com/fr/articles.atom", "gratuit"),
    ("Institut Montaigne", "https://www.institutmontaigne.org/rss.xml", "gratuit"),
    ("Fondation Jean-Jaurès", "https://www.jean-jaures.org/feed/", "gratuit"),
    ("Terra Nova", "https://tnova.fr/feed/", "gratuit"),
    ("Le Rubicon", "https://lerubicon.org/feed/", "gratuit"),
    ("Desk Russie", "https://desk-russie.eu/feed", "gratuit"),
    ("Diploweb", "https://www.diploweb.com/spip.php?page=backend", "gratuit"),
    ("Conflits", "https://www.revueconflits.com/feed/", "partiel"),
    ("Atlantico", "https://rss.atlantico.fr", "partiel"),
    ("Revue des Deux Mondes", "https://www.revuedesdeuxmondes.fr/feed/", "partiel"),
    ("Esprit", "https://esprit.presse.fr/rss/news.xml", "partiel"),
    ("Courrier international", "https://www.courrierinternational.com/feed/all/rss.xml", "abonnés"),
    ("L'Opinion", "https://www.lopinion.fr/index.rss", "abonnés"),
    ("Challenges", "https://www.challenges.fr/rss.xml", "abonnés"),
    ("L'Express", "https://www.lexpress.fr/arc/outboundfeeds/rss/idees-et-debats.xml", "abonnés"),
    ("AOC", "https://aoc.media/feed/", "abonnés"),
]

PLUSLOIN_PROMPT = """Nous sommes le {date}. Voici de nouveaux articles de revues, think tanks et journaux d'idées.
Le lecteur (collaborateur parlementaire, juriste, très informé) veut une sélection « pour aller plus loin » :
uniquement des articles DE FOND, d'ANALYSE ou d'OPINION utiles pour comprendre le monde, la politique,
l'économie, les idées, et garder un regard critique. Écarte : brèves, dépêches, actualité chaude sans analyse,
sport, culture divertissante, consommation, vie pratique, publicité, pages de service.
Pour les sources à accès « abonnés », ne garde que les textes vraiment importants (note 3).

ARTICLES :
{items}

Pour chaque article à garder : {{"item": id, "genre": Analyse | Tribune | Entretien | Note | Étude | Portrait | Essai | Enquête | Éditorial | Chronique,
"auteur": nom et qualité si connus, "these": UNE phrase précise qui dit la thèse ou l'apport, "theme": International | Politique | Économie | Société | Idées | Europe | Défense | Sciences,
"note": 1 à 3 (3 = incontournable)}}.
JSON attendu : {{"garder": [ ... ]}}  (les articles non listés sont écartés)"""


def plus_loin(data, now, ai_ok):
    """Ajoute les nouveaux articles de fond des revues et think tanks. Retourne le nombre ajouté."""
    seen = set(data.get("seen_pl", []))
    pl = {a["id"]: a for a in data.get("plusloin", [])}
    fresh = []
    for source, url, acces in PLUSLOIN:
        try:
            r = E.requests.get(url, headers={"User-Agent": E.UA}, timeout=25)
            feed = E.feedparser.parse(r.content)
        except Exception as e:
            E.log(f"Plus loin : {source} en échec ({e.__class__.__name__})")
            continue
        for e in feed.entries[:25]:
            link = e.get("link")
            if not link:
                continue
            link = E.norm_url(link)
            if link in seen:
                continue
            pub = None
            for k in ("published_parsed", "updated_parsed"):
                if e.get(k):
                    from datetime import datetime, timezone
                    pub = datetime(*e[k][:6], tzinfo=timezone.utc)
                    break
            if pub and pub < now - timedelta(days=4):
                seen.add(link)
                continue
            fresh.append({"id": "p" + E.make_id(link), "source": source, "acces": acces, "url": link,
                          "titre": E.clean_text(e.get("title"), 300),
                          "chapo": E.clean_text(e.get("summary") or e.get("description"), 350),
                          "auteur": E.clean_text(e.get("author"), 80) if e.get("author") else "",
                          "date": E.iso(pub or now)})
    # La sélection et la thèse sont faites par Claude (tâche « Le journal ») : on stocke les candidats
    cand = {c["id"]: c for c in data.get("pl_cand", [])}
    done = set(data.get("pl_done", []))
    for it in fresh:
        if it["id"] not in done:
            cand[it["id"]] = it
    seen.update(i["url"] for i in fresh)
    lim_c = E.iso(now - timedelta(days=4))
    data["pl_cand"] = sorted([c for c in cand.values() if c["date"] >= lim_c], key=lambda c: c["date"], reverse=True)[:400]
    if fresh:
        data["_pl_proc"] = len(fresh)
    added = 0
    lim = E.iso(now - timedelta(days=8))
    data["plusloin"] = sorted([a for a in pl.values() if a["date"] >= lim], key=lambda a: a["date"], reverse=True)[:250]
    data["seen_pl"] = list(seen)[-3000:]
    E.log(f"Plus loin : {len(fresh)} nouveaux candidats ({len(data['pl_cand'])} en attente de sélection)")
    return added


def main():
    repo, token, pw = (os.environ[k] for k in ("CONDENSE_REPO", "CONDENSE_TOKEN", "CONDENSE_PASS"))
    now = E.now_utc()
    paris = now.astimezone(E.PARIS)
    today = paris.date().isoformat()

    bundle, _ = store.current(repo, token)
    data = store.decrypt(bundle, pw) if bundle else dict(store.EMPTY)
    for k, v in store.EMPTY.items():
        data.setdefault(k, v if not isinstance(v, (list, dict)) else type(v)())
    seen = set(data["seen"])
    first = not data["seen"]

    items = E.fetch_feeds()
    by_id = {i["id"]: i for i in items}
    fresh = []
    for it in items:
        if it["url"] in seen:
            continue
        pub = E.parse_iso(it.get("published"))
        if pub and pub < now - timedelta(hours=18 if first else 36):
            continue
        fresh.append(it)
    fresh.sort(key=lambda i: i.get("published") or "")
    skipped = fresh[:-MAX_NEW] if len(fresh) > MAX_NEW else []
    fresh = fresh[-MAX_NEW:]
    E.log(f"{len(items)} articles dans les flux, {len(fresh)} nouveaux")

    stories = {s["id"]: s for s in data["stories"]}
    analyses = {a["id"]: a for a in data["analyses"]}
    ai_ok = bool(os.environ.get("GEMINI_API_KEY"))
    handled = set()

    def add_analysis(it, a=None):
        a = a or {}
        analyses[it["id"]] = {
            "id": it["id"], "titre": it["title"], "source": it["source"], "url": it["url"],
            "date": it.get("published") or E.iso(now), "type": a.get("type") or "Tribune",
            "auteur": a.get("auteur") or it.get("author", ""), "these": a.get("these") or it["summary"],
            "theme": a.get("theme", ""), "chapo": it["summary"],
        }

    def raw_story(it):
        sid = "r" + it["id"]
        stories[sid] = {
            "id": sid, "titre": it["title"], "phrase": it["summary"] or it["title"], "faits": "",
            "contexte": "", "enjeux": "", "chiffres": [], "a_suivre": "", "angles": "",
            "categorie": E.guess_cat(it), "importance": 2, "lieu": "", "liens": [lien(it)],
            "first": it.get("published") or E.iso(now), "last": it.get("published") or E.iso(now),
            "complet": False, "ai": False,
        }

    # ---- Direct : regroupement et phrases par Gemini, par lots
    pending = list(fresh)
    while pending and ai_ok:
        batch, pending = pending[:E.MAX_ITEMS_PER_CALL], pending[E.MAX_ITEMS_PER_CALL:]
        recent = sorted((s for s in stories.values()
                         if E.parse_iso(s.get("last")) and E.parse_iso(s["last"]) > now - timedelta(hours=36)),
                        key=lambda s: s.get("last", ""), reverse=True)[:120]
        prompt = E.LIVE_PROMPT.format(
            date=E.fr_date(now), heure=paris.strftime("%Hh%M"),
            stories="\n".join(f"- id={s['id']} | {s.get('categorie','')} | {s['titre']} :: {s.get('phrase','')}" for s in recent) or "(aucun)",
            items="\n".join(E.item_line(i) for i in batch), categories=", ".join(E.CATEGORIES))
        try:
            res = E.gemini(prompt, search=True)
        except E.AIUnavailable as e:
            E.log(f"IA indisponible : {e}")
            ai_ok = False
            pending = batch + pending
            break
        bmap = {i["id"]: i for i in batch}
        fiches = {f.get("id"): f for f in res.get("stories", []) if isinstance(f, dict)}
        newmap = {}
        for a in res.get("assign", []):
            it = bmap.get(a.get("item"))
            if not it:
                continue
            handled.add(it["id"])
            dec = a.get("decision")
            if dec == "skip":
                continue
            if dec == "analyse":
                add_analysis(it)
                continue
            key = str(a.get("story") or "")
            if key in stories:
                st = stories[key]
            else:
                sid = newmap.setdefault(key, "g" + E.make_id(key, it["id"]))
                st = stories.setdefault(sid, {
                    "id": sid, "titre": it["title"], "phrase": it["title"], "faits": it["summary"],
                    "contexte": "", "enjeux": "", "chiffres": [], "a_suivre": "", "angles": "",
                    "categorie": E.guess_cat(it), "importance": 2, "lieu": "", "liens": [],
                    "first": it.get("published") or E.iso(now), "last": it.get("published") or E.iso(now),
                    "complet": False, "ai": True})
            if it["url"] not in {l["url"] for l in st["liens"]}:
                st["liens"].append(lien(it))
            st["last"] = max(st.get("last") or "", it.get("published") or E.iso(now))
        for a in res.get("analyses", []):
            it = bmap.get(a.get("item"))
            if it:
                handled.add(it["id"])
                add_analysis(it, a)
        for key, f in fiches.items():
            st = stories.get(newmap.get(key, key))
            if not st:
                continue
            if isinstance(f.get("maj"), str) and f["maj"].strip() and key in stories:
                st["maj"] = f["maj"].strip()
            if st.get("complet"):
                # fiche rédigée par Claude sur articles complets : on ne l'écrase pas
                continue
            for fld in ("titre", "phrase", "faits", "contexte", "enjeux", "a_suivre", "angles", "lieu"):
                if isinstance(f.get(fld), str) and f[fld].strip():
                    st[fld] = f[fld].strip()
            if isinstance(f.get("chiffres"), list):
                st["chiffres"] = [c for c in f["chiffres"] if isinstance(c, dict) and c.get("valeur")][:4]
            if f.get("categorie") in E.CATEGORIES:
                st["categorie"] = f["categorie"]
            try:
                st["importance"] = max(1, min(5, int(f.get("importance", st["importance"]))))
            except (TypeError, ValueError):
                pass
            st["ai"] = True
        for it in batch:
            if it["id"] not in handled:
                if it["kind"] == "analysis":
                    add_analysis(it)
                handled.add(it["id"])
    # sans IA : rien de brut ; ces articles seront repris au prochain passage
    retry = {i["url"] for i in pending}
    data["seen"] = list(data["seen"]) + [i["url"] for i in fresh + skipped if i["url"] not in retry]
    hors_sujet = [sid for sid, st in stories.items()
                  if st.get("categorie") == "Sport" or st.get("ai") is False
                  or (not st.get("complet") and int(st.get("importance") or 0) < 3)]
    for sid in hors_sujet:
        stories.pop(sid, None)
    hors_sujet += consolidate(stories)
    data["deleted"] = list(data.get("deleted", [])) + hors_sujet
    data["stories"] = list(stories.values())
    data["analyses"] = list(analyses.values())

    pl_added = plus_loin(data, now, ai_ok)
    daily_done = bool(hors_sujet) or pl_added > 0
    if data.pop("_pl_proc", 0):
        daily_done = True
    if not fresh and not skipped and not daily_done:
        last = E.parse_iso(((data.get("meta") or {}).get("relay") or {}).get("updated"))
        if last and last > now - timedelta(minutes=60) and not os.environ.get("RELAY_PING"):
            E.log("Rien de nouveau : pas de publication")
            print("\n".join(E.LOG[-3:]))
            return
        # battement de cœur horaire : vérifie que l'IA répond et met à jour l'état
        try:
            E.gemini('Réponds avec ce JSON exact : {"ok": true}', max_tokens=200)
            E.log("Rien de nouveau ; IA opérationnelle")
        except E.AIUnavailable as e:
            ai_ok = False
            E.log(f"Rien de nouveau ; IA indisponible : {e}")
    meta = data.get("meta") or {}
    meta["relay"] = {"updated": E.iso(now), "ai": ai_ok, "model": os.environ.get("CONDENSE_LAST_MODEL", ""), "log": E.LOG[-8:]}
    data["meta"] = meta

    tmp = Path("etat-relais.json")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    sys.argv = ["store.py", "push", str(tmp)]
    store.main()
    Path("published.flag").write_text("1")


if __name__ == "__main__":
    main()
