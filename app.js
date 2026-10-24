/* Le Condensé : application (aucune dépendance) */
(() => {
  "use strict";

  // ---------- Petits outils ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem("cd_" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("cd_" + k, JSON.stringify(v)); } catch { /* navigation privée */ } },
  };
  const CATS = ["Politique", "International", "Économie", "Société", "Justice", "Planète", "Culture", "Sciences & Tech", "Sport"];
  const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

  const t = (iso) => (iso ? new Date(iso).getTime() : 0);
  const hm = (iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const dayStart = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const frDay = (d = new Date()) => `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`;
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "à l'instant";
    if (m < 60) return `il y a ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `il y a ${h} h`;
    const j = Math.round(h / 24);
    return `il y a ${j} jour${j > 1 ? "s" : ""}`;
  }
  function whenLabel(iso) {
    const ms = t(iso);
    if (ms >= dayStart()) return hm(iso);
    if (ms >= dayStart() - 864e5) return "Hier " + hm(iso);
    const d = new Date(ms);
    return `${d.getDate()}/${d.getMonth() + 1} ${hm(iso)}`;
  }
  function dayGroup(ms) {
    if (ms >= dayStart()) return "Aujourd'hui";
    if (ms >= dayStart() - 864e5) return "Hier";
    return frDay(new Date(ms));
  }

  const ICON = {
    ext: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    save: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
    cal: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    chev: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  };

  const srcClass = (s) => (s === "Le Monde" ? "monde" : s === "Le Figaro" ? "figaro" : "fi");
  const srcLetter = (s) => (s === "Le Monde" ? "M" : s === "Le Figaro" ? "F" : "fi");
  const badges = (liens) => {
    const seen = [...new Set((liens || []).map((l) => l.source))];
    const order = ["Le Monde", "Le Figaro", "franceinfo"];
    seen.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return seen.map((s) => `<span class="src ${srcClass(s)}" title="${esc(s)}">${srcLetter(s)}</span>`).join("");
  };

  // ---------- État ----------
  const S = {
    live: null, analyses: null, revue: null, agenda: null, comprendre: null, meta: null,
    view: "direct", filter: "all", showMinor: false, limit: 60,
    anaSrc: "all", anaType: "all",
  };
  let prevVisit = store.get("lastSeen", Date.now() - 12 * 3600e3);
  const readSet = new Set(store.get("read", []));
  let saved = store.get("saved", []);

  function markRead(id) {
    readSet.add(id);
    store.set("read", [...readSet].slice(-600));
  }

  // ---------- Thème et taille du texte ----------
  function applyPrefs() {
    const th = store.get("theme", "auto");
    if (th === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", th);
    document.documentElement.style.setProperty("--fs", store.get("fs", 1));
  }
  applyPrefs();

  // ---------- Données ----------
  // ---------- Données chiffrées ----------
  // data/bundle.json est chiffré (AES-GCM) : le site est public, le contenu ne l'est pas.
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  let keyCache = { salt: null, pass: null, key: null };
  async function deriveKey(pass, saltB64, iter) {
    if (keyCache.salt === saltB64 && keyCache.pass === pass) return keyCache.key;
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64(saltB64), iterations: iter },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    keyCache = { salt: saltB64, pass, key };
    return key;
  }
  async function decryptBundle(b, pass) {
    const key = await deriveKey(pass, b.salt, b.iter || 250000);
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(b.iv) }, key, b64(b.ct));
    const txt = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return JSON.parse(txt);
  }
  let lastRaw = null;
  async function load(force) {
    let b;
    try {
      const r = await fetch(`data/bundle.json?t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) { if (!S.meta) { S.meta = { empty: true }; render(); } return false; }
      b = await r.text();
    } catch { return false; }
    if (b === lastRaw && !force) { updateClock(); return false; }
    const pass = store.get("pass", "");
    if (!pass) { showLock(); return false; }
    try {
      const d = await decryptBundle(JSON.parse(b), pass);
      lastRaw = b;
      S.live = { stories: d.stories || [] };
      S.analyses = { items: d.analyses || [] };
      S.agenda = d.agenda || null; S.revue = d.revue || null; S.comprendre = d.comprendre || null;
      const m = d.meta || {};
      const last = [m.updated, m.relay?.updated].filter(Boolean).sort().pop();
      S.meta = { ...m, claude_updated: m.updated, updated: last };
      hideLock();
      render();
      return true;
    } catch {
      showLock("Phrase secrète incorrecte.");
      return false;
    }
  }
  function showLock(msg) {
    let el = $("#lock");
    if (!el) {
      el = document.createElement("div");
      el.id = "lock";
      el.innerHTML = `<div class="lock-card"><div class="lock-logo">C</div><h1>Le Condensé</h1>
        <p>Entre ta phrase secrète pour déverrouiller ta revue de presse. Elle reste sur ce téléphone.</p>
        <form id="lockForm"><input id="lockPass" class="search-input" type="password" autocomplete="current-password" placeholder="Phrase secrète">
        <button class="lock-btn" type="submit">Déverrouiller</button></form><div class="lock-err" id="lockErr"></div></div>`;
      document.body.appendChild(el);
      $("#lockForm").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        store.set("pass", $("#lockPass").value.trim());
        $("#lockErr").textContent = "Déchiffrement…";
        await load(true);
      });
    }
    $("#lockErr").textContent = msg || "";
    el.classList.add("on");
  }
  function hideLock() { $("#lock")?.classList.remove("on"); }

  // ---------- Rendu ----------
  function render() {
    renderDirect();
    renderRevue();
    renderAnalyses();
    renderComprendre();
    updateBadges();
  }

  function updateClock() {
    $$(".updated").forEach((el) => { if (S.meta?.updated) el.textContent = "Mis à jour " + ago(t(S.meta.updated)); });
  }

  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  function hero(title, sub, live) {
    const upd = S.meta?.updated ? `<span class="updated">Mis à jour ${ago(t(S.meta.updated))}</span>` : "";
    return `<div class="hero"><h1>${esc(title)}</h1>
      <div class="date">${live ? '<span class="live-dot"></span>' : ""}<span>${esc(cap(sub || frDay()))}</span>${upd && live ? "<span>·</span>" + upd : ""}</div></div>`;
  }

  function stories() { return S.live?.stories || []; }
  function isNew(s) { return t(s.last) > prevVisit; }

  // ----- Direct -----
  function renderDirect() {
    const el = $("#view-direct");
    if (!S.live) {
      el.innerHTML = hero("Direct", null, true) + '<div class="skel"></div><div class="skel"></div><div class="skel"></div>' +
        (S.meta?.empty ? `<div class="empty"><b>En attente du premier passage de Claude</b>Les sujets apparaissent après la première mise à jour horaire.</div>` : "");
      return;
    }
    const all = stories();
    const fresh = all.filter((s) => isNew(s) && s.importance >= 2);
    const major = fresh.filter((s) => s.importance >= 4).length;

    let html = hero("Direct", null, true);
    html += `<div class="since">
      <div class="num">${fresh.length}</div>
      <div class="txt">${fresh.length
        ? `<b>nouvelle${fresh.length > 1 ? "s" : ""} depuis ta dernière visite</b>, ${ago(prevVisit)}${major ? `, dont <b>${major} importante${major > 1 ? "s" : ""}</b>` : ""}.`
        : `<b>Rien de neuf</b> depuis ta dernière visite (${ago(prevVisit)}). Le fil ci-dessous reste à jour.`}</div></div>`;

    html += agendaWidget();

    // filtres
    const counts = {};
    all.forEach((s) => { if (s.importance >= 2) counts[s.categorie] = (counts[s.categorie] || 0) + 1; });
    const chips = [["all", "Tout"], ["ess", "Essentiel"], ...CATS.filter((c) => counts[c]).map((c) => [c, c])];
    html += `<div class="chips" id="directChips">${chips.map(([k, l]) =>
      `<button class="chip ${S.filter === k ? "on" : ""}" data-f="${esc(k)}">${esc(l)}${counts[k] ? `<span class="c">${counts[k]}</span>` : ""}</button>`).join("")}</div>`;

    let list = all.slice();
    if (S.filter === "ess") list = list.filter((s) => s.importance >= 4);
    else if (S.filter !== "all") list = list.filter((s) => s.categorie === S.filter);
    const minor = list.filter((s) => s.importance < 2);
    if (!S.showMinor) list = list.filter((s) => s.importance >= 2);

    html += '<div class="feed">';
    if (!list.length) html += `<div class="empty"><b>Aucun sujet</b>Rien dans cette rubrique pour l'instant.</div>`;
    let lastGroup = null, n = 0;
    for (const s of list.slice(0, S.limit)) {
      const g = isNew(s) ? "new" : dayGroup(t(s.last));
      if (g !== lastGroup) {
        html += g === "new"
          ? `<div class="group-label new"><span class="live-dot"></span>Depuis ta dernière visite</div>`
          : `<div class="group-label">${esc(g)}</div>`;
        lastGroup = g;
      }
      html += storyCard(s, n++);
    }
    html += "</div>";
    if (list.length > S.limit) html += `<button class="load-more" id="moreStories">Afficher plus (${list.length - S.limit})</button>`;
    if (minor.length && !S.showMinor) html += `<button class="load-more" id="showMinor">Afficher ${minor.length} info${minor.length > 1 ? "s" : ""} secondaire${minor.length > 1 ? "s" : ""}</button>`;
    el.innerHTML = html;

    $$("#directChips .chip", el).forEach((b) => b.onclick = () => { S.filter = b.dataset.f; S.limit = 60; renderDirect(); });
    $$(".story", el).forEach((c) => c.onclick = () => openStory(c.dataset.id));
    $$(".evt", el).forEach((c) => c.onclick = () => openAgenda());
    $("#agendaAll", el)?.addEventListener("click", openAgenda);
    $("#moreStories", el)?.addEventListener("click", () => { S.limit += 60; renderDirect(); });
    $("#showMinor", el)?.addEventListener("click", () => { S.showMinor = true; renderDirect(); });
  }

  function storyCard(s, i) {
    s.liens = s.liens || [];
    const cls = ["story", "imp" + s.importance, s.ai === false ? "raw" : "", readSet.has(s.id) && !isNew(s) ? "read" : ""].join(" ");
    const sameText = !s.phrase || s.phrase === s.titre;
    return `<article class="${cls}" data-id="${esc(s.id)}" style="animation-delay:${Math.min(i, 12) * 35}ms">
      <div class="when">${esc(whenLabel(s.last))}${isNew(s) ? '<span class="newdot"></span>' : ""}</div>
      <div>
        <div class="meta"><span class="cat ${esc(s.categorie)}">${esc(s.categorie)}</span>${s.importance >= 5 ? '<span class="tag-major">Majeur</span>' : ""}</div>
        <div class="ttl">${esc(s.titre)}</div>
        ${sameText ? "" : `<div class="phr">${esc(s.phrase)}</div>`}
        <div class="foot">${badges(s.liens)}<span class="n">${s.liens.length} article${s.liens.length > 1 ? "s" : ""}${s.complet ? " · lu en entier" : ""}</span></div>
      </div></article>`;
  }

  function agendaWidget() {
    const a = S.agenda;
    if (!a || !a.evenements) {
      return `<div class="agenda-card"><div class="agenda-head"><span class="lbl">${ICON.cal}Aujourd'hui</span></div>
        <div style="padding:0 16px 12px;color:var(--muted);font-size:14px">L'agenda du jour est préparé chaque matin vers 5 h.</div></div>`;
    }
    const isToday = a.date === todayISO();
    const evts = a.evenements.slice().sort((x, y) => (y.importance || 1) - (x.importance || 1) || (x.heure || "99").localeCompare(y.heure || "99"));
    const nowHM = new Date().getHours() * 60 + new Date().getMinutes();
    const mins = (h) => { const m = /(\d{1,2})h(\d{2})?/.exec(h || ""); return m ? (+m[1]) * 60 + (+(m[2] || 0)) : null; };
    const isPast = (e) => { const m = mins(e.heure); return isToday && m !== null && m + 90 < nowHM; };
    const shown = evts.slice(0, 8).sort((x, y) => (isPast(x) - isPast(y)) || (x.heure || "99").localeCompare(y.heure || "99"));
    return `<div class="agenda-card">
      <div class="agenda-head"><span class="lbl">${ICON.cal}${isToday ? "Aujourd'hui" : esc(a.label || "Agenda")}</span><button class="all" id="agendaAll">Tout l'agenda</button></div>
      <div class="agenda-scroll">${shown.map((e) => {
        const past = isPast(e);
        return `<div class="evt imp${e.importance || 1} ${past ? "past" : ""}">
          <div class="time"><span class="imp-dot"></span>${esc(e.heure || "Dans la journée")}<span style="font-weight:600">· ${esc(e.categorie || "")}</span></div>
          <div class="t">${esc(e.titre)}</div><div class="why">${esc(e.pourquoi || e.detail || "")}</div></div>`;
      }).join("")}</div></div>`;
  }

  // ----- Revue -----
  function renderRevue() {
    const el = $("#view-revue");
    const r = S.revue;
    if (!r || !r.rubriques) {
      el.innerHTML = hero("Revue de presse") + `<div class="empty"><b>La revue arrive chaque matin</b>Le sommaire du Monde et du Figaro est préparé vers 6 h.</div>`;
      return;
    }
    const isToday = r.date === todayISO();
    let html = hero("Revue de presse", isToday ? frDay() : "Édition du " + (r.label || ""));
    if (r.essentiel) html += `<div class="essentiel"><div class="k">L'essentiel ce matin</div><p>${esc(r.essentiel)}</p></div>`;
    let n = 0;
    r.rubriques.forEach((rub, ri) => {
      html += `<h2 class="rub-title">${esc(rub.nom)}</h2>`;
      rub.sujets.forEach((s, si) => {
        html += `<div class="sujet" data-r="${ri}" data-s="${si}" style="animation-delay:${Math.min(n++, 10) * 40}ms">
          <div class="ttl">${esc(s.titre)}</div><div class="ex">${esc(s.synthese)}</div>
          <div class="foot">${badges(s.liens)}<span class="n" style="font-size:12px;color:var(--muted)">${(s.liens || []).length} article${(s.liens || []).length > 1 ? "s" : ""}</span></div></div>`;
      });
      if (rub.breves?.length) {
        html += `<div class="section-title"><h2>En bref</h2></div><div class="breves">${rub.breves.map((b) => {
          const first = (b.liens || [])[0];
          return `<a class="breve" ${first ? `href="${esc(first.url)}" target="_blank" rel="noopener"` : ""}>
            <div class="bt">${esc(b.titre || "")}</div>${b.phrase ? `<div class="bp">${esc(b.phrase)}</div>` : ""}
            <div class="bl">${badges(b.liens)}</div></a>`;
        }).join("")}</div>`;
      }
    });
    el.innerHTML = html;
    $$(".sujet", el).forEach((c) => c.onclick = () => openSujet(r.rubriques[c.dataset.r].sujets[c.dataset.s], r.rubriques[c.dataset.r].nom));
  }

  // ----- Analyses -----
  function renderAnalyses() {
    const el = $("#view-analyses");
    const items = S.analyses?.items || [];
    const freshCount = items.filter((a) => t(a.date) > prevVisit).length;
    let html = hero("Analyses", "Tribunes, éditoriaux, chroniques, décryptages");
    if (!items.length) {
      el.innerHTML = html + `<div class="empty"><b>Pas encore d'analyses</b>Elles apparaissent au fil des publications.</div>`;
      return;
    }
    if (freshCount) html += `<div class="since"><div class="num">${freshCount}</div><div class="txt"><b>${freshCount > 1 ? "nouveaux textes" : "nouveau texte"}</b> depuis ta dernière visite.</div></div>`;
    const types = [...new Set(items.map((a) => a.type).filter(Boolean))];
    html += `<div class="chips" id="anaSrc">${[["all", "Tout"], ["Le Monde", "Le Monde"], ["Le Figaro", "Le Figaro"]].map(([k, l]) =>
      `<button class="chip ${S.anaSrc === k ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>`;
    if (types.length > 1) html += `<div class="chips" id="anaType" style="padding-top:0">${[["all", "Tous les genres"], ...types.map((x) => [x, x])].map(([k, l]) =>
      `<button class="chip ${S.anaType === k ? "on" : ""}" data-k="${esc(k)}">${esc(l)}</button>`).join("")}</div>`;
    let list = items.filter((a) => (S.anaSrc === "all" || a.source === S.anaSrc) && (S.anaType === "all" || a.type === S.anaType));
    let lastG = null;
    list.slice(0, 120).forEach((a, i) => {
      const g = dayGroup(t(a.date));
      if (g !== lastG) { html += `<div class="group-label">${esc(g)}</div>`; lastG = g; }
      const savedOn = saved.some((x) => x.id === a.id);
      html += `<a class="ana ${readSet.has(a.id) ? "read" : ""}" href="${esc(a.url)}" target="_blank" rel="noopener" data-id="${esc(a.id)}" style="animation-delay:${Math.min(i, 10) * 35}ms">
        <div class="top"><span class="src ${srcClass(a.source)}">${srcLetter(a.source)}</span><span class="type">${esc(a.type)}</span><span>· ${esc(whenLabel(a.date))}</span>${t(a.date) > prevVisit ? '<span class="newdot" style="width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block"></span>' : ""}</div>
        <div class="ttl">${esc(a.titre)}</div>
        ${a.auteur ? `<div class="aut">${esc(a.auteur)}</div>` : ""}
        ${a.these ? `<div class="th">${esc(a.these)}</div>` : ""}
        <button class="pill ${savedOn ? "on" : ""}" data-save="${esc(a.id)}" style="margin-top:10px;padding:5px 10px;font-size:12.5px">${ICON.save}${savedOn ? "Enregistré" : "Lire plus tard"}</button>
      </a>`;
    });
    el.innerHTML = html;
    $$("#anaSrc .chip", el).forEach((b) => b.onclick = () => { S.anaSrc = b.dataset.k; renderAnalyses(); });
    $$("#anaType .chip", el).forEach((b) => b.onclick = () => { S.anaType = b.dataset.k; renderAnalyses(); });
    $$(".ana", el).forEach((c) => c.addEventListener("click", (ev) => {
      const sb = ev.target.closest("[data-save]");
      if (sb) {
        ev.preventDefault(); ev.stopPropagation();
        const a = items.find((x) => x.id === sb.dataset.save);
        toggleSave({ id: a.id, kind: "analyse", titre: a.titre, sub: `${a.type} · ${a.source}`, url: a.url });
        renderAnalyses();
        return;
      }
      markRead(c.dataset.id);
      setTimeout(() => c.classList.add("read"), 400);
    }));
  }

  // ----- Comprendre -----
  function renderComprendre() {
    const el = $("#view-comprendre");
    const c = S.comprendre;
    let html = hero("Comprendre", "International et économie, pour aller plus loin");
    if (!c || !c.dossiers) {
      el.innerHTML = html + `<div class="empty"><b>Les dossiers arrivent chaque matin</b>Quatre sujets internationaux et économiques expliqués en profondeur, vers 7 h.</div>` + shortcuts();
      bindShortcuts(el);
      return;
    }
    const cd = c.chiffre_du_jour || {}, no = c.notion || {};
    html += `<div class="duo">
      ${cd.valeur ? `<div class="tile"><div class="k">Chiffre du jour</div><div class="big">${esc(cd.valeur)}</div><div class="lab">${esc(cd.libelle)}</div><div class="sm">${esc(cd.explication || "")}</div></div>` : ""}
      ${no.terme ? `<div class="tile" id="notion" style="animation-delay:60ms"><div class="k">Notion du jour</div><div class="term">${esc(no.terme)}</div><div class="sm">${esc((no.definition || "").slice(0, 110))}${(no.definition || "").length > 110 ? "…" : ""}</div></div>` : ""}
    </div>`;
    ["International", "Économie"].forEach((dom) => {
      const ds = c.dossiers.filter((d) => d.domaine === dom);
      if (!ds.length) return;
      html += `<div style="height:14px"></div>`;
      ds.forEach((d, i) => {
        html += `<div class="dossier ${esc(dom)}" data-i="${c.dossiers.indexOf(d)}" style="animation-delay:${i * 60}ms">
          <div class="dom">${esc(dom)}</div><div class="ttl">${esc(d.titre)}</div><div class="eb">${esc(d.en_bref)}</div>
          <div class="read-more">Comprendre le dossier ${ICON.chev}</div></div>`;
      });
    });
    html += shortcuts();
    el.innerHTML = html;
    $$(".dossier", el).forEach((x) => x.onclick = () => openDossier(c.dossiers[x.dataset.i]));
    $("#notion", el)?.addEventListener("click", () => openNotion(no));
    bindShortcuts(el);
  }
  function shortcuts() {
    return `<div class="section-title"><h2>Suivre en continu</h2></div>
      <div class="duo"><button class="tile" data-go="International" style="text-align:left"><div class="k">Fil</div><div class="lab" style="font-size:16px">Toute l'actualité internationale</div></button>
      <button class="tile" data-go="Économie" style="text-align:left;animation-delay:60ms"><div class="k">Fil</div><div class="lab" style="font-size:16px">Toute l'actualité économique</div></button></div>`;
  }
  function bindShortcuts(el) {
    $$("[data-go]", el).forEach((b) => b.onclick = () => { S.filter = b.dataset.go; switchView("direct"); renderDirect(); });
  }

  // ---------- Feuilles de détail ----------
  const sheet = $("#sheet"), backdrop = $("#backdrop"), sheetScroll = $("#sheetScroll");
  function openSheet(html, bind) {
    sheetScroll.innerHTML = html;
    sheetScroll.scrollTop = 0;
    sheet.classList.add("on");
    backdrop.classList.add("on");
    document.body.style.overflow = "hidden";
    bind && bind(sheetScroll);
  }
  function closeSheet() {
    sheet.classList.remove("on");
    backdrop.classList.remove("on");
    document.body.style.overflow = "";
    sheet.style.transform = "";
  }
  backdrop.onclick = closeSheet;
  // glisser vers le bas pour fermer
  (() => {
    let y0 = null, dy = 0;
    sheet.addEventListener("touchstart", (e) => {
      if (sheetScroll.scrollTop > 0 && !e.target.closest(".sheet-grab")) return;
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (y0 === null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0) { sheet.classList.add("dragging"); sheet.style.transform = `translateY(${dy}px)`; }
    }, { passive: true });
    sheet.addEventListener("touchend", () => {
      if (y0 === null) return;
      sheet.classList.remove("dragging");
      if (dy > 110) closeSheet(); else sheet.style.transform = "";
      y0 = null;
    });
  })();

  const para = (s) => esc(s).split(/\n+/).map((p) => `<p>${p}</p>`).join("");
  const sec = (title, body, box) => body ? `<div class="d-sec ${box ? "box" : ""}"><h3><i></i>${esc(title)}</h3>${body}</div>` : "";
  const figs = (arr) => arr?.length ? `<div class="figs">${arr.map((c) => `<div class="fig"><div class="v">${esc(c.valeur)}</div><div class="l">${esc(c.libelle)}</div></div>`).join("")}</div>` : "";

  function searchQuery(s) {
    return (s || "").replace(/[«»"“”:;,.!?()]/g, " ").split(/\s+/).filter((w) => w.length > 2).slice(0, 8).join(" ");
  }
  function readLinks(liens, titre) {
    const by = { "Le Monde": [], "Le Figaro": [], franceinfo: [] };
    (liens || []).forEach((l) => (by[l.source] || (by[l.source] = [])).push(l));
    const q = encodeURIComponent(searchQuery(titre));
    const card = (l) => `<a class="rlink" href="${esc(l.url)}" target="_blank" rel="noopener">
      <div class="logo ${srcClass(l.source)}">${srcLetter(l.source)}</div>
      <div><div class="s">${esc(l.source)}${l.date ? " · " + esc(whenLabel(l.date)) : ""}</div><div class="t">${esc(l.titre)}</div></div>${ICON.ext}</a>`;
    const search = (name, url) => `<a class="rlink" href="${url}" target="_blank" rel="noopener">
      <div class="logo search">${ICON.search}</div>
      <div><div class="s">${esc(name)}</div><div class="t">Pas encore d'article repéré : chercher le sujet</div></div>${ICON.ext}</a>`;
    let html = "";
    html += by["Le Monde"].length ? by["Le Monde"].map(card).join("") : search("Le Monde", `https://www.lemonde.fr/recherche/?search_keywords=${q}`);
    html += by["Le Figaro"].length ? by["Le Figaro"].map(card).join("") : search("Le Figaro", `https://recherche.lefigaro.fr/recherche/${q}/`);
    html += (by.franceinfo || []).map(card).join("");
    return `<div class="d-sec"><h3><i></i>Lire dans la presse</h3><div class="read-links">${html}</div></div>`;
  }

  function actionsBar(item) {
    const on = saved.some((x) => x.id === item.id);
    return `<div class="d-actions"><button class="pill ${on ? "on" : ""}" id="dSave">${ICON.save}${on ? "Enregistré" : "Enregistrer"}</button>
      <button class="pill" id="dShare">${ICON.share}Partager</button></div>`;
  }
  function bindActions(el, item, shareText) {
    $("#dSave", el).onclick = (e) => {
      toggleSave(item);
      const on = saved.some((x) => x.id === item.id);
      e.currentTarget.classList.toggle("on", on);
      e.currentTarget.innerHTML = ICON.save + (on ? "Enregistré" : "Enregistrer");
    };
    $("#dShare", el).onclick = async () => {
      const url = item.url || (item.data?.liens || [])[0]?.url || location.href;
      try { if (navigator.share) await navigator.share({ title: item.titre, text: shareText, url }); else { await navigator.clipboard.writeText(`${item.titre}\n${shareText}\n${url}`); toast("Copié"); } } catch { /* annulé */ }
    };
  }

  function storyHTML(s) {
    return `<div class="d-meta"><span class="cat ${esc(s.categorie)}">${esc(s.categorie)}</span>${s.lieu ? `<span>· ${esc(s.lieu)}</span>` : ""}<span>· mis à jour ${esc(whenLabel(s.last || s.updated))}</span></div>
      <h1 class="d-title">${esc(s.titre)}</h1>
      ${s.phrase && s.phrase !== s.titre ? `<div class="d-lead">${esc(s.phrase)}</div>` : ""}
      ${actionsBar({ id: s.id })}
      ${s.maj_relais ? sec("Dernière info", para(s.maj_relais), true) : ""}
      ${figs(s.chiffres)}
      ${sec("Les faits", s.faits && s.faits !== s.phrase ? para(s.faits) : "")}
      ${sec("Contexte", s.contexte ? para(s.contexte) : "")}
      ${sec("Enjeux", s.enjeux ? para(s.enjeux) : "", true)}
      ${sec("Le Monde et Le Figaro", s.angles ? para(s.angles) : "")}
      ${sec("À suivre", s.a_suivre ? para(s.a_suivre) : "")}
      ${readLinks(s.liens, s.titre)}
      <div class="note">${s.ai !== false
        ? (s.complet ? "Synthèse rédigée par Claude à partir des articles complets, lus avec ton abonnement." : "Synthèse rédigée par Claude à partir des titres et chapôs ; l'article complet n'a pas encore été lu.") + " Pour un chiffre sensible, vérifie dans l'article."
        : "Chapô d'origine : la synthèse automatique n'était pas disponible lors de la dernière mise à jour."}</div>`;
  }

  function openStory(id, snapshot) {
    const s = snapshot || stories().find((x) => x.id === id);
    if (!s) return;
    markRead(s.id);
    const item = { id: s.id, kind: "story", titre: s.titre, sub: s.categorie, data: s };
    openSheet(storyHTML(s), (el) => {
      bindActions(el, item, s.phrase);
    });
    setTimeout(() => $(`.story[data-id="${CSS.escape(s.id)}"]`)?.classList.add("read"), 500);
  }

  function openSujet(s, rub) {
    const id = "revue:" + (s.titre || "");
    const item = { id, kind: "sujet", titre: s.titre, sub: "Revue · " + rub, data: { ...s, rub } };
    openSheet(`<div class="d-meta"><span class="cat">${esc(rub)}</span><span>· Revue de presse</span></div>
      <h1 class="d-title">${esc(s.titre)}</h1>
      ${actionsBar(item)}
      ${sec("Synthèse", para(s.synthese))}
      ${s.monde || s.figaro ? `<div class="d-sec"><h3><i></i>Les angles</h3><div class="angles">
        ${s.monde ? `<div class="angle"><span class="src monde">M</span><p>${esc(s.monde)}</p></div>` : ""}
        ${s.figaro ? `<div class="angle"><span class="src figaro">F</span><p>${esc(s.figaro)}</p></div>` : ""}</div></div>` : ""}
      ${readLinks(s.liens, s.titre)}
      <div class="note">Résumé croisé rédigé par Claude à partir des articles du Monde et du Figaro. Les liens ouvrent les articles complets.</div>`,
      (el) => bindActions(el, item, s.synthese?.slice(0, 200)));
  }

  function openDossier(d) {
    const id = "dossier:" + d.titre;
    const item = { id, kind: "dossier", titre: d.titre, sub: d.domaine, data: d };
    openSheet(`<div class="d-meta"><span class="cat ${esc(d.domaine)}">${esc(d.domaine)}</span><span>· Comprendre</span></div>
      <h1 class="d-title">${esc(d.titre)}</h1>
      <div class="d-lead">${esc(d.en_bref)}</div>
      ${actionsBar(item)}
      ${figs(d.chiffres)}
      ${sec("Où en est-on", d.situation ? para(d.situation) : "")}
      ${sec("Pourquoi c'est structurant", d.pourquoi ? para(d.pourquoi) : "", true)}
      ${sec("Comment on en est arrivé là", d.historique ? para(d.historique) : "")}
      ${d.acteurs?.length ? sec("Les acteurs", `<div class="actors">${d.acteurs.map((a) => `<div class="actor"><b>${esc(a.nom)}</b><span>${esc(a.role)}</span></div>`).join("")}</div>`) : ""}
      ${sec("Le débat", d.positions ? para(d.positions) : "")}
      ${sec("À surveiller", d.a_surveiller ? para(d.a_surveiller) : "")}
      ${readLinks(d.liens, d.titre)}`,
      (el) => bindActions(el, item, d.en_bref));
  }

  function openNotion(no) {
    openSheet(`<div class="d-meta"><span>Notion du jour</span></div>
      <h1 class="d-title">${esc(no.terme)}</h1>
      ${sec("Définition", para(no.definition || ""))}
      ${sec("Dans l'actualité", para(no.exemple || ""), true)}`);
  }

  function openAgenda() {
    const a = S.agenda;
    if (!a?.evenements) return;
    const row = (e) => `<div class="evt-row"><div class="h"><span class="imp-dot i${e.importance || 1}"></span>${esc(e.heure || "Journée")}</div>
      <div><div class="t">${esc(e.titre)}</div>${e.detail ? `<div class="d">${esc(e.detail)}</div>` : ""}${e.pourquoi ? `<div class="w">${esc(e.pourquoi)}</div>` : ""}<div class="c">${esc(e.categorie || "")}</div></div></div>`;
    openSheet(`<div class="d-meta"><span>Agenda</span>${a.updated ? `<span>· établi ${esc(ago(t(a.updated)))}</span>` : ""}</div>
      <h1 class="d-title">${esc(cap(a.label) || "Aujourd'hui")}</h1>
      <div class="d-sec agenda-list">${a.evenements.map(row).join("")}</div>
      ${a.semaine?.length ? `<div class="d-sec"><h3><i></i>Cette semaine</h3><div class="agenda-list">${a.semaine.map((s) => `<div class="evt-row"><div class="h" style="font-size:12.5px">${esc(cap(s.jour))}</div><div><div class="t">${esc(s.titre)}</div><div class="w">${esc(s.pourquoi || "")}</div></div></div>`).join("")}</div></div>` : ""}
      <div class="note">Agenda établi par Claude chaque matin (et revu à midi) à partir des agendas officiels et de la presse. Les horaires peuvent évoluer.</div>`);
  }

  // ---------- Enregistrés ----------
  function toggleSave(item) {
    if (saved.some((x) => x.id === item.id)) { saved = saved.filter((x) => x.id !== item.id); toast("Retiré des enregistrés"); }
    else {
      const story = item.kind === "story" ? stories().find((s) => s.id === item.id) : null;
      saved.unshift({ ...item, titre: item.titre || story?.titre, sub: item.sub || story?.categorie, data: item.data || story, at: Date.now() });
      toast("Enregistré");
    }
    saved = saved.slice(0, 200);
    store.set("saved", saved);
  }
  function openSaved() {
    const html = saved.length ? saved.map((x, i) => `<div class="breve" data-i="${i}" style="cursor:pointer">
      <div class="bp" style="margin:0 0 3px">${esc(x.sub || "")} · ${esc(ago(x.at))}</div><div class="bt">${esc(x.titre)}</div></div>`).join("")
      : `<div class="empty"><b>Rien d'enregistré</b>Utilise « Enregistrer » sur un sujet ou « Lire plus tard » sur une analyse.</div>`;
    openSheet(`<h1 class="d-title">Enregistrés</h1><div class="breves" style="margin-top:16px">${html}</div>`, (el) => {
      $$(".breve[data-i]", el).forEach((b) => b.onclick = () => {
        const x = saved[b.dataset.i];
        if (x.kind === "analyse") { window.open(x.url, "_blank", "noopener"); return; }
        if (x.kind === "story") openStory(x.id, stories().find((s) => s.id === x.id) || x.data);
        else if (x.kind === "sujet") openSujet(x.data, x.data.rub || "");
        else if (x.kind === "dossier") openDossier(x.data);
      });
    });
  }

  // ---------- Recherche ----------
  function openSearch() {
    openSheet(`<h1 class="d-title" style="margin-bottom:14px">Rechercher</h1>
      <input class="search-input" id="q" type="search" placeholder="Budget, Ukraine, BCE, Sénat…" autocomplete="off">
      <div id="results" style="margin-top:14px"></div>`, (el) => {
      const q = $("#q", el), out = $("#results", el);
      setTimeout(() => q.focus(), 350);
      q.oninput = () => {
        const v = q.value.trim().toLowerCase();
        if (v.length < 2) { out.innerHTML = ""; return; }
        const norm = (s) => (s || "").toLowerCase();
        const st = stories().filter((s) => norm(s.titre + " " + s.phrase + " " + s.faits + " " + s.contexte).includes(v)).slice(0, 30);
        const an = (S.analyses?.items || []).filter((a) => norm(a.titre + " " + a.these + " " + a.auteur).includes(v)).slice(0, 20);
        out.innerHTML = (st.length ? `<div class="group-label">Direct</div>` + st.map((s, i) => storyCard(s, i)).join("") : "") +
          (an.length ? `<div class="group-label">Analyses</div><div class="breves">` + an.map((a) => `<a class="breve" href="${esc(a.url)}" target="_blank" rel="noopener"><div class="bp" style="margin:0 0 3px">${esc(a.type)} · ${esc(a.source)}</div><div class="bt">${esc(a.titre)}</div></a>`).join("") + "</div>" : "") ||
          `<div class="empty">Aucun résultat dans les dernières 48 h.</div>`;
        $$(".story", out).forEach((c) => c.onclick = () => openStory(c.dataset.id));
      };
    });
  }

  // ---------- Réglages ----------
  function openSettings() {
    const th = store.get("theme", "auto"), fs = store.get("fs", 1);
    const m = S.meta || {};
    openSheet(`<h1 class="d-title">Réglages</h1>
      <div class="d-sec">
        <div class="setting"><span>Apparence</span><div class="seg" id="segTheme">${[["auto", "Auto"], ["light", "Clair"], ["dark", "Sombre"]].map(([k, l]) => `<button data-k="${k}" class="${th === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
        <div class="setting"><span>Taille du texte</span><div class="seg" id="segFs">${[[0.92, "A−"], [1, "A"], [1.1, "A+"]].map(([k, l]) => `<button data-k="${k}" class="${fs == k ? "on" : ""}">${l}</button>`).join("")}</div></div>
        <div class="setting"><span>Tout marquer comme lu</span><button class="pill" id="markAll">Marquer</button></div>
        <div class="setting"><span>Verrouiller l'app</span><button class="pill" id="lockBtn">Verrouiller</button></div>
      </div>
      <div class="d-sec box"><h3><i></i>État du service</h3>
        <p>Relevé automatique (toutes les 15 min, même Mac éteint) : <b>${m.relay?.updated ? esc(ago(t(m.relay.updated))) : "aucun pour l'instant"}</b>${m.relay && !m.relay.ai ? ` <span class="status-ko">(IA indisponible : titres bruts)</span>` : ""}<br>
        Dernier passage de Claude (articles complets) : <b>${m.claude_updated ? esc(ago(t(m.claude_updated))) : "aucun pour l'instant"}</b><br>
        Articles complets : ${m.full_text === false ? `<span class="status-ko">non lus au dernier passage</span> (Chrome injoignable ou déconnecté des journaux)` : m.full_text ? `<span class="status-ok">lus via ton abonnement</span>` : "inconnu"}<br>
        L'app vérifie les nouveautés chaque minute. Le relevé GitHub rédige le direct toutes les 15 minutes ; Claude approfondit toutes les heures quand ton Mac est allumé.</p>
        ${m.log?.length ? `<details style="margin-top:8px"><summary style="color:var(--muted);font-size:14px">Journal du dernier passage</summary><div class="logbox">${esc([].concat(m.log).join("\n"))}</div></details>` : ""}
      </div>
      <div class="d-sec"><h3><i></i>À propos</h3><p style="font-size:15px">Chaque heure, Claude relève les nouveaux articles du Monde, du Figaro et de franceinfo, lit les plus importants en entier dans ton Chrome avec ton abonnement, et rédige les synthèses. Les données sont chiffrées : sans ta phrase secrète, personne ne peut les lire. Pour ajouter une fonction, demande-le à Claude dans le projet « Application actualité ».</p></div>`,
      (el) => {
        $$("#segTheme button", el).forEach((b) => b.onclick = () => { store.set("theme", b.dataset.k); applyPrefs(); $$("#segTheme button", el).forEach((x) => x.classList.toggle("on", x === b)); });
        $$("#segFs button", el).forEach((b) => b.onclick = () => { store.set("fs", +b.dataset.k); applyPrefs(); $$("#segFs button", el).forEach((x) => x.classList.toggle("on", x === b)); });
        $("#markAll", el).onclick = () => { prevVisit = Date.now(); store.set("lastSeen", prevVisit); render(); toast("Tout est marqué comme lu"); };
        $("#lockBtn", el).onclick = () => { store.set("pass", ""); closeSheet(); lastRaw = null; showLock(); };
      });
  }

  // ---------- Navigation ----------
  const VIEWS = ["direct", "revue", "analyses", "comprendre"];
  function switchView(v) {
    if (S.view === v) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    S.view = v;
    $$(".view").forEach((x) => x.classList.toggle("active", x.id === "view-" + v));
    $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
    $("#tabIndicator").style.transform = `translateX(${VIEWS.indexOf(v) * 100}%)`;
    window.scrollTo(0, 0);
    store.set("view", v);
  }
  $$(".tab").forEach((b) => b.onclick = () => switchView(b.dataset.view));

  function updateBadges() {
    const nd = stories().filter((s) => isNew(s) && s.importance >= 3).length;
    const na = (S.analyses?.items || []).filter((a) => t(a.date) > prevVisit).length;
    const set = (v, n) => {
      const tab = $(`.tab[data-view="${v}"]`);
      let b = $(".badge", tab);
      if (!n) { b?.remove(); return; }
      if (!b) { b = document.createElement("span"); b.className = "badge"; tab.appendChild(b); }
      b.textContent = n > 99 ? "99+" : n;
    };
    set("direct", nd);
    set("analyses", na);
  }

  $("#btnSearch").onclick = openSearch;
  $("#btnSaved").onclick = openSaved;
  $("#btnSettings").onclick = openSettings;

  // barre du haut en verre au défilement
  const topbar = $("#topbar");
  window.addEventListener("scroll", () => topbar.classList.toggle("scrolled", window.scrollY > 40), { passive: true });

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg; el.classList.add("on");
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove("on"), 1800);
  }

  // ---------- Tirer pour actualiser ----------
  (() => {
    const ptr = $("#ptr");
    let y0 = null, dy = 0, busy = false;
    window.addEventListener("touchstart", (e) => {
      if (window.scrollY > 0 || sheet.classList.contains("on") || busy) return;
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    window.addEventListener("touchmove", (e) => {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      if (dy > 5) {
        ptr.classList.add("pull");
        const p = Math.min(dy, 120);
        ptr.style.opacity = Math.min(1, p / 70);
        ptr.style.transform = `translate(-50%, ${p * 0.6 - 40}px) rotate(${p * 3}deg)`;
      }
    }, { passive: true });
    window.addEventListener("touchend", async () => {
      if (y0 === null) return;
      y0 = null;
      ptr.classList.remove("pull");
      if (dy > 80) {
        busy = true;
        ptr.classList.add("loading");
        ptr.style.transform = "translate(-50%, 10px)";
        const changed = await load(true);
        toast(changed ? "Actualisé" : "Déjà à jour");
        busy = false;
        ptr.classList.remove("loading");
      }
      ptr.style.opacity = 0;
      ptr.style.transform = "";
    });
  })();

  // ---------- Dernière visite et rafraîchissement ----------
  let hiddenAt = null;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      store.set("lastSeen", hiddenAt);
    } else {
      if (hiddenAt && Date.now() - hiddenAt > 20 * 60e3) {
        prevVisit = hiddenAt;
        S.showMinor = false;
      }
      load();
    }
  });
  window.addEventListener("pagehide", () => store.set("lastSeen", Date.now()));
  setInterval(() => { if (!document.hidden) load(); }, 60e3); // vérifie chaque minute
  setInterval(updateClock, 60e3);

  // ---------- Démarrage ----------
  switchView(store.get("view", "direct") === "direct" ? "direct" : store.get("view", "direct"));
  render();
  load();
  // la visite courante devient la référence à la prochaine ouverture
  setTimeout(() => store.set("lastSeen", Date.now()), 15000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
