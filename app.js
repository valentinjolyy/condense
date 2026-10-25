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
    view: "journal", filter: "all", showMinor: false, limit: 60,
    anaSrc: "all", anaType: "all",
  };
  let prevVisit = store.get("lastSeen", Date.now() - 12 * 3600e3);
  let saved = store.get("saved", []);
  let cats = store.get("cats", ["À lire", "Travail", "Culture générale"]);
  // État « lu » : id -> date de lecture. Un sujet mis à jour après lecture redevient non lu.
  const readMap = store.get("readmap", {});
  function setRead(key, on) {
    if (on) readMap[key] = Date.now(); else delete readMap[key];
    const keys = Object.keys(readMap);
    if (keys.length > 900) keys.sort((a, b) => readMap[a] - readMap[b]).slice(0, keys.length - 900).forEach((k) => delete readMap[k]);
    store.set("readmap", readMap);
  }
  const isRead = (s) => !!readMap[s.id] && readMap[s.id] >= t(s.last);
  const isUpdated = (s) => !!readMap[s.id] && readMap[s.id] < t(s.last);
  const isReadA = (a) => !!readMap["a:" + a.id];

  // Pertinence : politique, international, économie, société, sciences ; pas de sport ni de divertissement
  const SPORT = /\b(ligue 1|ligue des champions|football|rugby|tennis|psg|f1|formule 1|grand prix|basket|handball|cyclisme|tour de france|mercato|match|coupe du monde|euro 20\d\d|top 14|nba|roland-garros|tops et (les )?flops)\b/i;
  function relevant(s) {
    if (s.categorie === "Sport") return false;
    if (s.categorie === "Culture" && (s.importance || 0) < 4) return false;
    if (!["Politique", "International", "Économie"].includes(s.categorie) && SPORT.test(s.titre || "")) return false;
    return true;
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
      S.agenda = d.agenda || null; S.revue = d.revue || null; S.journal = d.journal || null; S.plusloin = d.plusloin || []; S.ple = d.plusloin_editions || {};
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
    renderJournal();
    renderDirect();
    renderAnalyses();
    renderPlusLoin();
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
        (S.meta?.empty ? `<div class="empty"><b>En attente du premier passage</b>Les sujets apparaissent après la première mise à jour.</div>` : "");
      return;
    }
    const all = dedupe(stories().filter(relevant)).filter((s) => S.showMinor || (s.importance || 0) >= 3);
    const unread = all.filter((s) => !isRead(s));
    const read = all.filter(isRead).sort((a, b) => (readMap[b.id] || 0) - (readMap[a.id] || 0));
    const fresh = unread.filter((s) => t(s.last) > prevVisit).length;
    const upd = unread.filter(isUpdated).length;

    let html = hero("Direct", null, true);
    html += `<div class="since"><div class="num">${unread.length}</div><div class="txt">${unread.length
      ? `<b>actualité${unread.length > 1 ? "s" : ""} non lue${unread.length > 1 ? "s" : ""}</b>${fresh ? `, dont <b>${fresh} nouvelle${fresh > 1 ? "s" : ""}</b> depuis ta dernière visite (${ago(prevVisit)})` : `. Rien de neuf depuis ta dernière visite (${ago(prevVisit)})`}${upd ? `. ${upd} sujet${upd > 1 ? "s" : ""} déjà lu${upd > 1 ? "s" : ""} a du nouveau` : ""}.`
      : `<b>Tout est lu.</b> Rien de neuf depuis ta dernière visite (${ago(prevVisit)}).`}
      ${Object.keys(readMap).length ? "" : `<span class="hint">Glisse une actualité vers la droite pour la marquer comme lue.</span>`}</div></div>`;

    const counts = {};
    unread.forEach((s) => { counts[s.categorie] = (counts[s.categorie] || 0) + 1; });
    const chips = [["all", "Tout"], ["ess", "Essentiel"], ...CATS.filter((c) => counts[c] && c !== "Sport").map((c) => [c, c])];
    html += `<div class="chips" id="directChips">${chips.map(([k, l]) =>
      `<button class="chip ${S.filter === k ? "on" : ""}" data-f="${esc(k)}">${esc(l)}${counts[k] ? `<span class="c">${counts[k]}</span>` : ""}</button>`).join("")}</div>`;

    const filt = (l) => S.filter === "ess" ? l.filter((s) => s.importance >= 4) : S.filter === "all" ? l : l.filter((s) => s.categorie === S.filter);
    const list = filt(unread);
    html += '<div class="feed">';
    if (!list.length) html += `<div class="empty"><b>${unread.length ? "Rien dans cette rubrique" : "Écran propre"}</b>${unread.length ? "Choisis une autre rubrique." : "Les nouvelles actualités apparaîtront ici."}</div>`;
    let lastGroup = null, n = 0;
    for (const s of list.slice(0, S.limit)) {
      const g = t(s.last) > prevVisit ? "new" : dayGroup(t(s.last));
      if (g !== lastGroup) {
        html += g === "new" ? `<div class="group-label new"><span class="live-dot"></span>Depuis ta dernière visite</div>` : `<div class="group-label">${esc(g)}</div>`;
        lastGroup = g;
      }
      html += storyCard(s, n++);
    }
    html += "</div>";
    if (list.length > S.limit) html += `<button class="load-more" id="moreStories">Afficher plus (${list.length - S.limit})</button>`;
    if (!S.showMinor) html += `<button class="load-more subtle" id="showMinor">Afficher aussi les sujets secondaires</button>`;
    const readList = filt(read);
    if (readList.length) {
      html += `<button class="read-toggle ${S.showRead ? "open" : ""}" id="readToggle"><span>Déjà lus</span><span class="c">${readList.length}</span>${ICON.chev}</button>`;
      if (S.showRead) html += `<div class="feed read-feed">${readList.slice(0, 150).map((s, i) => storyCard(s, i)).join("")}</div>`;
    }
    el.innerHTML = html;

    $$("#directChips .chip", el).forEach((b) => b.onclick = () => { S.filter = b.dataset.f; S.limit = 60; renderDirect(); });
    $$(".story", el).forEach((c) => c.addEventListener("click", () => openStory(c.dataset.id)));
    attachSwipe(el, ".story", (id) => {
      const s = all.find((x) => x.id === id) || stories().find((x) => x.id === id); if (!s) return;
      const on = !isRead(s);
      // un sujet regroupé : on marque aussi ses doublons
      const w = wordsOf((s.titre || "") + " " + (s.phrase || ""));
      stories().forEach((x) => { if (x.id === id) return; const xw = wordsOf((x.titre || "") + " " + (x.phrase || "")); let i = 0; xw.forEach((k) => { if (w.has(k)) i++; }); if (i >= 3 && i / Math.min(w.size, xw.size) >= 0.5) setRead(x.id, on); });
      setRead(id, on); quietRender();
    });
    $$(".evt", el).forEach((c) => c.onclick = () => openAgenda());
    $("#agendaAll", el)?.addEventListener("click", openAgenda);
    $("#moreStories", el)?.addEventListener("click", () => { S.limit += 60; renderDirect(); });
    $("#showMinor", el)?.addEventListener("click", () => { S.showMinor = true; renderDirect(); });
    $("#readToggle", el)?.addEventListener("click", () => { S.showRead = !S.showRead; const y = window.scrollY; renderDirect(); window.scrollTo(0, y); });
  }

  // Regroupe les sujets qui parlent du même événement (filet de sécurité côté app)
  const STOPW = new Set("avec dans pour sans sous selon après avant contre entre leurs cette celle être avoir plus moins très tout tous toute toutes depuis encore alors ainsi comme mais donc dont elle elles nous vous samedi dimanche lundi mardi mercredi jeudi vendredi octobre novembre décembre janvier février mars avril juin juillet août septembre direct france français française".split(" "));
  const wordsOf = (x) => new Set(((x || "").toLowerCase().match(/[a-zàâçéèêëîïôûùüœ0-9]{5,}/g) || []).filter((w) => !STOPW.has(w)));
  function dedupe(list) {
    const sorted = list.slice().sort((a, b) => (!!b.complet - !!a.complet) || ((b.importance || 0) - (a.importance || 0)) || (t(b.last) - t(a.last)));
    const kept = [];
    for (const s of sorted) {
      const w = wordsOf((s.titre || "") + " " + (s.phrase || ""));
      let twin = null;
      for (const k of kept) {
        let inter = 0; w.forEach((x) => { if (k.w.has(x)) inter++; });
        if (inter >= 3 && inter / Math.min(w.size, k.w.size) >= 0.5) { twin = k; break; }
      }
      if (!twin) { kept.push({ s: { ...s, liens: [...(s.liens || [])] }, w }); continue; }
      const urls = new Set(twin.s.liens.map((l) => l.url));
      (s.liens || []).forEach((l) => { if (!urls.has(l.url)) twin.s.liens.push(l); });
      if (t(s.last) > t(twin.s.last)) twin.s.last = s.last;
    }
    return kept.map((k) => k.s).sort((a, b) => t(b.last) - t(a.last));
  }

  function storyCard(s, i) {
    s.liens = s.liens || [];
    const r = isRead(s), u = isUpdated(s);
    const cls = ["story", "imp" + s.importance, s.ai === false ? "raw" : "", r ? "read" : ""].join(" ");
    // Une seule ligne d'information : la phrase complète (le titre court reste pour la fiche)
    const main = s.ai === false ? s.titre : (s.phrase || s.titre);
    const sub = s.ai === false && s.phrase && s.phrase !== s.titre ? s.phrase : "";
    const maj = s.maj || s.maj_relais;
    return `<div class="swipe ${r ? "is-read" : ""}" style="animation-delay:${Math.min(i, 12) * 35}ms"><div class="swipe-bg"><span>${r ? "Remettre en non lu" : "Lu ✓"}</span></div>
      <article class="${cls}" data-id="${esc(s.id)}">
      <div class="when">${esc(whenLabel(s.last))}${!r && t(s.last) > prevVisit ? '<span class="newdot"></span>' : ""}</div>
      <div>
        <div class="meta"><span class="cat ${esc(s.categorie)}">${esc(s.categorie)}</span>${s.importance >= 5 ? '<span class="tag-major">Majeur</span>' : ""}${u ? '<span class="tag-upd">Du nouveau</span>' : ""}</div>
        <div class="ttl">${esc(main)}</div>
        ${sub ? `<div class="phr">${esc(sub)}</div>` : ""}
        ${u && maj ? `<div class="maj">${esc(maj)}</div>` : ""}
        <div class="foot">${badges(s.liens)}<span class="n">${s.liens.length} article${s.liens.length > 1 ? "s" : ""}${s.complet ? " · lu en entier" : ""}</span></div>
      </div></article></div>`;
  }

  // Glisser vers la droite : lu / non lu (geste amorti, sortie et repli fluides)
  function attachSwipe(root, sel, onCommit) {
    const TH = 96;
    $$(sel, root).forEach((card) => {
      let x0 = null, y0 = 0, dx = 0, drag = false, lastX = 0, lastT = 0, vel = 0;
      const wrap = card.parentElement;
      card.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        x0 = e.clientX; y0 = e.clientY; dx = 0; drag = false; lastX = x0; lastT = performance.now(); vel = 0;
      });
      card.addEventListener("pointermove", (e) => {
        if (x0 === null) return;
        const ddx = e.clientX - x0, ddy = e.clientY - y0;
        if (!drag) {
          if (ddx > 10 && Math.abs(ddx) > Math.abs(ddy) * 1.5) {
            drag = true; card.classList.add("dragging"); wrap.classList.add("swiping");
            try { card.setPointerCapture(e.pointerId); } catch {}
          } else if (Math.abs(ddy) > 10 || ddx < -10) { x0 = null; return; }
        }
        if (!drag) return;
        const now = performance.now();
        vel = (e.clientX - lastX) / Math.max(1, now - lastT); lastX = e.clientX; lastT = now;
        const raw = Math.max(0, ddx);
        dx = raw < 140 ? raw : 140 + (raw - 140) * 0.35; // résistance élastique
        card.style.transform = `translate3d(${dx}px,0,0)`;
        wrap.style.setProperty("--p", Math.min(1, dx / TH).toFixed(3));
        wrap.classList.toggle("armed", dx > TH);
      });
      const end = () => {
        if (x0 === null) return;
        x0 = null;
        if (!drag) return;
        drag = false;
        card._swiped = Date.now();
        card.classList.remove("dragging");
        if (dx > TH || (dx > 40 && vel > 0.6)) {
          wrap.classList.add("armed", "leaving");
          card.style.transform = "translate3d(calc(100% + 30px),0,0)";
          setTimeout(() => {
            const h = wrap.offsetHeight;
            wrap.style.height = h + "px";
            wrap.offsetHeight; // reflow
            wrap.classList.add("collapsing");
            wrap.style.height = "0px";
          }, 260);
          setTimeout(() => onCommit(card.dataset.id), 560);
        } else {
          card.style.transform = "";
          wrap.style.setProperty("--p", 0);
          wrap.classList.remove("armed", "swiping");
        }
      };
      card.addEventListener("pointerup", end);
      card.addEventListener("pointercancel", end);
      card.addEventListener("click", (e) => { if (card._swiped && Date.now() - card._swiped < 500) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    });
  }
  // Re-rendu sans animations d'entrée (après un geste), en gardant la position de défilement
  function quietRender() {
    const y = window.scrollY;
    document.body.classList.add("no-anim");
    render();
    window.scrollTo(0, y);
    setTimeout(() => document.body.classList.remove("no-anim"), 80);
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

  // ----- Journal : le sommaire des éditions du Monde et du Figaro -----
  const hashId = (x) => { let h = 0; for (const c of String(x)) h = (h * 31 + c.charCodeAt(0)) | 0; return "j" + (h >>> 0).toString(36); };
  function renderJournal() {
    const el = $("#view-journal");
    const j = S.journal;
    let html = hero("Le journal", frDay());
    html += agendaWidget();
    if (Array.isArray(j?.essentiel) && j.essentiel.length) {
      html += `<div class="essentiel"><div class="k">L'essentiel</div>${j.essentiel.map((e) =>
        `<div class="ess-item"><div class="ess-t">${esc(e.titre || "")}</div>${e.texte ? `<div class="ess-p">${esc(e.texte)}</div>` : ""}</div>`).join("")}</div>`;
    }
    const eds = ["Le Monde", "Le Figaro"].filter((n) => j?.editions?.[n]?.rubriques?.length || j?.editions?.[n]?.une?.length);
    if (!eds.length) {
      el.innerHTML = html + (S.revue?.rubriques ? revueFallback() : `<div class="empty"><b>Le sommaire arrive</b>Le Monde est lu après sa parution (vers 13 h 30), Le Figaro après la sienne (vers 22 h 30).</div>`);
      bindJournal(el);
      return;
    }
    if (!eds.includes(S.ed)) S.ed = eds[0];
    html += `<div class="ed-seg" id="edSeg">${["Le Monde", "Le Figaro"].map((n) => {
      const e = j.editions[n];
      return `<button class="${S.ed === n ? "on" : ""} ${eds.includes(n) ? "" : "off"}" data-ed="${n}"><span class="src ${srcClass(n)}">${srcLetter(n)}</span><span><b>${n}</b><small>${e ? esc(e.label || "") : "pas encore paru"}</small></span></button>`;
    }).join("")}</div>`;
    const ed = j.editions[S.ed];
    const opened = store.get("opened", {});
    const row = (a, big) => {
      const id = hashId(a.url || a.titre);
      const sv = saved.some((x) => x.id === id);
      return `<div class="art ${big ? "une" : ""} ${opened[id] ? "seen" : ""}">
        <a href="${esc(a.url || "#")}" target="_blank" rel="noopener" data-open="${id}">
          ${a.genre && a.genre !== "Article" ? `<div class="genre">${esc(a.genre)}</div>` : ""}
          <div class="at">${esc(a.titre)}</div>
          ${a.resume ? `<div class="ar">${esc(a.resume)}</div>` : ""}
          ${a.auteur ? `<div class="au">${esc(a.auteur)}</div>` : ""}
        </a>
        <button class="art-save ${sv ? "on" : ""}" data-save="${id}" aria-label="Lire plus tard">${ICON.save}</button></div>`;
    };
    html += `<div class="ed-head">${ed.parution ? `Paru ${esc(whenLabel(ed.parution).toLowerCase())} · ` : ""}${(ed.rubriques || []).reduce((n, r) => n + (r.articles || []).length, 0) + (ed.une || []).length} articles</div>`;
    if (ed.une?.length) html += `<h2 class="rub-title">À la une</h2><div class="arts">${ed.une.map((a) => row(a, true)).join("")}</div>`;
    (ed.rubriques || []).forEach((r) => {
      if (!r.articles?.length) return;
      html += `<h2 class="rub-title">${esc(r.nom)}</h2><div class="arts">${r.articles.map((a) => row(a)).join("")}</div>`;
    });
    html += `<div class="note">Sommaire établi par Claude à partir de l'édition complète, lue avec ton abonnement. Touche un titre pour lire l'article.</div>`;
    el.innerHTML = html;
    bindJournal(el);
    $$("#edSeg button", el).forEach((b) => b.onclick = () => { if (b.classList.contains("off")) return; S.ed = b.dataset.ed; const y = window.scrollY; renderJournal(); window.scrollTo(0, Math.min(y, $("#edSeg").offsetTop - 70)); });
    $$("[data-open]", el).forEach((a) => a.addEventListener("click", () => {
      const o = store.get("opened", {}); o[a.dataset.open] = Date.now(); store.set("opened", o);
      setTimeout(() => a.parentElement.classList.add("seen"), 600);
    }));
    const all = [...(ed.une || []), ...(ed.rubriques || []).flatMap((r) => (r.articles || []).map((x) => ({ ...x, rub: r.nom })))];
    $$("[data-save]", el).forEach((b) => b.onclick = (e) => {
      e.preventDefault();
      const a = all.find((x) => hashId(x.url || x.titre) === b.dataset.save);
      if (!a) return;
      toggleSave({ id: b.dataset.save, kind: "analyse", titre: a.titre, sub: `${S.ed}${a.rub ? " · " + a.rub : ""}`, url: a.url }, () => { const y = window.scrollY; renderJournal(); window.scrollTo(0, y); });
    });
  }
  function bindJournal(el) {
    $$(".evt", el).forEach((c) => c.onclick = () => openAgenda());
    $("#agendaAll", el)?.addEventListener("click", openAgenda);
    $$(".sujet", el).forEach((c) => c.onclick = () => openSujet(S.revue.rubriques[c.dataset.r].sujets[c.dataset.s], S.revue.rubriques[c.dataset.r].nom));
  }
  function revueFallback() {
    const r = S.revue;
    let html = "";
    let n = 0;
    r.rubriques.forEach((rub, ri) => {
      html += `<h2 class="rub-title">${esc(rub.nom)}</h2>`;
      rub.sujets.forEach((s, si) => {
        html += `<div class="sujet" data-r="${ri}" data-s="${si}" style="animation-delay:${Math.min(n++, 10) * 40}ms"><div class="ttl">${esc(s.titre)}</div><div class="ex">${esc(s.resume || s.synthese)}</div><div class="foot">${badges(s.liens)}</div></div>`;
      });
    });
    return html;
  }

  // ----- Pour aller plus loin -----
  const isReadP = (a) => !!readMap["p:" + a.id];
  const accClass = (x) => x === "abonnés" ? "abonnes" : x;
  const accLabel = (x) => x === "gratuit" ? "Gratuit" : x === "partiel" ? "En partie gratuit" : "Abonnés";
  function plCard(a, i) {
    const r = isReadP(a), sv = saved.some((x) => x.id === a.id);
    return `<div class="swipe ${r ? "is-read" : ""}" style="animation-delay:${Math.min(i, 10) * 35}ms"><div class="swipe-bg"><span>${r ? "Remettre en non lu" : "Lu ✓"}</span></div>
      <a class="pl ${r ? "read" : ""}" href="${esc(a.url)}" target="_blank" rel="noopener" data-id="${esc(a.id)}">
        <div class="top"><span class="srcname">${esc(a.source)}</span><span class="acc ${accClass(a.acces)}">${accLabel(a.acces)}</span>${a.genre ? `<span class="genre">${esc(a.genre)}</span>` : ""}<span>· ${esc(whenLabel(a.date))}</span></div>
        <div class="ttl">${esc(a.titre)}</div>
        ${a.auteur ? `<div class="aut">${esc(a.auteur)}</div>` : ""}
        ${a.these ? `<div class="th">${esc(a.these)}</div>` : ""}
      </a><button class="art-save ${sv ? "on" : ""}" data-save="${esc(a.id)}" aria-label="Lire plus tard" style="z-index:2">${ICON.save}</button></div>`;
  }
  function renderPlusLoin() {
    const el = $("#view-plusloin");
    const items = S.plusloin || [];
    let html = hero("Pour aller plus loin", "Revues, think tanks et presse d'idées");
    // Éditions hebdomadaires (La Tribune Dimanche…)
    Object.entries(S.ple || {}).sort((a, b) => t(b[1].parution || b[1].updated) - t(a[1].parution || a[1].updated)).forEach(([name, ed]) => {
      if (!ed?.rubriques?.length && !ed?.une?.length) return;
      const open = S.pleOpen === name;
      const rows = (list) => `<div class="arts">${list.map((a) => `<div class="art"><a href="${esc(a.url || "#")}" target="_blank" rel="noopener">${a.genre && a.genre !== "Article" ? `<div class="genre">${esc(a.genre)}</div>` : ""}<div class="at">${esc(a.titre)}</div>${a.resume ? `<div class="ar">${esc(a.resume)}</div>` : ""}${a.auteur ? `<div class="au">${esc(a.auteur)}</div>` : ""}</a></div>`).join("")}</div>`;
      html += `<div class="ple ${open ? "open" : ""}"><div class="k">Le sommaire</div><div class="h">${esc(name)}</div><div class="s">${esc(ed.label || "")}</div>
        <button data-ple="${esc(name)}">${open ? "Masquer le sommaire" : "Voir le sommaire"} ${ICON.chev}</button>
        ${open ? (ed.une?.length ? `<div class="rub">À la une</div>${rows(ed.une)}` : "") + (ed.rubriques || []).map((r) => r.articles?.length ? `<div class="rub">${esc(r.nom)}</div>${rows(r.articles)}` : "").join("") : ""}</div>`;
    });
    if (!items.length) {
      el.innerHTML = html + `<div class="empty"><b>La sélection arrive</b>Les articles de fond du Grand Continent, de Telos, de l'Institut Montaigne, de L'Opinion, de Challenges et d'autres apparaissent au fil de leur publication.</div>`;
      bindPle(el);
      return;
    }
    const unread = items.filter((a) => !isReadP(a));
    const themes = [...new Set(items.map((a) => a.theme).filter(Boolean))];
    const f = S.plFilter || "all";
    html += `<div class="chips" id="plChips">${[["all", "Tout"], ["gratuit", "Gratuits"], ...themes.map((x) => [x, x])].map(([k, l]) =>
      `<button class="chip ${f === k ? "on" : ""}" data-k="${esc(k)}">${esc(l)}</button>`).join("")}</div>`;
    const filt = (l) => l.filter((a) => f === "all" || (f === "gratuit" ? a.acces === "gratuit" : a.theme === f));
    const list = filt(unread).sort((a, b) => (b.note || 0) - (a.note || 0) || t(b.date) - t(a.date));
    const top = list.filter((a) => (a.note || 0) >= 3), rest = list.filter((a) => (a.note || 0) < 3);
    if (top.length) html += `<div class="group-label">Incontournables</div>` + top.map(plCard).join("");
    let lastG = null;
    rest.sort((a, b) => t(b.date) - t(a.date)).forEach((a, i) => {
      const g = dayGroup(t(a.date));
      if (g !== lastG) { html += `<div class="group-label">${esc(g)}</div>`; lastG = g; }
      html += plCard(a, i);
    });
    if (!list.length) html += `<div class="empty"><b>Écran propre</b>Les nouveaux textes apparaîtront ici.</div>`;
    const readList = filt(items.filter(isReadP));
    if (readList.length) {
      html += `<button class="read-toggle ${S.showReadP ? "open" : ""}" id="readToggleP"><span>Déjà lus</span><span class="c">${readList.length}</span>${ICON.chev}</button>`;
      if (S.showReadP) html += `<div class="read-feed">${readList.slice(0, 150).map(plCard).join("")}</div>`;
    }
    el.innerHTML = html;
    bindPle(el);
    $$("#plChips .chip", el).forEach((b) => b.onclick = () => { S.plFilter = b.dataset.k; renderPlusLoin(); });
    $("#readToggleP", el)?.addEventListener("click", () => { S.showReadP = !S.showReadP; const y = window.scrollY; renderPlusLoin(); window.scrollTo(0, y); });
    attachSwipe(el, ".pl", (id) => { setRead("p:" + id, !readMap["p:" + id]); quietRender(); });
    $$("[data-save]", el).forEach((b) => b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const a = items.find((x) => x.id === b.dataset.save);
      if (a) toggleSave({ id: a.id, kind: "analyse", titre: a.titre, sub: `${a.source}`, url: a.url }, () => { const y = window.scrollY; renderPlusLoin(); window.scrollTo(0, y); });
    });
  }
  function bindPle(el) {
    $$("[data-ple]", el).forEach((b) => b.onclick = () => { S.pleOpen = S.pleOpen === b.dataset.ple ? null : b.dataset.ple; const y = window.scrollY; renderPlusLoin(); window.scrollTo(0, y); });
  }

  // ----- Analyses -----
  function anaCard(a, i) {
    const r = isReadA(a), savedOn = saved.some((x) => x.id === a.id);
    return `<div class="swipe ${r ? "is-read" : ""}" style="animation-delay:${Math.min(i, 10) * 35}ms"><div class="swipe-bg"><span>${r ? "Remettre en non lu" : "Lu ✓"}</span></div>
      <a class="ana ${r ? "read" : ""}" href="${esc(a.url)}" target="_blank" rel="noopener" data-id="${esc(a.id)}">
        <div class="top"><span class="src ${srcClass(a.source)}">${srcLetter(a.source)}</span><span class="type">${esc(a.type)}</span><span>· ${esc(whenLabel(a.date))}</span>${!r && t(a.date) > prevVisit ? '<span class="newdot" style="width:7px;height:7px;border-radius:50%;background:var(--accent);display:inline-block"></span>' : ""}</div>
        <div class="ttl">${esc(a.titre)}</div>
        ${a.auteur ? `<div class="aut">${esc(a.auteur)}</div>` : ""}
        ${a.these ? `<div class="th">${esc(a.these)}</div>` : ""}
        <button class="pill ${savedOn ? "on" : ""}" data-save="${esc(a.id)}" style="margin-top:10px;padding:5px 10px;font-size:12.5px">${ICON.save}${savedOn ? "Enregistré" : "Lire plus tard"}</button>
      </a></div>`;
  }
  function renderAnalyses() {
    const el = $("#view-analyses");
    const items = S.analyses?.items || [];
    let html = hero("Analyses", "Tribunes, éditoriaux, chroniques, décryptages");
    if (!items.length) {
      el.innerHTML = html + `<div class="empty"><b>Pas encore d'analyses</b>Elles apparaissent au fil des publications.</div>`;
      return;
    }
    const unread = items.filter((a) => !isReadA(a));
    const freshCount = unread.filter((a) => t(a.date) > prevVisit).length;
    html += `<div class="since"><div class="num">${unread.length}</div><div class="txt">${unread.length
      ? `<b>texte${unread.length > 1 ? "s" : ""} non lu${unread.length > 1 ? "s" : ""}</b>${freshCount ? `, dont <b>${freshCount} nouveau${freshCount > 1 ? "x" : ""}</b> depuis ta dernière visite` : ""}.`
      : `<b>Tout est lu.</b>`}</div></div>`;
    const types = [...new Set(items.map((a) => a.type).filter(Boolean))];
    html += `<div class="chips" id="anaSrc">${[["all", "Tout"], ["Le Monde", "Le Monde"], ["Le Figaro", "Le Figaro"]].map(([k, l]) =>
      `<button class="chip ${S.anaSrc === k ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>`;
    if (types.length > 1) html += `<div class="chips" id="anaType" style="padding-top:0">${[["all", "Tous les genres"], ...types.map((x) => [x, x])].map(([k, l]) =>
      `<button class="chip ${S.anaType === k ? "on" : ""}" data-k="${esc(k)}">${esc(l)}</button>`).join("")}</div>`;
    const filt = (l) => l.filter((a) => (S.anaSrc === "all" || a.source === S.anaSrc) && (S.anaType === "all" || a.type === S.anaType));
    const list = filt(unread);
    if (!list.length) html += `<div class="empty"><b>Écran propre</b>Les nouveaux textes apparaîtront ici.</div>`;
    let lastG = null;
    list.slice(0, 120).forEach((a, i) => {
      const g = dayGroup(t(a.date));
      if (g !== lastG) { html += `<div class="group-label">${esc(g)}</div>`; lastG = g; }
      html += anaCard(a, i);
    });
    const readList = filt(items.filter(isReadA));
    if (readList.length) {
      html += `<button class="read-toggle ${S.showReadA ? "open" : ""}" id="readToggleA"><span>Déjà lus</span><span class="c">${readList.length}</span>${ICON.chev}</button>`;
      if (S.showReadA) html += `<div class="read-feed">${readList.slice(0, 150).map(anaCard).join("")}</div>`;
    }
    el.innerHTML = html;
    $$("#anaSrc .chip", el).forEach((b) => b.onclick = () => { S.anaSrc = b.dataset.k; renderAnalyses(); });
    $$("#anaType .chip", el).forEach((b) => b.onclick = () => { S.anaType = b.dataset.k; renderAnalyses(); });
    $("#readToggleA", el)?.addEventListener("click", () => { S.showReadA = !S.showReadA; const y = window.scrollY; renderAnalyses(); window.scrollTo(0, y); });
    attachSwipe(el, ".ana", (id) => { setRead("a:" + id, !readMap["a:" + id]); quietRender(); });
    $$(".ana", el).forEach((c) => c.addEventListener("click", (ev) => {
      const sb = ev.target.closest("[data-save]");
      if (!sb) return;
      ev.preventDefault(); ev.stopPropagation();
      const a = items.find((x) => x.id === sb.dataset.save);
      toggleSave({ id: a.id, kind: "analyse", titre: a.titre, sub: `${a.type} · ${a.source}`, url: a.url }, renderAnalyses);
    }));
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
    const st = item.kind === "story" ? stories().find((x) => x.id === item.id) : null;
    return `<div class="d-actions">${st ? `<button class="pill" id="dRead">${isRead(st) ? "Remettre en non lu" : "Marquer comme lu"}</button>` : ""}
      <button class="pill ${on ? "on" : ""}" id="dSave">${ICON.save}${on ? "Enregistré" : "Lire plus tard"}</button>
      <button class="pill" id="dShare">${ICON.share}Partager</button></div>`;
  }
  function bindActions(el, item, shareText) {
    const sb = $("#dSave", el);
    sb.onclick = () => toggleSave(item, () => {
      const on = saved.some((x) => x.id === item.id);
      sb.classList.toggle("on", on);
      sb.innerHTML = ICON.save + (on ? "Enregistré" : "Lire plus tard");
    });
    const rb = $("#dRead", el);
    if (rb) rb.onclick = () => {
      const st = stories().find((x) => x.id === item.id);
      if (!st) return;
      const now = !isRead(st);
      setRead(st.id, now);
      render();
      if (now) { closeSheet(); toast("Marqué comme lu"); } else rb.textContent = "Marquer comme lu";
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
      ${actionsBar({ id: s.id, kind: "story" })}
      ${(s.maj || s.maj_relais) ? sec("Du nouveau", para(s.maj || s.maj_relais), true) : ""}
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
    const item = { id: s.id, kind: "story", titre: s.titre, sub: s.categorie, data: s };
    openSheet(storyHTML(s), (el) => {
      bindActions(el, item, s.phrase);
    });
  }

  function openSujet(s, rub) {
    const id = "revue:" + (s.titre || "");
    const item = { id, kind: "sujet", titre: s.titre, sub: "Revue · " + rub, data: { ...s, rub } };
    openSheet(`<div class="d-meta"><span class="cat">${esc(rub)}</span><span>· Revue de presse</span></div>
      <h1 class="d-title">${esc(s.titre)}</h1>
      ${actionsBar(item)}
      ${s.resume ? `<div class="d-lead">${esc(s.resume)}</div>` : ""}
      ${sec("Synthèse", para(s.synthese || ""))}
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
  function toggleSave(item, after) {
    if (saved.some((x) => x.id === item.id)) {
      saved = saved.filter((x) => x.id !== item.id);
      store.set("saved", saved);
      toast("Retiré de « Lire plus tard »");
      after && after();
      return;
    }
    pickCategory((cat) => {
      const story = item.kind === "story" ? stories().find((s) => s.id === item.id) : null;
      saved.unshift({ ...item, titre: item.titre || story?.titre, sub: item.sub || story?.categorie, data: item.data || story, at: Date.now(), cat });
      saved = saved.slice(0, 300);
      store.set("saved", saved);
      toast(`Ajouté à « ${cat} »`);
      after && after();
    });
  }
  function saveCats() { store.set("cats", cats); }
  function pickCategory(done) {
    let el = $("#picker");
    if (!el) { el = document.createElement("div"); el.id = "picker"; document.body.appendChild(el); }
    const draw = () => {
      el.innerHTML = `<div class="pk-back"></div><div class="pk-panel"><div class="pk-title">Lire plus tard dans…</div>
        <div class="pk-cats">${cats.map((c, i) => `<button class="chip" data-i="${i}">${esc(c)}</button>`).join("")}</div>
        <form class="pk-new"><input id="pkInput" class="search-input" placeholder="Nouvelle catégorie" maxlength="30"><button class="pill" type="submit">Créer</button></form>
        <button class="pk-cancel">Annuler</button></div>`;
      $$(".pk-cats .chip", el).forEach((b) => b.onclick = () => { close(); done(cats[b.dataset.i]); });
      $(".pk-new", el).onsubmit = (e) => {
        e.preventDefault();
        const v = $("#pkInput", el).value.trim();
        if (!v) return;
        if (!cats.includes(v)) { cats.push(v); saveCats(); }
        close(); done(v);
      };
      $(".pk-cancel", el).onclick = close;
      $(".pk-back", el).onclick = close;
    };
    const close = () => el.classList.remove("on");
    draw();
    requestAnimationFrame(() => el.classList.add("on"));
  }
  function openSaved() {
    const cur = S.savedCat || "all";
    const counts = {};
    saved.forEach((x) => { const c = x.cat || cats[0]; counts[c] = (counts[c] || 0) + 1; });
    const allCats = [...new Set([...cats, ...Object.keys(counts)])];
    const list = saved.filter((x) => cur === "all" || (x.cat || cats[0]) === cur);
    const rows = list.length ? list.map((x) => `<div class="breve sv" data-id="${esc(x.id)}">
        <div class="bp" style="margin:0 0 3px"><span class="sv-cat">${esc(x.cat || cats[0])}</span> ${esc(x.sub || "")} · ${esc(ago(x.at))}</div>
        <div class="bt">${esc(x.titre)}</div><button class="sv-del" data-del="${esc(x.id)}" aria-label="Retirer">×</button></div>`).join("")
      : `<div class="empty"><b>Rien ici</b>Utilise « Lire plus tard » sur une actualité ou une analyse.</div>`;
    openSheet(`<h1 class="d-title">Lire plus tard</h1>
      <div class="chips" id="svCats" style="margin-top:12px">${[["all", "Tout", saved.length], ...allCats.map((c) => [c, c, counts[c] || 0])].map(([k, l, n]) =>
        `<button class="chip ${cur === k ? "on" : ""}" data-k="${esc(k)}">${esc(l)}<span class="c">${n}</span></button>`).join("")}</div>
      <div class="breves" style="margin-top:6px">${rows}</div>
      <div class="d-sec"><h3><i></i>Catégories</h3>
        <div class="cat-admin">${cats.map((c, i) => `<div class="setting"><span>${esc(c)}</span>${cats.length > 1 ? `<button class="pill" data-rm="${i}">Supprimer</button>` : ""}</div>`).join("")}</div>
        <form class="pk-new" id="svNew"><input id="svInput" class="search-input" placeholder="Nouvelle catégorie" maxlength="30"><button class="pill" type="submit">Créer</button></form>
      </div>`, (el) => {
      $$("#svCats .chip", el).forEach((b) => b.onclick = () => { S.savedCat = b.dataset.k; openSaved(); });
      $$(".sv", el).forEach((b) => b.onclick = (e) => {
        const del = e.target.closest("[data-del]");
        if (del) { saved = saved.filter((x) => x.id !== del.dataset.del); store.set("saved", saved); openSaved(); render(); return; }
        const x = saved.find((y) => y.id === b.dataset.id);
        if (!x) return;
        if (x.kind === "analyse") { window.open(x.url, "_blank", "noopener"); return; }
        if (x.kind === "story") openStory(x.id, stories().find((s) => s.id === x.id) || x.data);
        else if (x.kind === "sujet") openSujet(x.data, x.data.rub || "");
        else if (x.kind === "dossier") openSujet(x.data, "");
      });
      $$("[data-rm]", el).forEach((b) => b.onclick = () => {
        const c = cats[b.dataset.rm];
        cats.splice(+b.dataset.rm, 1); saveCats();
        saved.forEach((x) => { if (x.cat === c) x.cat = cats[0]; }); store.set("saved", saved);
        if (S.savedCat === c) S.savedCat = "all";
        openSaved();
      });
      $("#svNew", el).onsubmit = (e) => {
        e.preventDefault();
        const v = $("#svInput", el).value.trim();
        if (v && !cats.includes(v)) { cats.push(v); saveCats(); }
        openSaved();
      };
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
        $("#markAll", el).onclick = () => {
          stories().forEach((x) => { readMap[x.id] = Date.now(); });
          (S.analyses?.items || []).forEach((a) => { readMap["a:" + a.id] = Date.now(); });
          setRead("_", false);
          prevVisit = Date.now(); store.set("lastSeen", prevVisit); render(); toast("Tout est marqué comme lu");
        };
        $("#lockBtn", el).onclick = () => { store.set("pass", ""); closeSheet(); lastRaw = null; showLock(); };
      });
  }

  // ---------- Navigation ----------
  const VIEWS = ["journal", "direct", "analyses", "plusloin"];
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
    const nd = stories().filter(relevant).filter((s) => !isRead(s) && (s.importance || 0) >= 3 && t(s.last) > prevVisit).length;
    const na = (S.analyses?.items || []).filter((a) => !isReadA(a) && t(a.date) > prevVisit).length;
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
  $("#btnSaved").onclick = () => { S.savedCat = "all"; openSaved(); };
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
  S.view = "journal";
  { const v0 = store.get("view", "journal"); if (VIEWS.includes(v0) && v0 !== "journal") switchView(v0); }
  render();
  load();
  // la visite courante devient la référence à la prochaine ouverture
  setTimeout(() => store.set("lastSeen", Date.now()), 15000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
