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
            if st.get("complet"):
                # fiche rédigée par Claude sur articles complets : on ne l'écrase pas
                if f.get("phrase"):
                    st["maj_relais"] = f["phrase"]
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
                add_analysis(it) if it["kind"] == "analysis" else raw_story(it)
                handled.add(it["id"])
    for it in pending:  # sans IA : affichage brut
        add_analysis(it) if it["kind"] == "analysis" else raw_story(it)

    data["seen"] = list(data["seen"]) + [i["url"] for i in fresh + skipped]
    data["stories"] = list(stories.values())
    data["analyses"] = list(analyses.values())

    # ---- Pages du jour, si Claude ne les a pas encore faites (Mac éteint)
    if ai_ok:
        lines = lambda its: "\n".join(E.short_line(i) for i in its)
        recent_items = [i for i in items if not i.get("published") or E.parse_iso(i["published"]) > now - timedelta(hours=26)]
        def links(ids):
            return [lien(by_id[i]) for i in ids or [] if i in by_id]
        try:
            if (data.get("agenda") or {}).get("date") != today and paris.hour >= 5:
                res = E.gemini(E.AGENDA_PROMPT.format(date=E.fr_date(now), titles="\n".join(E.short_line(i, False) for i in recent_items[:150])), search=True, max_tokens=12000)
                ev = sorted([e for e in res.get("evenements", []) if isinstance(e, dict) and e.get("titre")], key=lambda e: e.get("heure") or "99")
                data["agenda"] = {"date": today, "label": E.fr_date(now), "updated": E.iso(now), "par": "relais",
                                  "midi": paris.hour >= 12, "evenements": ev, "semaine": res.get("semaine", [])}
                E.log(f"Agenda : {len(ev)} événements")
            mi = [i for i in recent_items if i["source"] in ("Le Monde", "Le Figaro")]
            if (data.get("revue") or {}).get("date") != today and paris.hour >= 6 and len(mi) >= 10:
                res = E.gemini(E.REVUE_PROMPT.format(date=E.fr_date(now), heure=paris.strftime("%Hh%M"), items=lines(mi[:220])), search=True, max_tokens=40000)
                rubs = []
                for r in res.get("rubriques", []):
                    su = [s for s in r.get("sujets", []) if isinstance(s, dict) and s.get("titre")]
                    br = [b for b in r.get("breves", []) if isinstance(b, dict)]
                    for x in su + br:
                        x["liens"] = links(x.pop("items", []))
                    if su or br:
                        rubs.append({"nom": r.get("nom", ""), "sujets": su, "breves": br})
                data["revue"] = {"date": today, "label": E.fr_date(now), "updated": E.iso(now), "par": "relais",
                                 "essentiel": res.get("essentiel", ""), "rubriques": rubs}
                E.log("Revue préparée par le relais")
            ci = [i for i in recent_items if any(r in ("International", "Économie", "Une") for r in i["rubriques"])]
            if (data.get("comprendre") or {}).get("date") != today and paris.hour >= 7 and len(ci) >= 8:
                res = E.gemini(E.COMPRENDRE_PROMPT.format(date=E.fr_date(now), items=lines(ci[:200])), search=True, max_tokens=24000)
                ds = [d for d in res.get("dossiers", []) if isinstance(d, dict) and d.get("titre")]
                for d in ds:
                    d["liens"] = links(d.pop("items", []))
                data["comprendre"] = {"date": today, "label": E.fr_date(now), "updated": E.iso(now), "par": "relais",
                                      "dossiers": ds, "notion": res.get("notion") or {},
                                      "chiffre_du_jour": res.get("chiffre_du_jour") or {}}
                E.log("Comprendre préparé par le relais")
        except E.AIUnavailable as e:
            E.log(f"Pages du jour reportées : {e}")

    daily_done = any("préparé" in l or "Agenda :" in l for l in E.LOG)
    if not fresh and not skipped and not daily_done:
        last = E.parse_iso(((data.get("meta") or {}).get("relay") or {}).get("updated"))
        if last and last > now - timedelta(minutes=60):
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
