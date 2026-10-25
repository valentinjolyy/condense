#!/usr/bin/env python3
"""
Le Condensé : moteur de mise à jour.

Tourne toutes les 30 minutes sur GitHub Actions :
  1. lit les flux publics du Monde et du Figaro (titres, chapôs, liens) ;
  2. regroupe les articles par sujet et rédige les synthèses avec Gemini
     (offre gratuite de Google, avec recherche web pour vérifier les faits) ;
  3. produit chaque jour l'agenda, la revue de presse du matin et les
     dossiers « Comprendre » (international, économie) ;
  4. écrit les fichiers JSON lus par l'application (dossier data/).

Sans clé Gemini ou si le quota gratuit est épuisé, l'app reste alimentée
avec les titres et chapôs bruts : elle ne tombe jamais en panne.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import feedparser
import requests

PARIS = ZoneInfo("Europe/Paris")
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "Mozilla/5.0 (compatible; LeCondense/1.0; lecture personnelle de flux RSS)"

# ---------------------------------------------------------------------------
# Flux suivis. kind = live (actualité), analysis (idées, tribunes, éditos)
# ---------------------------------------------------------------------------
FEEDS = [
    # Le Monde
    ("Le Monde", "https://www.lemonde.fr/rss/une.xml", "Une", "live"),
    ("Le Monde", "https://www.lemonde.fr/rss/en_continu.xml", "En continu", "live"),
    ("Le Monde", "https://www.lemonde.fr/politique/rss_full.xml", "Politique", "live"),
    ("Le Monde", "https://www.lemonde.fr/international/rss_full.xml", "International", "live"),
    ("Le Monde", "https://www.lemonde.fr/economie/rss_full.xml", "Économie", "live"),
    ("Le Monde", "https://www.lemonde.fr/societe/rss_full.xml", "Société", "live"),
    ("Le Monde", "https://www.lemonde.fr/planete/rss_full.xml", "Planète", "live"),
    ("Le Monde", "https://www.lemonde.fr/idees/rss_full.xml", "Idées", "analysis"),
    # Le Figaro
    ("Le Figaro", "https://www.lefigaro.fr/rss/figaro_actualites.xml", "Une", "live"),
    ("Le Figaro", "https://www.lefigaro.fr/rss/figaro_flash-actu.xml", "Flash actu", "live"),
    ("Le Figaro", "https://www.lefigaro.fr/rss/figaro_politique.xml", "Politique", "live"),
    ("Le Figaro", "https://www.lefigaro.fr/rss/figaro_international.xml", "International", "live"),
    ("Le Figaro", "https://www.lefigaro.fr/rss/figaro_economie.xml", "Économie", "live"),
    ("Le Figaro", "https://www.lefigaro.fr/rss/figaro_actualite-france.xml", "France", "live"),
    ("Le Figaro", "https://www.lefigaro.fr/rss/figaro_vox.xml", "FigaroVox", "analysis"),
    # Source complémentaire pour le direct (dépêches AFP reprises par franceinfo)
    ("franceinfo", "https://www.francetvinfo.fr/titres.rss", "Titres", "live"),
]

CATEGORIES = ["Politique", "International", "Économie", "Société", "Justice",
              "Planète", "Culture", "Sciences & Tech", "Sport"]

ITEM_RETENTION_H = 72
STORY_RETENTION_H = 60
LIVE_WINDOW_H = 48
ANALYSIS_RETENTION_D = 7
MAX_ITEMS_PER_CALL = 45
MAX_CALLS_PER_RUN = 2

GEMINI_BASE = os.environ.get("GEMINI_BASE", "https://generativelanguage.googleapis.com/v1beta")
DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-flash-latest,gemini-flash-lite-latest"

LOG: list[str] = []


def log(msg: str) -> None:
    print(msg, flush=True)
    LOG.append(msg)


# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------
def now_utc() -> datetime:
    override = os.environ.get("CONDENSE_NOW")  # pour les tests
    if override:
        return datetime.fromisoformat(override).astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def clean_text(s: str | None, limit: int = 420) -> str:
    if not s:
        return ""
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > limit:
        s = s[: limit - 1].rsplit(" ", 1)[0] + "…"
    return s


def norm_url(u: str) -> str:
    p = urlsplit(u.strip())
    return urlunsplit((p.scheme or "https", p.netloc.lower(), p.path, "", ""))


def make_id(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:10]


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, obj, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":") if compact else None,
                     indent=None if compact else 1)
    path.write_text(txt, encoding="utf-8")


def fr_date(dt: datetime) -> str:
    jours = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
    mois = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
            "septembre", "octobre", "novembre", "décembre"]
    d = dt.astimezone(PARIS)
    return f"{jours[d.weekday()]} {d.day} {mois[d.month - 1]} {d.year}"


# ---------------------------------------------------------------------------
# Récupération de l'état précédent (publié sur GitHub Pages)
# ---------------------------------------------------------------------------
DATA_FILES = ["state", "live", "analyses", "revue", "agenda", "comprendre", "meta"]


def restore_previous(prev_url: str | None) -> None:
    if not prev_url:
        return
    base = prev_url.rstrip("/") + "/data/"
    for name in DATA_FILES:
        try:
            r = requests.get(base + name + ".json", timeout=20,
                             params={"t": int(time.time())})
            if r.ok and r.text.strip().startswith("{"):
                json.loads(r.text)
                (DATA / f"{name}.json").write_text(r.text, encoding="utf-8")
        except Exception as e:  # premier lancement : rien à récupérer
            log(f"(état précédent {name} indisponible : {e.__class__.__name__})")


# ---------------------------------------------------------------------------
# Flux RSS
# ---------------------------------------------------------------------------
def fetch_feeds() -> list[dict]:
    items: dict[str, dict] = {}
    for source, url, rubrique, kind in FEEDS:
        try:
            r = requests.get(url, headers={"User-Agent": UA}, timeout=25)
            r.raise_for_status()
            feed = feedparser.parse(r.content)
        except Exception as e:
            log(f"Flux en échec : {source} {rubrique} ({e.__class__.__name__})")
            continue
        n = 0
        for e in feed.entries:
            link = e.get("link")
            title = clean_text(e.get("title"), 300)
            if not link or not title:
                continue
            link = norm_url(link)
            pub = None
            for key in ("published_parsed", "updated_parsed"):
                if e.get(key):
                    pub = datetime(*e[key][:6], tzinfo=timezone.utc)
                    break
            iid = make_id(link)
            summary = clean_text(e.get("summary") or e.get("description"))
            if iid in items:
                # même article présent dans plusieurs flux
                it = items[iid]
                if kind == "analysis":
                    it["kind"] = "analysis"
                if rubrique not in it["rubriques"]:
                    it["rubriques"].append(rubrique)
                continue
            author = clean_text(e.get("author"), 80) if e.get("author") else ""
            items[iid] = {
                "id": iid, "source": source, "title": title, "summary": summary,
                "url": link, "published": iso(pub) if pub else None,
                "rubriques": [rubrique], "kind": kind, "author": author,
            }
            n += 1
        log(f"{source} / {rubrique} : {n} articles")
    return list(items.values())


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------
class AIUnavailable(Exception):
    pass


EXHAUSTED: set[str] = set()  # modèles dont le quota est épuisé pendant ce passage


def extract_json(text: str):
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    start = min([i for i in (t.find("{"), t.find("[")) if i >= 0], default=-1)
    if start < 0:
        raise ValueError("pas de JSON dans la réponse")
    end = max(t.rfind("}"), t.rfind("]"))
    t = t[start:end + 1]
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        t2 = re.sub(r",\s*([}\]])", r"\1", t)  # virgules finales
        return json.loads(t2)


SYSTEM = """Tu es le rédacteur en chef d'une revue de presse quotidienne destinée à un lecteur expert :
un collaborateur parlementaire, juriste en droit public, qui suit déjà intensément l'actualité.
Ton travail : condenser l'actualité du Monde et du Figaro sans jamais sacrifier la précision.

Règles absolues :
- Exactitude d'abord. Chaque fait vient des articles fournis ou de ta recherche web. Tu n'inventes
  jamais un chiffre, un nom, une citation, une date. Si une information n'est pas confirmée,
  attribue-la (« selon le parquet », « d'après Le Figaro ») ou ne la donne pas.
- Précision maximale : noms complets et fonctions, chiffres exacts (bilans, montants, pourcentages,
  résultats de vote), lieux, dates, institutions, références de textes de loi.
- Niveau expert : pas de pédagogie pour débutant, pas de remplissage, pas de formules creuses
  (« il convient de noter », « dans un contexte de »). Phrases nettes, informatives.
- Neutralité : distingue faits, analyses et opinions. Quand Le Monde et Le Figaro divergent
  (angle, faits, ton), signale-le.
- Français impeccable. N'utilise jamais le tiret cadratin ni le tiret demi-cadratin comme
  ponctuation : utilise virgules, deux-points ou parenthèses.
- Réponds uniquement avec du JSON valide, sans texte autour."""


def _gemini_once(model: str, key: str, prompt: str, search: bool, advanced: bool,
                 max_tokens: int):
    """Retourne (statut, résultat). statut : ok | retry_simple | next_model."""
    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.25, "maxOutputTokens": max_tokens},
    }
    if search and advanced:
        body["tools"] = [{"google_search": {}}]
    elif advanced:
        body["generationConfig"]["responseMimeType"] = "application/json"
    if advanced and "2.5" in model:
        body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": 2048}
    err = ""
    for attempt in range(3):
        try:
            r = requests.post(f"{GEMINI_BASE}/models/{model}:generateContent",
                              headers={"x-goog-api-key": key}, json=body, timeout=300)
        except requests.RequestException as e:
            err = f"{model}: {e.__class__.__name__}"
            time.sleep(8)
            continue
        if r.status_code == 429:
            err = f"{model}: quota atteint (429)"
            if attempt >= 1:
                EXHAUSTED.add(model)
                return "next_model", err
            time.sleep(20)
            continue
        if r.status_code >= 500:
            err = f"{model}: HTTP {r.status_code}"
            time.sleep(15 * (attempt + 1))
            continue
        if r.status_code == 400:
            return ("retry_simple" if advanced else "next_model"), f"{model}: 400 {r.text[:300]}"
        if not r.ok:
            return "next_model", f"{model}: HTTP {r.status_code} {r.text[:200]}"
        try:
            parts = r.json()["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
            return "ok", extract_json(text)
        except Exception as e:
            err = f"{model}: réponse illisible ({str(e)[:120]})"
            time.sleep(3)
    return "next_model", err


def gemini(prompt: str, search: bool = False, max_tokens: int = 24000) -> dict:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise AIUnavailable("pas de clé GEMINI_API_KEY")
    if os.environ.get("CONDENSE_FAKE_AI"):
        sys.path.insert(0, str(Path(__file__).parent))
        from fake_ai import fake_answer  # tests hors ligne
        os.environ["CONDENSE_LAST_MODEL"] = "simulation"
        return fake_answer(prompt)
    models = [m.strip() for m in (os.environ.get("GEMINI_MODELS") or DEFAULT_MODELS).split(",") if m.strip()]
    errors = []
    for model in [m for m in models if m not in EXHAUSTED]:
        for advanced in (True, False):
            status, res = _gemini_once(model, key, prompt, search, advanced, max_tokens)
            if status == "ok":
                log(f"IA : {model} ({'avec' if search else 'sans'} recherche web)")
                os.environ["CONDENSE_LAST_MODEL"] = model
                return res
            errors.append(res)
            if status == "next_model":
                break
    raise AIUnavailable(" / ".join(errors)[-600:] or "aucun modèle disponible")


# ---------------------------------------------------------------------------
# Direct : regroupement des nouveaux articles en sujets
# ---------------------------------------------------------------------------
def item_line(it: dict) -> str:
    when = ""
    if it.get("published"):
        when = parse_iso(it["published"]).astimezone(PARIS).strftime("%d/%m %Hh%M")
    tag = " [rubrique idées/opinion]" if it["kind"] == "analysis" else ""
    auteur = f" | auteur: {it['author']}" if it.get("author") else ""
    return (f"- id={it['id']} | {it['source']} | {'/'.join(it['rubriques'])}{tag} | {when}{auteur}\n"
            f"  TITRE: {it['title']}\n  CHAPÔ: {it['summary'] or '(aucun)'}")


LIVE_PROMPT = """Nous sommes le {date}, il est {heure} à Paris.

SUJETS DÉJÀ SUIVIS (dernières 36 h) :
{stories}

NOUVEAUX ARTICLES À TRAITER :
{items}

Tâche. Pour CHAQUE nouvel article, décide :
- "story": rattacher à un sujet existant (son id) ou à un nouveau sujet ("new1", "new2"...).
  UN SEUL sujet par événement : toutes les dépêches, suites, réactions, directs et bilans d'un même
  événement (une mobilisation, un procès, une crise, un scrutin, un attentat) vont dans le même sujet,
  existant de préférence. Ne crée jamais deux sujets pour le même événement.
- "analyse": c'est une tribune, un éditorial, une chronique, une analyse, un décryptage, un entretien
  d'opinion (tous les articles des rubriques idées/opinion en font partie).
- "skip": tout ce qui ne relève pas de l'actualité politique, internationale, économique, sociale
  d'intérêt général, judiciaire majeure, environnementale ou scientifique. Donc skip : sport (résultats,
  matchs, transferts, compétitions, sauf enjeu politique ou économique national), people, divertissement,
  séries, programmes TV, mode, gastronomie, voyages, consommation, bons plans, jeux, horoscope,
  faits divers sans portée nationale, pages de services.

Pour chaque NOUVEAU sujet, et pour chaque sujet EXISTANT qui reçoit des informations nouvelles
(nouveau bilan, rebondissement, réaction majeure), rédige la fiche complète. Utilise la recherche
web pour vérifier et compléter les faits clés (bilan, chiffres, noms, votes).

- "titre": 4 à 9 mots, style titre de presse (affiché seulement dans la fiche).
- "phrase": c'est ce que le lecteur voit dans le fil : UNE phrase autonome qui donne l'information complète, avec les faits précis
  (qui, quoi, où, combien). Exemple de niveau attendu : « Une fusillade à Trappes (Yvelines) a fait
  3 morts et 2 blessés graves dans la nuit de lundi à mardi ; le suspect, un homme de 24 ans, a été
  interpellé et le parquet de Versailles a ouvert une enquête pour assassinats. »
- "faits": 2 à 4 phrases qui AJOUTENT des faits absents de "phrase" (ne répète jamais "phrase").
- "contexte": 2 à 4 phrases : ce qui a précédé, le cadre (juridique, politique, diplomatique).
- "enjeux": 1 à 3 phrases : pourquoi c'est important, conséquences possibles, lignes de clivage.
- "chiffres": 0 à 4 objets {{"valeur": "3", "libelle": "morts"}} (seulement des chiffres sûrs).
- "a_suivre": une phrase sur la prochaine étape attendue (ou "").
- "angles": si Le Monde et Le Figaro traitent le sujet différemment, une phrase qui le dit, sinon "".
- "categorie": une parmi {categories}.
- "importance": 1 à 5 (5 = événement majeur, une des deux journaux ; 4 = important pour un acteur
  politique ; 3 = notable ; 2 = secondaire ; 1 = anecdotique). Sois sévère : seuls les sujets 3 à 5
  sont affichés, et une journée normale ne compte qu'une quinzaine de sujets 3 ou plus.
- "lieu": pays ou ville principale (ou "").
- "maj": pour un sujet EXISTANT qui reçoit du nouveau, UNE phrase qui dit seulement ce qui est nouveau
  (nouveau bilan, décision, réaction) ; "" pour un nouveau sujet.

Pour chaque article "analyse", donne : "type" (Tribune, Éditorial, Chronique, Analyse, Décryptage,
Entretien, Enquête), "auteur" (nom et qualité si connus, sinon ""), "these" (UNE phrase : la thèse
défendue ou l'apport de l'article), "theme" (2 à 4 mots).

Réponds avec ce JSON exact :
{{
 "assign": [{{"item": "id_article", "decision": "story", "story": "id_sujet_ou_newN"}},
            {{"item": "id_article", "decision": "analyse"}}, {{"item": "id_article", "decision": "skip"}}],
 "stories": [{{"id": "id_existant_ou_newN", "titre": "", "phrase": "", "faits": "", "contexte": "",
              "enjeux": "", "chiffres": [], "a_suivre": "", "angles": "", "categorie": "",
              "importance": 3, "lieu": "", "maj": ""}}],
 "analyses": [{{"item": "id_article", "type": "", "auteur": "", "these": "", "theme": ""}}]
}}"""


def story_brief(s: dict) -> str:
    return f"- id={s['id']} | {s.get('categorie','')} | {s['titre']} :: {s['phrase']}"


def process_live(state: dict, new_items: list[dict], ai_ok: bool) -> bool:
    """Rattache les nouveaux articles aux sujets. Retourne False si l'IA a échoué."""
    now = now_utc()
    stories: dict[str, dict] = state.setdefault("stories", {})
    analyses: dict[str, dict] = state.setdefault("analyses", {})
    pending = sorted(new_items, key=lambda i: i.get("published") or "")

    calls = 0
    while pending and ai_ok and calls < MAX_CALLS_PER_RUN:
        batch, pending = pending[-MAX_ITEMS_PER_CALL:], pending[:-MAX_ITEMS_PER_CALL]
        recent = [s for s in stories.values()
                  if parse_iso(s["updated"]) > now - timedelta(hours=36)]
        recent.sort(key=lambda s: s["updated"], reverse=True)
        prompt = LIVE_PROMPT.format(
            date=fr_date(now), heure=now.astimezone(PARIS).strftime("%Hh%M"),
            stories="\n".join(story_brief(s) for s in recent[:120]) or "(aucun)",
            items="\n".join(item_line(i) for i in batch),
            categories=", ".join(CATEGORIES),
        )
        try:
            res = gemini(prompt, search=True)
            calls += 1
        except AIUnavailable as e:
            log(f"IA indisponible pour le direct : {e}")
            pending = pending + batch
            ai_ok = False
            break
        apply_live_result(state, batch, res, now)

    # Ce qui n'a pas pu être traité par l'IA : affichage brut, regroupé simplement
    leftovers = pending
    if leftovers and not ai_ok:
        fallback_group(state, leftovers, now)
    elif leftovers:
        # backlog trop important (premier lancement) : on garde les plus récents en brut
        fallback_group(state, leftovers[-30:], now)
    return ai_ok


def apply_live_result(state: dict, batch: list[dict], res: dict, now: datetime) -> None:
    stories = state["stories"]
    analyses = state["analyses"]
    by_id = {i["id"]: i for i in batch}
    fiche = {s.get("id"): s for s in res.get("stories", []) if isinstance(s, dict)}
    new_map: dict[str, str] = {}
    handled = set()

    for a in res.get("assign", []):
        iid = a.get("item")
        it = by_id.get(iid)
        if not it:
            continue
        handled.add(iid)
        dec = a.get("decision")
        if dec == "skip":
            continue
        if dec == "analyse":
            analyses[iid] = {"item": iid, "type": "Analyse", "auteur": it.get("author", ""),
                             "these": it["summary"], "theme": "", "added": iso(now)}
            continue
        sid = str(a.get("story") or "")
        if sid not in stories:
            if sid not in new_map:
                new_map[sid] = make_id("story", iid, iso(now))
            real = new_map[sid]
            if real not in stories:
                stories[real] = {"id": real, "created": iso(now), "updated": iso(now),
                                 "items": [], "titre": it["title"], "phrase": it["title"],
                                 "faits": it["summary"], "contexte": "", "enjeux": "",
                                 "chiffres": [], "a_suivre": "", "angles": "",
                                 "categorie": "Société", "importance": 2, "lieu": "", "ai": True}
            sid = real
        st = stories[sid]
        if iid not in st["items"]:
            st["items"].append(iid)
        st["updated"] = iso(now)

    for a in res.get("analyses", []):
        iid = a.get("item")
        if iid in by_id:
            it = by_id[iid]
            analyses[iid] = {
                "item": iid, "type": a.get("type") or "Analyse",
                "auteur": a.get("auteur") or it.get("author", ""),
                "these": a.get("these") or it["summary"], "theme": a.get("theme", ""),
                "added": iso(now),
            }
            handled.add(iid)

    for key, f in fiche.items():
        sid = new_map.get(key, key)
        st = stories.get(sid)
        if not st:
            continue
        for field in ("titre", "phrase", "faits", "contexte", "enjeux", "a_suivre", "angles", "lieu"):
            if isinstance(f.get(field), str) and f[field].strip():
                st[field] = f[field].strip()
        if isinstance(f.get("chiffres"), list):
            st["chiffres"] = [c for c in f["chiffres"] if isinstance(c, dict) and c.get("valeur")][:4]
        if f.get("categorie") in CATEGORIES:
            st["categorie"] = f["categorie"]
        try:
            st["importance"] = max(1, min(5, int(f.get("importance", st["importance"]))))
        except (TypeError, ValueError):
            pass
        st["updated"] = iso(now)
        st["ai"] = True

    # Articles oubliés par l'IA : idées -> analyses, le reste en brut
    forgotten = [by_id[i] for i in by_id if i not in handled]
    for it in forgotten:
        if it["kind"] == "analysis":
            analyses[it["id"]] = {"item": it["id"], "type": "Tribune", "auteur": it.get("author", ""),
                                  "these": it["summary"], "theme": "", "added": iso(now)}
    rest = [i for i in forgotten if i["kind"] != "analysis"]
    if rest:
        fallback_group(state, rest, now)


WORD = re.compile(r"[a-zàâçéèêëîïôûùüÿœ0-9]{4,}", re.I)
STOP = {"pour", "dans", "avec", "sans", "plus", "après", "avant", "contre", "entre", "leur",
        "leurs", "cette", "selon", "sont", "être", "fait", "comme", "mais", "nous", "vous",
        "elle", "elles", "tout", "tous", "quoi", "quand", "depuis", "sous", "vers", "chez",
        "direct", "info", "infos", "ce qu"}


def words(s: str) -> set[str]:
    return {w.lower() for w in WORD.findall(s)} - STOP


def fallback_group(state: dict, items: list[dict], now: datetime) -> None:
    """Sans IA : un sujet par article, fusion simple des titres très proches."""
    stories = state["stories"]
    analyses = state["analyses"]
    for it in items:
        if it["kind"] == "analysis":
            analyses[it["id"]] = {"item": it["id"], "type": "Tribune", "auteur": it.get("author", ""),
                                  "these": it["summary"], "theme": "", "added": iso(now)}
            continue
        w = words(it["title"])
        target = None
        for st in stories.values():
            if st.get("ai") or parse_iso(st["updated"]) < now - timedelta(hours=24):
                continue
            ow = words(st["titre"])
            if w and ow and len(w & ow) / max(1, min(len(w), len(ow))) >= 0.6:
                target = st
                break
        if target:
            if it["id"] not in target["items"]:
                target["items"].append(it["id"])
            target["updated"] = iso(now)
            continue
        sid = make_id("raw", it["id"])
        stories[sid] = {"id": sid, "created": iso(now), "updated": iso(now), "items": [it["id"]],
                        "titre": it["title"], "phrase": it["summary"] or it["title"],
                        "faits": it["summary"], "contexte": "", "enjeux": "", "chiffres": [],
                        "a_suivre": "", "angles": "", "categorie": guess_cat(it), "importance": 2,
                        "lieu": "", "ai": False}


def guess_cat(it: dict) -> str:
    r = " ".join(it["rubriques"]).lower()
    for key, cat in (("politique", "Politique"), ("international", "International"),
                     ("économie", "Économie"), ("planète", "Planète"), ("société", "Société"),
                     ("france", "Société")):
        if key in r:
            return cat
    return "Société"


# ---------------------------------------------------------------------------
# Tâches quotidiennes
# ---------------------------------------------------------------------------
AGENDA_PROMPT = """Nous sommes le {date}. Établis l'agenda du jour pour un collaborateur parlementaire
(député Les Républicains de la Loire) qui veut savoir, en un coup d'œil, si un événement important
est PRÉVU aujourd'hui. Fais des recherches web ciblées : agenda du président de la République et
du Premier ministre, ordre du jour de l'Assemblée nationale et du Sénat (séance publique, questions
au gouvernement, votes solennels, commissions notables, textes budgétaires), Conseil des ministres,
déplacements et voyages officiels, sommets et rencontres internationales, élections à l'étranger,
réunions des banques centrales, publications statistiques majeures (Insee, emploi, inflation),
décisions de justice ou du Conseil constitutionnel attendues, grèves et manifestations nationales,
grands événements culturels et sportifs. Inspire-toi de ce que serait l'agenda AFP, mais TRIE
sévèrement : garde ce qui compte vraiment (en général 4 à 10 événements).

Titres récents des journaux (pour repérer ce qui est annoncé) :
{titles}

Ne retiens que des événements confirmés par une source. Pas d'invention d'horaires : "heure"
vaut "" si l'horaire n'est pas connu.

JSON attendu :
{{
 "evenements": [{{"heure": "15h00", "titre": "", "detail": "une phrase précise : qui, quoi, où",
                 "pourquoi": "une phrase : l'enjeu", "categorie": "Exécutif|Parlement|International|Économie|Justice|Société|Culture & Sport",
                 "importance": 1}}],
 "semaine": [{{"jour": "mardi 28 octobre", "titre": "", "pourquoi": ""}}]
}}
"importance" : 3 = majeur, 2 = important, 1 = à noter. "semaine" : 3 à 6 temps forts des 7 prochains jours."""


REVUE_PROMPT = """Nous sommes le {date}, {heure}. Prépare la revue de presse du matin : le sommaire de
l'actualité traitée par Le Monde et Le Figaro sur les dernières 24 heures, comme si le lecteur
n'ouvrait pas les journaux.

ARTICLES (Le Monde, Le Figaro, franceinfo) :
{items}

Consignes :
- "essentiel" : liste de 4 à 6 objets {{"titre": "titre de l'actualité", "texte": "1 à 2 phrases précises"}},
  ce qu'il faut absolument savoir ce matin, sans sport ni divertissement.
- Organise en rubriques dans cet ordre si elles ont du contenu : France, International, Économie,
  Société, Planète, Sciences, Idées. Pas de rubrique Sport ni divertissement.
- Dans chaque rubrique, "sujets" = les sujets principaux (regroupe les articles des deux journaux
  sur un même sujet). Pour chacun :
  "titre" (titre de presse), "resume" (2 à 3 phrases, affiché sous le titre), "synthese" (5 à 8 phrases denses : faits, chiffres, acteurs, contexte ;
  vérifie avec la recherche web), "monde" (une phrase : ce que Le Monde apporte ou son angle, "" s'il
  ne traite pas le sujet), "figaro" (idem pour Le Figaro), "items" (ids de TOUS les articles liés).
- "breves" = les petits articles restants de la rubrique, une phrase informative chacun, avec "items".
- Chaque article informatif doit apparaître quelque part (sujet ou brève), y compris les petits
  articles. Ignore seulement les contenus de service (jeux, recettes, bons plans).

JSON attendu :
{{
 "essentiel": [{{"titre": "", "texte": ""}}],
 "rubriques": [{{"nom": "France", "sujets": [{{"titre": "", "resume": "", "synthese": "", "monde": "", "figaro": "", "items": []}}],
                "breves": [{{"titre": "", "phrase": "", "items": []}}]}}]
}}"""


COMPRENDRE_PROMPT = """Nous sommes le {date}. Le lecteur maîtrise la politique française mais veut
progresser sérieusement en actualité INTERNATIONALE et ÉCONOMIQUE, au niveau d'un concours de la haute
fonction publique. Choisis dans l'actualité ci-dessous 4 dossiers : 2 internationaux, 2 économiques,
parmi les plus structurants (pas forcément les plus spectaculaires). Utilise la recherche web pour
des chiffres exacts et à jour.

Articles récents :
{items}

Pour chaque dossier :
- "domaine": "International" ou "Économie"
- "titre": titre clair
- "en_bref": une phrase qui résume la situation
- "situation": 3 à 5 phrases : où en est-on aujourd'hui, précisément
- "pourquoi": 2 à 4 phrases : pourquoi c'est structurant (intérêts, rapports de force, effets
  pour la France et l'Europe)
- "historique": 2 à 4 phrases : les dates et étapes clés qui y ont mené
- "acteurs": 2 à 5 objets {{"nom": "", "role": ""}}
- "chiffres": 2 à 4 objets {{"valeur": "", "libelle": ""}} (sourcés, récents)
- "positions": 1 à 3 phrases : les grandes lignes de débat (qui défend quoi)
- "a_surveiller": une phrase : la prochaine échéance
- "items": ids des articles liés

Ajoute "notion": une notion économique ou de relations internationales utile pour comprendre
l'actualité du jour : {{"terme": "", "definition": "3 phrases précises", "exemple": "lien avec l'actualité"}}.
Ajoute "chiffre_du_jour": {{"valeur": "", "libelle": "", "explication": "une phrase"}}.

JSON attendu : {{"dossiers": [...], "notion": {{}}, "chiffre_du_jour": {{}}}}"""


def recent_items(state: dict, hours: int, kinds=("live",), limit: int = 260,
                 rubriques: tuple[str, ...] | None = None) -> list[dict]:
    now = now_utc()
    out = []
    for it in state["items"].values():
        p = parse_iso(it.get("published")) or parse_iso(it.get("seen"))
        if not p or p < now - timedelta(hours=hours):
            continue
        if it["kind"] not in kinds:
            continue
        if rubriques and not any(r in rubriques for r in it["rubriques"]):
            continue
        out.append(it)
    out.sort(key=lambda i: i.get("published") or "", reverse=True)
    return out[:limit]


def short_line(it: dict, with_summary: bool = True) -> str:
    s = f"- id={it['id']} | {it['source']} | {'/'.join(it['rubriques'])} | {it['title']}"
    if with_summary and it.get("summary"):
        s += f" :: {it['summary'][:260]}"
    return s


def task_agenda(state: dict, out: dict, force: bool) -> None:
    now = now_utc()
    paris = now.astimezone(PARIS)
    today = paris.date().isoformat()
    agenda = out["agenda"]
    due = agenda.get("date") != today and paris.hour >= 5
    refresh = (agenda.get("date") == today and paris.hour >= 12 and not agenda.get("midi"))
    if not (due or refresh or force):
        return
    titles = "\n".join(short_line(i, False) for i in recent_items(state, 30, limit=150))
    try:
        res = gemini(AGENDA_PROMPT.format(date=fr_date(now), titles=titles), search=True, max_tokens=12000)
    except AIUnavailable as e:
        log(f"Agenda non mis à jour : {e}")
        return
    evts = [e for e in res.get("evenements", []) if isinstance(e, dict) and e.get("titre")]
    evts.sort(key=lambda e: (e.get("heure") or "99"))
    out["agenda"] = {"date": today, "label": fr_date(now), "updated": iso(now),
                     "midi": paris.hour >= 12, "evenements": evts,
                     "semaine": [s for s in res.get("semaine", []) if isinstance(s, dict)]}
    log(f"Agenda : {len(evts)} événements")


def task_revue(state: dict, out: dict, force: bool) -> None:
    now = now_utc()
    paris = now.astimezone(PARIS)
    today = paris.date().isoformat()
    revue = out["revue"]
    if not force and (revue.get("date") == today or paris.hour < 6):
        return
    items = [i for i in recent_items(state, 24, limit=220) if i["source"] in ("Le Monde", "Le Figaro")]
    if len(items) < (3 if force else 10):
        log("Revue : pas assez d'articles pour l'instant")
        return
    try:
        res = gemini(REVUE_PROMPT.format(date=fr_date(now), heure=paris.strftime("%Hh%M"),
                                         items="\n".join(short_line(i) for i in items)),
                     search=True, max_tokens=40000)
    except AIUnavailable as e:
        log(f"Revue non générée : {e}")
        return
    rubs = []
    for r in res.get("rubriques", []):
        if not isinstance(r, dict):
            continue
        sujets = [s for s in r.get("sujets", []) if isinstance(s, dict) and s.get("titre")]
        breves = [b for b in r.get("breves", []) if isinstance(b, dict) and (b.get("titre") or b.get("phrase"))]
        for s in sujets + breves:
            s["liens"] = resolve(state, s.get("items", []))
            s.pop("items", None)
        if sujets or breves:
            rubs.append({"nom": r.get("nom", ""), "sujets": sujets, "breves": breves})
    out["revue"] = {"date": today, "label": fr_date(now), "updated": iso(now),
                    "essentiel": res.get("essentiel", ""), "rubriques": rubs}
    log(f"Revue : {sum(len(r['sujets']) for r in rubs)} sujets")


def task_comprendre(state: dict, out: dict, force: bool) -> None:
    now = now_utc()
    paris = now.astimezone(PARIS)
    today = paris.date().isoformat()
    if not force and (out["comprendre"].get("date") == today or paris.hour < 7):
        return
    items = recent_items(state, 48, limit=200,
                         rubriques=("International", "Économie", "Une", "Planète"))
    if len(items) < (3 if force else 8):
        return
    try:
        res = gemini(COMPRENDRE_PROMPT.format(date=fr_date(now),
                                              items="\n".join(short_line(i) for i in items)),
                     search=True, max_tokens=24000)
    except AIUnavailable as e:
        log(f"Comprendre non généré : {e}")
        return
    dossiers = [d for d in res.get("dossiers", []) if isinstance(d, dict) and d.get("titre")]
    for d in dossiers:
        d["liens"] = resolve(state, d.get("items", []))
        d.pop("items", None)
    out["comprendre"] = {"date": today, "label": fr_date(now), "updated": iso(now),
                         "dossiers": dossiers, "notion": res.get("notion") or {},
                         "chiffre_du_jour": res.get("chiffre_du_jour") or {}}
    log(f"Comprendre : {len(dossiers)} dossiers")


def resolve(state: dict, ids) -> list[dict]:
    out, seen = [], set()
    for iid in ids or []:
        it = state["items"].get(str(iid))
        if it and it["url"] not in seen:
            seen.add(it["url"])
            out.append({"source": it["source"], "titre": it["title"], "url": it["url"],
                        "date": it.get("published")})
    return out


# ---------------------------------------------------------------------------
# Écriture des fichiers de l'application
# ---------------------------------------------------------------------------
def build_outputs(state: dict, out: dict, ai_ok: bool) -> None:
    now = now_utc()
    # Direct
    live = []
    for st in state["stories"].values():
        if parse_iso(st["updated"]) < now - timedelta(hours=LIVE_WINDOW_H):
            continue
        liens = resolve(state, st["items"])
        if not liens:
            continue
        dates = [parse_iso(l["date"]) for l in liens if l.get("date")]
        first = min(dates) if dates else parse_iso(st["created"])
        last = max(dates) if dates else parse_iso(st["updated"])
        live.append({**{k: st[k] for k in ("id", "titre", "phrase", "faits", "contexte", "enjeux",
                                            "chiffres", "a_suivre", "angles", "categorie",
                                            "importance", "lieu", "ai")},
                     "created": st["created"], "updated": st["updated"],
                     "first": iso(first), "last": iso(last), "liens": liens})
    live.sort(key=lambda s: s["last"], reverse=True)
    save_json(DATA / "live.json", {"updated": iso(now), "stories": live}, compact=True)

    # Analyses
    ana = []
    for a in state["analyses"].values():
        it = state["items"].get(a["item"])
        if not it:
            continue
        ana.append({"id": a["item"], "source": it["source"], "titre": it["title"], "url": it["url"],
                    "date": it.get("published") or a["added"], "type": a.get("type", "Analyse"),
                    "auteur": a.get("auteur", ""), "these": a.get("these", ""),
                    "theme": a.get("theme", ""), "chapo": it.get("summary", "")})
    ana.sort(key=lambda a: a["date"] or "", reverse=True)
    save_json(DATA / "analyses.json", {"updated": iso(now), "items": ana}, compact=True)

    for name in ("agenda", "revue", "comprendre"):
        save_json(DATA / f"{name}.json", out[name], compact=True)

    meta = {"updated": iso(now), "ai": ai_ok, "model": os.environ.get("CONDENSE_LAST_MODEL", ""),
            "log": LOG[-40:]}
    save_json(DATA / "meta.json", meta)


def prune(state: dict) -> None:
    now = now_utc()
    keep_items = now - timedelta(hours=ITEM_RETENTION_H)
    stories = state["stories"]
    for sid in list(stories):
        if parse_iso(stories[sid]["updated"]) < now - timedelta(hours=STORY_RETENTION_H):
            del stories[sid]
    for aid in list(state["analyses"]):
        if parse_iso(state["analyses"][aid]["added"]) < now - timedelta(days=ANALYSIS_RETENTION_D):
            del state["analyses"][aid]
    needed = {i for s in stories.values() for i in s["items"]} | set(state["analyses"])
    for iid in list(state["items"]):
        it = state["items"][iid]
        t = parse_iso(it.get("published")) or parse_iso(it.get("seen"))
        if iid not in needed and (not t or t < keep_items):
            del state["items"][iid]


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev-url", default=os.environ.get("PREV_URL"))
    ap.add_argument("--force", default="", help="agenda,revue,comprendre")
    ap.add_argument("--offline-items", help="fichier JSON d'articles (tests)")
    args = ap.parse_args()
    force = set(filter(None, args.force.split(",")))

    DATA.mkdir(exist_ok=True)
    restore_previous(args.prev_url)
    state = load_json(DATA / "state.json", {})
    state.setdefault("items", {})
    state.setdefault("stories", {})
    state.setdefault("analyses", {})
    out = {n: load_json(DATA / f"{n}.json", {}) for n in ("agenda", "revue", "comprendre")}
    now = now_utc()
    first_run = not state["items"]

    fetched = (json.loads(Path(args.offline_items).read_text()) if args.offline_items
               else fetch_feeds())
    new = []
    for it in fetched:
        if it["id"] in state["items"]:
            continue
        it["seen"] = iso(now)
        pub = parse_iso(it.get("published"))
        if pub and pub > now + timedelta(hours=1):
            it["published"] = iso(now)
            pub = now
        state["items"][it["id"]] = it
        if pub and pub < now - timedelta(hours=18 if first_run else 36):
            continue  # trop ancien pour le direct, mais gardé pour la revue
        new.append(it)
    log(f"{len(fetched)} articles lus, {len(new)} nouveaux")

    ai_ok = bool(os.environ.get("GEMINI_API_KEY"))
    if new:
        ai_ok = process_live(state, new, ai_ok)

    if ai_ok:
        for task in (task_agenda, task_revue, task_comprendre):
            try:
                task(state, out, force=task.__name__.split("_")[1] in force)
            except Exception as e:  # une tâche ne doit jamais bloquer les autres
                log(f"Erreur {task.__name__} : {e}")

    prune(state)
    save_json(DATA / "state.json", state, compact=True)
    build_outputs(state, out, ai_ok)
    log("Terminé.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
