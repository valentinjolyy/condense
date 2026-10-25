#!/usr/bin/env python3
"""
Le Condensé : lecture / écriture des données chiffrées sur GitHub.

Utilisé par la tâche horaire de Claude :
  python3 store.py pull etat.json   # télécharge data/bundle.json et le déchiffre
  python3 store.py push etat.json   # chiffre etat.json et le publie (un commit)
  python3 store.py encrypt etat.json bundle.json   # chiffrement seul
  python3 store.py decrypt bundle.json etat.json   # déchiffrement seul

Variables d'environnement : CONDENSE_REPO (ex. valentin/condense),
CONDENSE_TOKEN (jeton GitHub limité à ce dépôt), CONDENSE_PASS (phrase secrète).

Format : PBKDF2-HMAC-SHA256 (250 000 itérations) -> AES-256-GCM sur le JSON gzippé.
Le site est public mais les données sont illisibles sans la phrase secrète.
"""
import base64, gzip, json, os, sys, time, urllib.request, urllib.error

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITER = 250_000
PATH = "data/bundle.json"
EMPTY = {"stories": [], "analyses": [], "agenda": {}, "revue": {}, "comprendre": {}, "meta": {}, "seen": [], "deleted": []}


def key(passphrase: str, salt: bytes) -> bytes:
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(passphrase.encode())


def encrypt(obj, passphrase: str) -> dict:
    salt, iv = os.urandom(16), os.urandom(12)
    raw = gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode())
    ct = AESGCM(key(passphrase, salt)).encrypt(iv, raw, None)
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "salt": b(salt), "iv": b(iv), "ct": b(ct)}


def decrypt(bundle: dict, passphrase: str):
    d = lambda k: base64.b64decode(bundle[k])
    raw = AESGCM(key(passphrase, d("salt"))).decrypt(d("iv"), d("ct"), None)
    return json.loads(gzip.decompress(raw))


def _t(s):
    return s or ""


def merge(local: dict, remote: dict) -> dict:
    """Fusionne deux états (Mac de Claude / relais GitHub) sans perdre de travail."""
    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)
    lim_s = (now - timedelta(hours=48)).strftime("%Y-%m-%dT%H:%M:%SZ")
    lim_a = (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = dict(remote)
    out.update({k: v for k, v in local.items() if k not in ("stories", "analyses", "seen", "meta", "agenda", "revue", "comprendre", "journal", "deleted", "plusloin", "seen_pl", "plusloin_editions")})
    # Journal : le plus récent ; édition par édition
    jl, jr = local.get("journal") or {}, remote.get("journal") or {}
    if jl or jr:
        newer, older = (jl, jr) if _t(jl.get("updated")) >= _t(jr.get("updated")) else (jr, jl)
        eds = dict(older.get("editions") or {})
        eds.update(newer.get("editions") or {})
        out["journal"] = {**older, **newer, "editions": eds}
    # Sujets : priorité à la fiche rédigée à partir des articles complets, sinon la plus récente
    by = {}
    for s in remote.get("stories", []) + local.get("stories", []):
        sid = s.get("id")
        if not sid:
            continue
        o = by.get(sid)
        if o is None:
            by[sid] = s
            continue
        best = max((o, s), key=lambda x: (bool(x.get("complet")), _t(x.get("last")), len(_t(x.get("faits")))))
        other = s if best is o else o
        urls = {l.get("url") for l in best.get("liens", [])}
        liens = list(best.get("liens", [])) + [l for l in other.get("liens", []) if l.get("url") not in urls]
        best = dict(best, liens=liens, last=max(_t(o.get("last")), _t(s.get("last"))))
        by[sid] = best
    deleted = list(dict.fromkeys(list(remote.get("deleted", [])) + list(local.get("deleted", []))))[-3000:]
    out["deleted"] = deleted
    dset = set(deleted)
    out["stories"] = sorted([s for s in by.values() if _t(s.get("last")) >= lim_s and s.get("id") not in dset], key=lambda s: _t(s.get("last")), reverse=True)
    ana = {}
    for a in remote.get("analyses", []) + local.get("analyses", []):
        if a.get("id"):
            o = ana.get(a["id"])
            ana[a["id"]] = a if o is None or len(_t(a.get("these"))) >= len(_t(o.get("these"))) else o
    out["analyses"] = sorted([a for a in ana.values() if _t(a.get("date")) >= lim_a and a.get("id") not in dset], key=lambda a: _t(a.get("date")), reverse=True)
    seen = list(dict.fromkeys(list(remote.get("seen", [])) + list(local.get("seen", []))))
    out["seen"] = seen[-1500:]
    # Pour aller plus loin : union par id, 8 jours
    lim_p = (now - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")
    pls = {}
    for a in remote.get("plusloin", []) + local.get("plusloin", []):
        if a.get("id"):
            pls[a["id"]] = a
    out["plusloin"] = sorted([a for a in pls.values() if _t(a.get("date")) >= lim_p and a.get("id") not in dset], key=lambda a: _t(a.get("date")), reverse=True)[:300]
    out["seen_pl"] = list(dict.fromkeys(list(remote.get("seen_pl", [])) + list(local.get("seen_pl", []))))[-3000:]
    # Éditions hebdomadaires (La Tribune Dimanche…) : la plus récente par titre
    ple = dict(remote.get("plusloin_editions") or {})
    for k, v in (local.get("plusloin_editions") or {}).items():
        if _t(v.get("updated")) >= _t((ple.get(k) or {}).get("updated")):
            ple[k] = v
    out["plusloin_editions"] = ple
    # Pages du jour : la plus récente ; à date égale, celle de Claude plutôt que celle du relais
    for k in ("agenda", "revue", "comprendre"):
        cands = [x for x in (remote.get(k) or {}, local.get(k) or {}) if x]
        out[k] = max(cands, key=lambda x: (_t(x.get("date")), x.get("par") != "relais", _t(x.get("updated")))) if cands else {}
    rm, lm = remote.get("meta") or {}, local.get("meta") or {}
    meta = {**rm, **lm}
    rel = [m.get("relay") for m in (rm, lm) if m.get("relay")]
    if rel:
        meta["relay"] = max(rel, key=lambda r: _t(r.get("updated")))
    claude = [m for m in (rm, lm) if m.get("updated")]
    if claude:
        best = max(claude, key=lambda m: _t(m.get("updated")))
        for k in ("updated", "full_text", "log"):
            if k in best:
                meta[k] = best[k]
    newer_meta = lm if _t((local.get("journal") or {}).get("updated")) >= _t((remote.get("journal") or {}).get("updated")) else rm
    for k in ("journal_urls", "journal_log"):
        if k in newer_meta:
            meta[k] = newer_meta[k]
    out["meta"] = meta
    return out


def api(method: str, url: str, token: str, body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"{}")


def current(repo: str, token: str):
    """(bundle, sha) ou (None, None) si le fichier n'existe pas encore."""
    try:
        info = api("GET", f"https://api.github.com/repos/{repo}/contents/{PATH}?ref=main&t={int(time.time())}", token)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None
        raise
    content = info.get("content")
    if not content:  # fichier > 1 Mo : passer par le blob
        blob = api("GET", info["git_url"], token)
        content = blob["content"]
    return json.loads(base64.b64decode(content)), info["sha"]


def main():
    # Modes hors ligne (la publication se fait alors depuis le Mac avec push.sh)
    if len(sys.argv) == 4 and sys.argv[1] in ("encrypt", "decrypt"):
        pw = os.environ["CONDENSE_PASS"]
        src = json.load(open(sys.argv[2]))
        out = encrypt(src, pw) if sys.argv[1] == "encrypt" else decrypt(src, pw)
        json.dump(out, open(sys.argv[3], "w"), ensure_ascii=False)
        print("OK")
        return
    if len(sys.argv) != 3 or sys.argv[1] not in ("pull", "push"):
        sys.exit(__doc__)
    repo, token, pw = (os.environ[k] for k in ("CONDENSE_REPO", "CONDENSE_TOKEN", "CONDENSE_PASS"))
    cmd, path = sys.argv[1], sys.argv[2]
    if cmd == "pull":
        bundle, _ = current(repo, token)
        data = decrypt(bundle, pw) if bundle else dict(EMPTY)
        for k, v in EMPTY.items():
            data.setdefault(k, v)
        json.dump(data, open(path, "w"), ensure_ascii=False, indent=1)
        print(f"OK : {len(data['stories'])} sujets, {len(data['analyses'])} analyses -> {path}")
        return
    local = json.load(open(path))
    for attempt in range(4):
        bundle, sha = current(repo, token)
        data = merge(local, decrypt(bundle, pw)) if bundle and not os.environ.get("CONDENSE_REPLACE") else local
        payload = json.dumps(encrypt(data, pw)).encode()
        body = {"message": f"Mise à jour {time.strftime('%Y-%m-%d %H:%M')} UTC", "branch": "main",
                "content": base64.b64encode(payload).decode()}
        if sha:
            body["sha"] = sha
        try:
            api("PUT", f"https://api.github.com/repos/{repo}/contents/{PATH}", token, body)
            print(f"OK : publié ({len(payload) // 1024} Ko chiffrés)")
            return
        except urllib.error.HTTPError as e:
            if e.code in (409, 422) and attempt < 2:
                time.sleep(3)
                continue
            sys.exit(f"Échec GitHub {e.code} : {e.read()[:300]!r}")


if __name__ == "__main__":
    main()
